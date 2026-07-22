import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function config() {
  return {
    audit: { retentionDays: 30 },
    commands: { tests: [{ argv: ["npm", "test"] }], verification: [] },
    execution: {
      jobTimeoutMinutes: 350,
      maxTicketsPerRun: 3,
      minimumRemainingMinutes: 140,
      processingBudgetMinutes: 300,
      ticketTimeoutMinutes: 120,
    },
    provider: {
      kind: "anthropic-compatible",
      models: { fast: "fast-model", ticket: "ticket-model" },
    },
    queue: { ownershipLabel: "sandcastle", readyLabel: "ready-for-agent" },
    runtime: { adapter: "node-npm", version: "22.22.2" },
    schemaVersion: 1,
  };
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-remote-doctor-"));
  mkdirSync(join(repository, ".github", "workflows"), { recursive: true });
  mkdirSync(join(repository, ".sandcastle"), { recursive: true });
  const configPath = join(repository, ".sandcastle", "config.json");
  writeFileSync(configPath, `${JSON.stringify(config())}\n`);
  writeFileSync(
    join(repository, ".github", "workflows", "sandcastle.yml"),
    "name: Sandcastle Queue\non:\n  workflow_dispatch:\npermissions: {}\n",
  );
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return { configPath, repository };
}

function receipt(receiptId) {
  return { ok: true, receiptId };
}

test("remote doctor artifact identity invalidates on every bound input", async () => {
  const { createRemoteDoctorBinding, remoteDoctorArtifactName } = await import(
    "../dist/index.js"
  );
  const original = createRemoteDoctorBinding(config(), "workflow-v1", "0.1.0");
  const changedConfig = config();
  changedConfig.audit.retentionDays = 31;
  const names = [
    remoteDoctorArtifactName(original),
    remoteDoctorArtifactName(
      createRemoteDoctorBinding(changedConfig, "workflow-v1", "0.1.0"),
    ),
    remoteDoctorArtifactName(
      createRemoteDoctorBinding(config(), "workflow-v2", "0.1.0"),
    ),
    remoteDoctorArtifactName(
      createRemoteDoctorBinding(config(), "workflow-v1", "0.1.1"),
    ),
  ];

  assert.equal(new Set(names).size, names.length);
  assert.equal(
    names.every((name) => /^sandcastle-remote-doctor-[a-f0-9]{16}$/u.test(name)),
    true,
  );
});

test("remote doctor runs real-boundary probes with the fast model and uploads a bound sanitized result", async () => {
  const { runRemoteDoctor } = await import("../dist/index.js");
  const { configPath, repository } = createRepository();
  const probes = [];
  const uploads = [];
  const secret = "provider-secret-must-not-be-retained";
  const result = await runRemoteDoctor(
    repository,
    configPath,
    {
      async probeBroker(input) {
        probes.push({ kind: "broker", input });
        return receipt("broker-receipt");
      },
      async probeCredential(input) {
        probes.push({ kind: "credential", input });
        return receipt("credential-receipt");
      },
      async probeNetworkPolicy(input) {
        probes.push({ kind: "network-policy", input });
        return receipt("network-receipt");
      },
      async probeSandbox(input) {
        probes.push({ kind: "sandbox", input });
        return receipt("sandbox-receipt");
      },
      async readJobPermissions() {
        return {
          actions: "write",
          contents: "read",
          issues: "none",
          pullRequests: "none",
        };
      },
      async uploadArtifact(request) {
        uploads.push({
          ...request,
          report: JSON.parse(readFileSync(request.path, "utf8")),
        });
        return { artifactId: "remote-doctor-artifact-1" };
      },
    },
    {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: secret,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_JOB: "remote-doctor",
      GITHUB_RUN_ID: "9300",
      SANDCASTLE_OPERATION: "remote-doctor",
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.binding.installationVersion, "1.0.0");
  assert.match(result.binding.configurationHash, /^[a-f0-9]{64}$/u);
  assert.match(result.binding.workflowSha, /^[a-f0-9]{64}$/u);
  assert.deepEqual(probes.map(({ kind }) => kind).sort(), [
    "broker",
    "credential",
    "network-policy",
    "sandbox",
  ]);
  assert.equal(probes.every(({ input }) => input.model === "fast-model"), true);
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].name, /^sandcastle-remote-doctor-[a-f0-9]{16}$/u);
  assert.equal(uploads[0].retentionDays, 30);
  assert.equal(uploads[0].report.ok, true);
  assert.deepEqual(uploads[0].report.binding, result.binding);
  assert.equal(JSON.stringify({ result, uploads }).includes(secret), false);
  assert.equal(
    execFileSync("git", ["-C", repository, "status", "--porcelain"], {
      encoding: "utf8",
    }),
    "",
  );
});

