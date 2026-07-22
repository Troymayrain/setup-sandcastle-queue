import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const skillWrapperPath = new URL("../scripts/setup.mjs", import.meta.url);

function createClonedRepositories() {
  const source = mkdtempSync(join(tmpdir(), "sandcastle-skill-source-"));
  execFileSync("git", ["init", "--quiet", source]);
  writeFileSync(join(source, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", source, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    source,
    "-c",
    "user.name=Sandcastle Test",
    "-c",
    "user.email=sandcastle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const parent = mkdtempSync(join(tmpdir(), "sandcastle-skill-clones-"));
  const cliRepository = join(parent, "cli");
  const skillRepository = join(parent, "skill");
  execFileSync("git", ["clone", "--quiet", source, cliRepository]);
  execFileSync("git", ["clone", "--quiet", source, skillRepository]);
  return { cliRepository, skillRepository };
}

function writeConfig() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-skill-config-"));
  const path = join(directory, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        queue: {
          ownershipLabel: "sandcastle",
          readyLabel: "ready-for-agent",
        },
        runtime: { adapter: "node-npm", version: "22.22.2" },
        commands: {
          tests: [{ argv: ["npm", "test"] }],
          verification: [],
        },
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
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

function run(entrypoint, args, repository) {
  return spawnSync(process.execPath, [entrypoint.pathname, ...args], {
    cwd: repository,
    encoding: "utf8",
  });
}

test("setup skill delegates plan and install to the exact same core as the npm CLI", () => {
  const { cliRepository, skillRepository } = createClonedRepositories();
  const configPath = writeConfig();
  const cliPlan = run(cliPath, ["plan", "--config", configPath], cliRepository);
  const skillPlan = run(
    skillWrapperPath,
    ["plan", "--config", configPath],
    skillRepository,
  );

  assert.equal(cliPlan.status, 0, cliPlan.stderr);
  assert.equal(skillPlan.status, cliPlan.status, skillPlan.stderr);
  assert.equal(skillPlan.stderr, cliPlan.stderr);
  assert.equal(skillPlan.stdout, cliPlan.stdout);
  const plan = JSON.parse(cliPlan.stdout).result;
  const planDirectory = mkdtempSync(join(tmpdir(), "sandcastle-skill-plans-"));
  const cliPlanPath = join(planDirectory, "cli.json");
  const skillPlanPath = join(planDirectory, "skill.json");
  const serializedPlan = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(cliPlanPath, serializedPlan);
  writeFileSync(skillPlanPath, serializedPlan);

  const cliInstall = run(
    cliPath,
    ["install", "--plan", cliPlanPath, "--confirm", plan.planHash],
    cliRepository,
  );
  const skillInstall = run(
    skillWrapperPath,
    ["install", "--plan", skillPlanPath, "--confirm", plan.planHash],
    skillRepository,
  );
  assert.equal(skillInstall.status, cliInstall.status);
  assert.equal(skillInstall.stdout, cliInstall.stdout);
  assert.equal(skillInstall.stderr, cliInstall.stderr);

  for (const path of [
    ".github/workflows/sandcastle.yml",
    ".sandcastle/config.json",
    ".sandcastle/installation.json",
  ]) {
    assert.equal(
      readFileSync(join(skillRepository, path), "utf8"),
      readFileSync(join(cliRepository, path), "utf8"),
    );
  }
});

test("setup skill preserves configuration error output and exit status", () => {
  const { cliRepository, skillRepository } = createClonedRepositories();
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-skill-invalid-"));
  const configPath = join(directory, "invalid.json");
  writeFileSync(configPath, '{"token":"must-not-be-printed"}\n');

  const cliResult = run(
    cliPath,
    ["validate-config", "--config", configPath],
    cliRepository,
  );
  const skillResult = run(
    skillWrapperPath,
    ["validate-config", "--config", configPath],
    skillRepository,
  );

  assert.equal(cliResult.status, 2);
  assert.equal(skillResult.status, cliResult.status);
  assert.equal(skillResult.stdout, cliResult.stdout);
  assert.equal(skillResult.stderr, cliResult.stderr);
  assert.equal(skillResult.stdout.includes("must-not-be-printed"), false);
});
