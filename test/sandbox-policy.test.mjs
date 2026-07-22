import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const image = `ghcr.io/acme/sandcastle-control@sha256:${"b".repeat(64)}`;

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-sandbox-repository-"));
  execFileSync("git", ["init", "--quiet", repository]);
  mkdirSync(join(repository, "src"));
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  writeFileSync(join(repository, "src", "app.js"), "export const value = 1;\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Sandcastle Test",
    "-c",
    "user.email=sandcastle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return repository;
}

function config(networkHosts = ["packages.example.com"]) {
  return {
    schemaVersion: 1,
    queue: {
      ownershipLabel: "sandcastle",
      readyLabel: "ready-for-agent",
    },
    runtime: {
      adapter: "node-npm",
      networkHosts,
      version: "22.22.2",
    },
    commands: { tests: [{ argv: ["npm", "test"] }], verification: [] },
    provider: {
      kind: "anthropic-compatible",
      models: { ticket: "ticket-model" },
    },
    execution: {
      jobTimeoutMinutes: 350,
      maxTicketsPerRun: 3,
      minimumRemainingMinutes: 140,
      processingBudgetMinutes: 300,
      ticketTimeoutMinutes: 120,
    },
    audit: { retentionDays: 30 },
  };
}

function writeConfig(value = config()) {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-sandbox-config-"));
  const path = join(directory, "config.json");
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

function createFakeDocker({ failNetwork = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-fake-docker-"));
  const logPath = join(directory, "calls.jsonl");
  const executable = join(directory, "docker");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, env: process.env }) + "\\n");
