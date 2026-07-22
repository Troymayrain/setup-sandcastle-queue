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

function createGoRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-go-adapter-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(
    join(repository, "go.mod"),
    `module example.com/fixture

go 1.23.4

toolchain go1.23.4

require example.com/dependency v1.2.3
`,
  );
  writeFileSync(
    join(repository, "go.sum"),
    `example.com/dependency v1.2.3 h1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
example.com/dependency v1.2.3/go.mod h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
`,
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
      tests: [{ argv: ["go", "test", "./..."] }],
      verification: [{ argv: ["go", "vet", "./..."] }],
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
    runtime: { adapter: "go-module", version: "1.23.4" },
    schemaVersion: 1,
  };
}

test("go-module verifies checksums and gates continuation on module identity", async () => {
  const { executeRuntimeAdapter, proposeRuntime } = await import(
    "../dist/index.js"
  );
  const repository = createGoRepository();
  const proposal = await proposeRuntime(repository);

  assert.deepEqual(proposal.runtime, {
    adapter: "go-module",
    confirmed: false,
    signals: ["go.mod#go", "go.mod#toolchain"],
    version: "1.23.4",
  });
  assert.deepEqual(proposal.adapterPlan.bootstrap, [
    { argv: ["go", "mod", "download"] },
    { argv: ["go", "mod", "verify"] },
  ]);
  assert.deepEqual(proposal.adapterPlan.networkHosts, [
    "proxy.golang.org",
    "storage.googleapis.com",
    "sum.golang.org",
  ]);
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
    "bootstrap",
    "tests",
    "verification",
  ]);

  writeFileSync(
    join(repository, "go.sum"),
    `example.com/dependency v1.2.3 h1:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=
example.com/dependency v1.2.3/go.mod h1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=
`,
  );
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

test("go-module rejects missing and malformed checksum evidence", async () => {
  const { ConfigurationError, proposeRuntime } = await import("../dist/index.js");
  const missing = createGoRepository();
  rmSync(join(missing, "go.sum"));
  await assert.rejects(proposeRuntime(missing), (error) => {
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.diagnostics[0]?.code, "GO_SUM_REQUIRED");
    return true;
  });

  const malformed = createGoRepository();
  writeFileSync(
    join(malformed, "go.sum"),
    "example.com/dependency v1.2.3 unverified-checksum\n",
  );
  await assert.rejects(proposeRuntime(malformed), (error) => {
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.diagnostics[0]?.code, "GO_SUM_INVALID");
    return true;
  });
});

test("ordinary installer upgrade preserves the application Go runtime files", async () => {
  const {
    applyInstallPlan,
    createInstallPlan,
    createUpgradePreview,
  } = await import("../dist/index.js");
  const repository = createGoRepository();
  const goModPath = join(repository, "go.mod");
  const goSumPath = join(repository, "go.sum");
  const before = {
    mod: readFileSync(goModPath, "utf8"),
    sum: readFileSync(goSumPath, "utf8"),
  };
  const install = await createInstallPlan(repository, config());
  await applyInstallPlan(repository, install, install.planHash);

  const upgrade = await createUpgradePreview(repository, "0.1.0");
  assert.equal(
    upgrade.plan.assets.some(({ path }) => ["go.mod", "go.sum"].includes(path)),
    false,
  );
  assert.deepEqual(
    {
      mod: readFileSync(goModPath, "utf8"),
      sum: readFileSync(goSumPath, "utf8"),
    },
    before,
  );
});
