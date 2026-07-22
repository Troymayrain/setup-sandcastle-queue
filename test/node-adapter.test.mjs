import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function createNodeRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-node-adapter-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, ".nvmrc"), "22.22.2\n");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        name: "node-adapter-fixture",
        private: true,
        engines: { node: "22.22.2" },
        scripts: {
          lint: "eslint .",
          test: "node --test",
          typecheck: "tsc --noEmit",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "node-adapter-fixture",
        lockfileVersion: 3,
        packages: {
          "": { name: "node-adapter-fixture" },
        },
        requires: true,
      },
      null,
      2,
    )}\n`,
  );
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
  return repository;
}

function config() {
  return {
    audit: { retentionDays: 30 },
    commands: {
      tests: [{ argv: ["npm", "test"] }],
      verification: [
        { argv: ["npm", "run", "typecheck"] },
        { argv: ["npm", "run", "lint"] },
      ],
    },
    execution: {
      jobTimeoutMinutes: 350,
      maxTicketsPerRun: 3,
      minimumRemainingMinutes: 140,
      processingBudgetMinutes: 300,
      ticketTimeoutMinutes: 120,
    },
    provider: {
      kind: "anthropic-compatible",
      models: { ticket: "ticket-model" },
    },
    queue: { ownershipLabel: "sandcastle", readyLabel: "ready-for-agent" },
    runtime: { adapter: "node-npm", version: "22.22.2" },
    schemaVersion: 1,
  };
}

test("node-npm proposes npm ci and gates continuation on the exact lock environment", async () => {
  const { executeRuntimeAdapter, proposeRuntime } = await import(
    "../dist/index.js"
  );
  const repository = createNodeRepository();
  const proposal = await proposeRuntime(repository);

  assert.deepEqual(proposal.runtime, {
    adapter: "node-npm",
    confirmed: false,
    signals: [".nvmrc", "package.json#engines.node"],
    version: "22.22.2",
  });
  assert.deepEqual(proposal.adapterPlan.bootstrap, [{ argv: ["npm", "ci"] }]);
  assert.deepEqual(proposal.adapterPlan.networkHosts, ["registry.npmjs.org"]);
  assert.deepEqual(
    proposal.adapterPlan.environment.inputs.map(({ path, sha256 }) => ({
      path,
      validHash: /^[a-f0-9]{64}$/u.test(sha256),
    })),
    [
      { path: "package-lock.json", validHash: true },
      { path: "package.json", validHash: true },
    ],
  );
  assert.deepEqual(proposal.commands, config().commands);

  const calls = [];
  const runtime = {
    async run(command, phase) {
      calls.push({ command, phase });
      return { exitCode: 0, stdout: "" };
    },
  };
  const bootstrapped = await executeRuntimeAdapter(
    proposal,
    { mode: "bootstrap" },
    runtime,
  );
  assert.equal(bootstrapped.status, "completed");
  assert.deepEqual(calls.map(({ phase }) => phase), [
    "bootstrap",
    "tests",
    "verification",
    "verification",
  ]);

  const lockPath = join(repository, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/example"] = { version: "1.0.0" };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const changed = await proposeRuntime(repository);
  calls.length = 0;
  const drifted = await executeRuntimeAdapter(
    changed,
    {
      expectedEnvironmentHash: bootstrapped.environmentHash,
      mode: "continuation",
    },
    runtime,
  );
  assert.equal(drifted.status, "environment-drift");
  assert.deepEqual(calls, []);
});

test("node-npm rejects missing and unsupported package locks", async () => {
  const { ConfigurationError, proposeRuntime } = await import("../dist/index.js");
  const missing = createNodeRepository();
  rmSync(join(missing, "package-lock.json"));
  await assert.rejects(proposeRuntime(missing), (error) => {
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.diagnostics[0]?.code, "NPM_LOCK_REQUIRED");
    return true;
  });

  const unsupported = createNodeRepository();
  writeFileSync(
    join(unsupported, "package-lock.json"),
    '{"name":"node-adapter-fixture","lockfileVersion":1,"dependencies":{}}\n',
  );
  await assert.rejects(proposeRuntime(unsupported), (error) => {
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.diagnostics[0]?.code, "NPM_LOCK_INVALID");
    return true;
  });
});

test("installer planning never adds the control plane to the application manifest", async () => {
  const { createInstallPlan } = await import("../dist/index.js");
  const repository = createNodeRepository();
  const packagePath = join(repository, "package.json");
  const lockPath = join(repository, "package-lock.json");
  const before = {
    lock: readFileSync(lockPath, "utf8"),
    package: readFileSync(packagePath, "utf8"),
  };

  const plan = await createInstallPlan(repository, config());
  assert.equal(
    plan.assets.some(({ path }) =>
      ["package.json", "package-lock.json"].includes(path),
    ),
    false,
  );
  assert.deepEqual(
    {
      lock: readFileSync(lockPath, "utf8"),
      package: readFileSync(packagePath, "utf8"),
    },
    before,
  );
});