if (${JSON.stringify(failNetwork)} && argv[0] === "network" && argv[1] === "create") {
  process.exit(44);
}
if (argv[0] === "run" && argv.includes("--detach")) {
  process.stdout.write("fake-proxy-container\\n");
}
`,
  );
  chmodSync(executable, 0o755);
  return {
    executable,
    calls() {
      if (!existsSync(logPath)) {
        return [];
      }
      const source = readFileSync(logPath, "utf8");
      return source
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

function sandboxEnvironment(fakeDocker) {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: "https://api.example.com",
    ANTHROPIC_AUTH_TOKEN: "real-provider-token-must-not-enter-sandbox",
    GITHUB_TOKEN: "github-token-must-not-enter-sandbox",
    SANDCASTLE_BATCH_ID: "p1-aaaaaaaaaaaa-r9001",
    SANDCASTLE_BROKER_BASE_URL:
      "http://sandcastle-broker:8081/batches/p1-aaaaaaaaaaaa-r9001/scopes/ticket%3A2",
    SANDCASTLE_DOCKER_BIN: fakeDocker.executable,
    SANDCASTLE_SCOPE: "ticket:2",
    SANDCASTLE_SESSION_TOKEN: "short-lived-session-token",
  };
}

function sandboxArgs(command, stage, configPath) {
  return [
    "--config",
    configPath,
    "--stage",
    stage,
    "--image",
    image,
    "--session-id",
    "session-123",
    "--argv-json",
    JSON.stringify(command),
  ];
}

test("sandbox stages use an internal network, exact egress hosts, and session-only credentials", () => {
  const repository = createRepository();
  const configPath = writeConfig();
  const fakeDocker = createFakeDocker();
  const environment = sandboxEnvironment(fakeDocker);

  for (const [stage, command] of [
    ["bootstrap", ["npm", "ci"]],
    ["agent", ["codex", "exec"]],
  ]) {
    const args = sandboxArgs(command, stage, configPath);
    const previewed = spawnSync(
      process.execPath,
      [cliPath.pathname, "sandbox-plan", ...args],
      { cwd: repository, encoding: "utf8", env: environment },
    );
    assert.equal(previewed.status, 0, previewed.stderr);
    for (const secret of [
      environment.ANTHROPIC_AUTH_TOKEN,
      environment.GITHUB_TOKEN,
      environment.SANDCASTLE_SESSION_TOKEN,
    ]) {
      assert.equal(previewed.stdout.includes(secret), false);
    }
    const preview = JSON.parse(previewed.stdout).result;
    assert.equal(preview.mode, "preview");
    assert.equal(preview.stage, stage);
    assert.equal(preview.network.internal, true);
    assert.deepEqual(preview.network.allowedHosts, [
      "packages.example.com",
      "registry.npmjs.org",
    ]);
    assert.match(preview.planHash, /^[a-f0-9]{64}$/u);

    const executed = spawnSync(
      process.execPath,
      [
        cliPath.pathname,
        "sandbox-run",
        ...args,
        "--confirm",
        preview.planHash,
      ],
      { cwd: repository, encoding: "utf8", env: environment },
    );
    assert.equal(executed.status, 0, executed.stderr);
    assert.deepEqual(JSON.parse(executed.stdout).result, {
      exitCode: 0,
      mode: "executed",
      planHash: preview.planHash,
      stage,
    });
  }

  const calls = fakeDocker.calls();
  const networkCreates = calls.filter(
    ({ argv }) => argv[0] === "network" && argv[1] === "create",
  );
  assert.equal(networkCreates.length, 2);
  assert.equal(networkCreates.every(({ argv }) => argv.includes("--internal")), true);
  const proxyRuns = calls.filter(
    ({ argv }) => argv[0] === "run" && argv.includes("egress-proxy"),
  );
  assert.equal(proxyRuns.length, 2);
  const stageRuns = calls.filter(
    ({ argv }) =>
      argv[0] === "run" &&
      !argv.includes("egress-proxy") &&
      (argv.includes("npm") || argv.includes("codex")),
  );
  assert.equal(stageRuns.length, 2);
  for (const { argv, env } of [...proxyRuns, ...stageRuns]) {
    assert.equal(argv.includes("host"), false);
    assert.equal(argv.some((argument) => argument.includes("docker.sock")), false);
    assert.equal(argv.includes("--cap-drop"), true);
    assert.equal(argv.includes("ALL"), true);
    assert.equal(argv.includes("--security-opt"), true);
    assert.equal(argv.includes("no-new-privileges"), true);
    assert.equal(JSON.stringify(argv).includes(environment.ANTHROPIC_AUTH_TOKEN), false);
    assert.equal(JSON.stringify(argv).includes(environment.GITHUB_TOKEN), false);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.SANDCASTLE_SESSION_TOKEN, undefined);
  }
  for (const { argv } of stageRuns) {
    assert.equal(argv.includes("--entrypoint"), true);
    assert.equal(
      argv.some(
        (argument) =>
          argument.startsWith("type=bind,") &&
          argument.includes("dst=/workspace/.git") &&
          argument.endsWith(",readonly"),
      ),
      true,
      "sandbox must overlay host Git metadata read-only",
    );
  }
  for (const { env } of stageRuns) {
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, environment.SANDCASTLE_SESSION_TOKEN);
    assert.equal(env.ANTHROPIC_BASE_URL, environment.SANDCASTLE_BROKER_BASE_URL);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN === environment.ANTHROPIC_AUTH_TOKEN, false);
  }
  const agentFacingCalls = calls.filter(
    ({ argv }) => !argv.includes("credential-broker"),
  );
  assert.equal(
    JSON.stringify(agentFacingCalls).includes(environment.ANTHROPIC_AUTH_TOKEN),
    false,
  );
  assert.equal(JSON.stringify(calls).includes(environment.GITHUB_TOKEN), false);
});

test("egress address policy rejects private, loopback, link-local, and mapped addresses", async () => {
  const { isPublicNetworkAddress } = await import("../dist/index.js");

  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::127.0.0.1",
    "100::1",
    "2002:7f00:1::",
    "fc00::1",
    "fec0::1",
    "fe80::1",
  ]) {
    assert.equal(isPublicNetworkAddress(address), false, address);
  }
  assert.equal(isPublicNetworkAddress("8.8.8.8"), true);
  assert.equal(isPublicNetworkAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicNetworkAddress("not-an-address"), false);
});

test("sandbox policy rejects unsafe hosts and caller-controlled Docker escape hatches", () => {
  const repository = createRepository();
  const fakeDocker = createFakeDocker();
  const environment = sandboxEnvironment(fakeDocker);
  for (const unsafeHost of [
    "*.example.com",
    "10.0.0.0/8",
    "127.0.0.1",
    "https://packages.example.com",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        cliPath.pathname,
        "sandbox-plan",
        ...sandboxArgs(["npm", "ci"], "bootstrap", writeConfig(config([unsafeHost]))),
      ],
      { cwd: repository, encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].code, "SANDBOX_HOST_INVALID");
  }

  const configPath = writeConfig();
  for (const override of [
    ["--network", "host"],
    ["--mount", "/var/run/docker.sock:/var/run/docker.sock"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        cliPath.pathname,
        "sandbox-plan",
        ...sandboxArgs(["npm", "ci"], "bootstrap", configPath),
        ...override,
      ],
      { cwd: repository, encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).diagnostics[0].code,
      "SANDBOX_OVERRIDE_FORBIDDEN",
    );
  }
  assert.deepEqual(fakeDocker.calls(), []);
});

test("sandbox setup failure never falls back to an unrestricted container", () => {
  const repository = createRepository();
  const fakeDocker = createFakeDocker({ failNetwork: true });
  const environment = sandboxEnvironment(fakeDocker);
  const args = sandboxArgs(["npm", "ci"], "bootstrap", writeConfig());
  const previewed = spawnSync(
    process.execPath,
    [cliPath.pathname, "sandbox-plan", ...args],
    { cwd: repository, encoding: "utf8", env: environment },
  );
  assert.equal(previewed.status, 0, previewed.stderr);
  const result = spawnSync(
    process.execPath,
    [
      cliPath.pathname,
      "sandbox-run",
      ...args,
      "--confirm",
      JSON.parse(previewed.stdout).result.planHash,
    ],
    { cwd: repository, encoding: "utf8", env: environment },
  );

  assert.equal(result.status, 3, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).diagnostics[0].code,
    "SANDBOX_NETWORK_CREATE_FAILED",
  );
  assert.deepEqual(
    fakeDocker.calls().map(({ argv }) => argv.slice(0, 2)),
    [["network", "create"]],
  );
});

test("protected-path gate rejects tracked and untracked control-plane changes", () => {
  const repository = createRepository();
  mkdirSync(join(repository, ".sandcastle"));
  mkdirSync(join(repository, ".github", "workflows"), { recursive: true });
  mkdirSync(join(repository, ".agents", "skills", "implement"), {
    recursive: true,
  });
  writeFileSync(join(repository, ".sandcastle", "config.json"), "{}\n");
  writeFileSync(
    join(repository, ".github", "workflows", "sandcastle.yml"),
    "name: Sandcastle\n",
  );
  writeFileSync(
    join(repository, ".agents", "skills", "implement", "SKILL.md"),
    "# Implement\n",
  );
  writeFileSync(join(repository, "skills-lock.json"), "{}\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Sandcastle Test",
    "-c",
    "user.email=sandcastle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "control plane",
  ]);
  const before = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  writeFileSync(join(repository, "src", "app.js"), "export const value = 2;\n");
  const allowed = spawnSync(
    process.execPath,
    [cliPath.pathname, "check-protected", "--before", before],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(JSON.parse(allowed.stdout).result, {
    changedPaths: ["src/app.js"],
    protectedPaths: [],
  });

  writeFileSync(join(repository, ".sandcastle", "config.json"), '{"changed":true}\n');
  mkdirSync(join(repository, ".agents", "skills", "tdd"), { recursive: true });
  writeFileSync(
    join(repository, ".agents", "skills", "tdd", "injected.md"),
    "unsafe\n",
  );
  const rejected = spawnSync(
    process.execPath,
    [cliPath.pathname, "check-protected", "--before", before],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(rejected.status, 2, rejected.stderr);
  assert.deepEqual(
    JSON.parse(rejected.stdout).diagnostics.map(({ code, path }) => ({ code, path })),
    [
      {
        code: "PROTECTED_PATH_MODIFIED",
        path: ".agents/skills/tdd/injected.md",
      },
      {
        code: "PROTECTED_PATH_MODIFIED",
        path: ".sandcastle/config.json",
      },
    ],
  );
  assert.equal(
    readFileSync(join(repository, ".sandcastle", "config.json"), "utf8"),
    '{"changed":true}\n',
  );
});

test("protected-path gate does not execute repository-local Git helpers", () => {
  const repository = createRepository();
  const before = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const hookDirectory = mkdtempSync(join(tmpdir(), "sandcastle-git-helper-"));
  const marker = join(hookDirectory, "executed");
  const fsmonitor = join(hookDirectory, "fsmonitor");
  writeFileSync(
    fsmonitor,
    `#!/bin/sh\n: > ${JSON.stringify(marker)}\nprintf '{}\\n'\n`,
  );
  chmodSync(fsmonitor, 0o755);
  execFileSync("git", ["-C", repository, "config", "core.fsmonitor", fsmonitor]);

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "check-protected", "--before", before],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), false);
});
