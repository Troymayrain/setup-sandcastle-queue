import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

function configuration() {
  return {
    schemaVersion: 1,
    repository: {
      baseBranch: "main",
      integrationBranch: "sandcastle/integration",
    },
    queue: {
      ownershipLabel: "sandcastle",
      readyLabel: "ready-for-agent",
    },
    runner: { runsOn: "ubuntu-latest" },
    commands: {
      bootstrap: [{ argv: ["npm", "ci"] }],
      test: [{ argv: ["npm", "test"] }],
      verification: [{ argv: ["npm", "run", "typecheck"] }],
    },
    models: {
      ticket: "ticket-model",
      finalReview: "review-model",
      finalFix: "fix-model",
    },
    execution: { hostFinalizationReserveMinutes: 15 },
  };
}

test("installed Queue Template tool independently installs, typechecks, and tests", () => {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-template-tool-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
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
  const configPath = join(repository, "queue-config.json");
  writeFileSync(configPath, `${JSON.stringify(configuration(), null, 2)}\n`);
  const initialized = spawnSync(
    process.execPath,
    [cliPath.pathname, "init", "--config", configPath],
    { cwd: repository, encoding: "utf8", input: "yes\n" },
  );
  assert.equal(initialized.status, 0, initialized.stderr);

  const tool = join(repository, ".sandcastle", "tool");
  const workflow = readFileSync(
    join(repository, ".github", "workflows", "sandcastle-queue.yml"),
    "utf8",
  );
  const inputBlock =
    workflow.match(/    inputs:\n([\s\S]*?)\nconcurrency:/u)?.[1] ?? "";
  assert.deepEqual(
    [...inputBlock.matchAll(/^      ([a-z_]+):$/gmu)].map((match) => match[1]),
    ["operation", "expected_head", "predecessor_run_id"],
  );
  assert.match(
    workflow,
    /concurrency:\n  group: sandcastle-queue-\$\{\{ github\.repository \}\}\n  cancel-in-progress: false/u,
  );
  assert.match(workflow, /    timeout-minutes: 360/u);
  assert.match(
    workflow,
    /SANDCASTLE_JOB_HARD_DEADLINE_MS=.*Date\.now\(\) \+ 350 \* 60_000/u,
  );
  assert.doesNotMatch(workflow, /continuation_(?:count|limit)/u);

  const source = readFileSync(join(tool, "src", "work-unit.ts"), "utf8");
  const lock = JSON.parse(readFileSync(join(tool, "package-lock.json"), "utf8"));
  assert.match(source, /from "@ai-hero\/sandcastle"/u);
  assert.doesNotMatch(source, /setup-sandcastle-queue/u);
  assert.equal(
    lock.packages["node_modules/@ai-hero/sandcastle"].version,
    "0.12.0",
  );

  execFileSync("npm", ["ci", "--ignore-scripts"], {
    cwd: tool,
    encoding: "utf8",
    stdio: "pipe",
  });
  execFileSync("npm", ["run", "typecheck"], {
    cwd: tool,
    encoding: "utf8",
    stdio: "pipe",
  });
  execFileSync("npm", ["test"], {
    cwd: tool,
    encoding: "utf8",
    stdio: "pipe",
  });

  const invalidContinuation = spawnSync(
    process.execPath,
    [
      join(tool, "dist", "index.js"),
      "--operation",
      "continue",
      "--repository",
      repository,
    ],
    { cwd: tool, encoding: "utf8" },
  );
  assert.equal(invalidContinuation.status, 4);
  assert.deepEqual(JSON.parse(invalidContinuation.stdout), {
    reason: "invalid-operation-binding",
    status: "conflict",
  });

  const installedConfigPath = join(repository, ".sandcastle", "config.json");
  const invalidConfig = JSON.parse(readFileSync(installedConfigPath, "utf8"));
  invalidConfig.unknownSecret = "never-print-this-secret";
  writeFileSync(installedConfigPath, `${JSON.stringify(invalidConfig)}\n`);
  const invalid = spawnSync(
    process.execPath,
    [join(tool, "dist", "index.js"), "--operation", "start"],
    { cwd: tool, encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /strict schema validation/u);
  assert.equal(invalid.stderr.includes("never-print-this-secret"), false);
});
