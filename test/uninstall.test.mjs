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

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-uninstall-repository-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, ".nvmrc"), "22.22.2\n");
  writeFileSync(join(repository, "README.md"), "# uninstall fixture\n");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        engines: { node: "22.22.2" },
        name: "uninstall-fixture",
        private: true,
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, "package-lock.json"),
    '{"name":"uninstall-fixture","lockfileVersion":3,"packages":{}}\n',
  );
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

function writeConfig() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-uninstall-config-"));
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
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

function runCli(args, repository) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], {
    cwd: repository,
    encoding: "utf8",
  });
}

function install(repository) {
  const planned = runCli(["plan", "--config", writeConfig()], repository);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout).result;
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-uninstall-install-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const installed = runCli(
    ["install", "--plan", planPath, "--confirm", plan.planHash],
    repository,
  );
  assert.equal(installed.status, 0, installed.stderr);
}

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
}

test("uninstall removes only matching control-plane assets and preserves project data", () => {
  const repository = createRepository();
  install(repository);
  const configPath = join(repository, ".sandcastle", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.provider.models.ticket = "project-owned-model";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const projectDocPath = join(repository, "docs", "agents", "sandcastle-queue.md");
  writeFileSync(projectDocPath, "# Project-owned uninstall guidance\n");
  const customAdapterPath = join(
    repository,
    ".sandcastle",
    "custom-adapters",
    "project.json",
  );
  mkdirSync(join(repository, ".sandcastle", "custom-adapters"), {
    recursive: true,
  });
  writeFileSync(customAdapterPath, '{"schemaVersion":1,"projectOwned":true}\n');
  const auditPath = join(repository, ".sandcastle", "audit", "history.json");
  mkdirSync(join(repository, ".sandcastle", "audit"), { recursive: true });
  writeFileSync(auditPath, '{"events":["preserve"]}\n');
  const headBefore = git(repository, ["rev-parse", "HEAD"]);
  const indexBefore = git(repository, ["ls-files", "--stage", "-z"]);

  const previewed = runCli(["uninstall"], repository);

  assert.equal(previewed.status, 0, previewed.stderr);
  const preview = JSON.parse(previewed.stdout).result;
  assert.equal(preview.mode, "preview");
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(preview.plan.removals.map(({ path }) => path), [
    ".agents/skills/sandcastle-runtime/SKILL.md",
    ".github/workflows/sandcastle.yml",
    ".sandcastle/installation.json",
  ]);
  assert.equal(
    preview.plan.preserved.some(
      ({ path, reason }) =>
        path === ".sandcastle/config.json" && reason === "project-owned",
    ),
    true,
  );
  assert.deepEqual(preview.plan.remoteResourcesPreserved, [
    "audit-history",
    "environment",
    "environment-secrets",
    "labels",
  ]);
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-uninstall-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(preview.plan)}\n`);

  const uninstalled = runCli(
    ["uninstall", "--plan", planPath, "--confirm", preview.plan.planHash],
    repository,
  );

  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.deepEqual(JSON.parse(uninstalled.stdout).result.removed, [
    ".agents/skills/sandcastle-runtime/SKILL.md",
    ".github/workflows/sandcastle.yml",
    ".sandcastle/installation.json",
  ]);
  for (const path of [
    ".agents/skills/sandcastle-runtime/SKILL.md",
    ".github/workflows/sandcastle.yml",
    ".sandcastle/installation.json",
  ]) {
    assert.equal(existsSync(join(repository, path)), false);
  }
  for (const path of [
    ".agents/skills/code-review/SKILL.md",
    ".agents/skills/implement/SKILL.md",
    ".agents/skills/tdd/SKILL.md",
    ".sandcastle/THIRD_PARTY_NOTICES.md",
    ".sandcastle/skill-provenance.json",
    "skills-lock.json",
  ]) {
    assert.equal(existsSync(join(repository, path)), true, path);
  }
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).schemaVersion, 1);
  assert.equal(
    readFileSync(projectDocPath, "utf8"),
    "# Project-owned uninstall guidance\n",
  );
  assert.equal(
    readFileSync(customAdapterPath, "utf8"),
    '{"schemaVersion":1,"projectOwned":true}\n',
  );
  assert.equal(readFileSync(auditPath, "utf8"), '{"events":["preserve"]}\n');
  assert.equal(git(repository, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(git(repository, ["ls-files", "--stage", "-z"]), indexBefore);
  assert.equal(git(repository, ["diff", "--cached"]), "");
});

test("uninstall preserves modified managed files with manual guidance", () => {
  const repository = createRepository();
  install(repository);
  const workflowPath = join(
    repository,
    ".github",
    "workflows",
    "sandcastle.yml",
  );
  writeFileSync(
    workflowPath,
    `${readFileSync(workflowPath, "utf8")}# keep local managed change\n`,
  );

  const previewed = runCli(["uninstall"], repository);

  assert.equal(previewed.status, 0, previewed.stderr);
  const preview = JSON.parse(previewed.stdout).result;
  assert.deepEqual(preview.conflicts.map(({ path }) => path), [
    ".github/workflows/sandcastle.yml",
  ]);
  assert.match(preview.conflicts[0].guidance, /review and remove it manually/u);
  assert.equal(
    preview.plan.removals.some(
      ({ path }) => path === ".github/workflows/sandcastle.yml",
    ),
    false,
  );
  assert.equal(
    preview.plan.removals.some(
      ({ path }) => path === ".sandcastle/installation.json",
    ),
    false,
  );
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-conflicted-uninstall-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(preview.plan)}\n`);

  const uninstalled = runCli(
    ["uninstall", "--plan", planPath, "--confirm", preview.plan.planHash],
    repository,
  );

  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.match(readFileSync(workflowPath, "utf8"), /keep local managed change/u);
  assert.equal(
    existsSync(join(repository, ".sandcastle", "installation.json")),
    true,
  );
  assert.equal(
    existsSync(
      join(repository, ".agents", "skills", "sandcastle-runtime", "SKILL.md"),
    ),
    false,
  );
});

test("uninstall rejects a stale plan before deleting any file", () => {
  const repository = createRepository();
  install(repository);
  const previewed = runCli(["uninstall"], repository);
  assert.equal(previewed.status, 0, previewed.stderr);
  const plan = JSON.parse(previewed.stdout).result.plan;
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-stale-uninstall-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const wrapperPath = join(
    repository,
    ".agents",
    "skills",
    "sandcastle-runtime",
    "SKILL.md",
  );
  writeFileSync(
    wrapperPath,
    `${readFileSync(wrapperPath, "utf8")}# changed after preview\n`,
  );

  const uninstalled = runCli(
    ["uninstall", "--plan", planPath, "--confirm", plan.planHash],
    repository,
  );

  assert.equal(uninstalled.status, 2, uninstalled.stderr);
  assert.equal(JSON.parse(uninstalled.stdout).diagnostics[0].code, "PLAN_STALE");
  assert.equal(existsSync(wrapperPath), true);
  assert.equal(
    existsSync(join(repository, ".github", "workflows", "sandcastle.yml")),
    true,
  );
  assert.equal(
    existsSync(join(repository, ".sandcastle", "installation.json")),
    true,
  );
});

test("uninstall restores earlier removals when a later filesystem operation fails", () => {
  const repository = createRepository();
  install(repository);
  const previewed = runCli(["uninstall"], repository);
  assert.equal(previewed.status, 0, previewed.stderr);
  const plan = JSON.parse(previewed.stdout).result.plan;
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-failed-uninstall-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const paths = plan.removals.map(({ path }) => join(repository, path));
  const contentsBefore = paths.map((path) => readFileSync(path));
  const protectedDirectory = join(repository, ".sandcastle");
  chmodSync(protectedDirectory, 0o500);

  let uninstalled;
  try {
    uninstalled = runCli(
      ["uninstall", "--plan", planPath, "--confirm", plan.planHash],
      repository,
    );
  } finally {
    chmodSync(protectedDirectory, 0o700);
  }

  assert.equal(uninstalled.status, 3, uninstalled.stderr);
  assert.equal(
    JSON.parse(uninstalled.stdout).diagnostics[0].code,
    "UNINSTALL_FAILED",
  );
  paths.forEach((path, index) => {
    assert.deepEqual(readFileSync(path), contentsBefore[index]);
  });
});
