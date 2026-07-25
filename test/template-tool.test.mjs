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
});