test("remote doctor separates probe failures and never retains thrown secret text", async () => {
  const { runRemoteDoctor } = await import("../dist/index.js");
  const { configPath, repository } = createRepository();
  const secret = "upstream-secret-error-body";
  const uploads = [];
  const failed = () => {
    throw new Error(secret);
  };
  const result = await runRemoteDoctor(
    repository,
    configPath,
    {
      probeBroker: failed,
      probeCredential: failed,
      probeNetworkPolicy: failed,
      probeSandbox: failed,
      async readJobPermissions() {
        return {
          actions: "write",
          contents: "write",
          issues: "write",
          pullRequests: "write",
        };
      },
      async uploadArtifact(request) {
        uploads.push(JSON.parse(readFileSync(request.path, "utf8")));
        return { artifactId: "failed-probes-artifact" };
      },
    },
    {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_JOB: "remote-doctor",
      GITHUB_RUN_ID: "9301",
      SANDCASTLE_OPERATION: "remote-doctor",
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.checks
      .filter(({ status }) => status === "fail")
      .map(({ id }) => id),
    ["credential", "broker", "sandbox", "network-policy", "permissions"],
  );
  assert.match(result.artifactName, /^sandcastle-remote-doctor-failed-/u);
  assert.equal(JSON.stringify({ result, uploads }).includes(secret), false);
});

test("remote doctor reports artifact upload failure independently", async () => {
  const { runRemoteDoctor } = await import("../dist/index.js");
  const { configPath, repository } = createRepository();
  const result = await runRemoteDoctor(
    repository,
    configPath,
    {
      probeBroker: async () => receipt("broker-receipt"),
      probeCredential: async () => receipt("credential-receipt"),
      probeNetworkPolicy: async () => receipt("network-receipt"),
      probeSandbox: async () => receipt("sandbox-receipt"),
      async readJobPermissions() {
        return {
          actions: "write",
          contents: "read",
          issues: "none",
          pullRequests: "none",
        };
      },
      async uploadArtifact() {
        throw new Error("artifact-token-must-not-be-retained");
      },
    },
    {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_JOB: "remote-doctor",
      GITHUB_RUN_ID: "9302",
      SANDCASTLE_OPERATION: "remote-doctor",
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.artifactId, null);
  assert.deepEqual(
    result.diagnostics.map(({ check, code }) => ({ check, code })),
    [{ check: "artifact", code: "REMOTE_DOCTOR_ARTIFACT_FAILED" }],
  );
  assert.equal(JSON.stringify(result).includes("artifact-token-must-not-be-retained"), false);
});

test("remote doctor translates an unavailable managed workflow into a stable diagnostic", async () => {
  const { InfrastructureError, runRemoteDoctor } = await import(
    "../dist/index.js"
  );
  const { configPath, repository } = createRepository();
  rmSync(join(repository, ".github", "workflows", "sandcastle.yml"));
  const runtime = new Proxy(
    {},
    {
      get() {
        throw new Error("runtime-secret-must-not-be-retained");
      },
    },
  );

  await assert.rejects(
    runRemoteDoctor(repository, configPath, runtime, {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_JOB: "remote-doctor",
      GITHUB_RUN_ID: "9303",
      SANDCASTLE_OPERATION: "remote-doctor",
    }),
    (error) => {
      assert.equal(error instanceof InfrastructureError, true);
      assert.deepEqual(error.diagnostics, [
        {
          code: "REMOTE_DOCTOR_WORKFLOW_UNAVAILABLE",
          message: "Unable to read the managed remote doctor workflow.",
        },
      ]);
      assert.equal(JSON.stringify(error).includes(repository), false);
      assert.equal(
        JSON.stringify(error).includes("runtime-secret-must-not-be-retained"),
        false,
      );
      return true;
    },
  );
});
