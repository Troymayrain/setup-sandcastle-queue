import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-upgrade-repository-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, ".nvmrc"), "22.22.2\n");
  writeFileSync(join(repository, "README.md"), "# upgrade fixture\n");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        engines: { node: "22.22.2" },
        name: "upgrade-fixture",
        private: true,
        scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, "package-lock.json"),
    '{"name":"upgrade-fixture","lockfileVersion":3,"packages":{}}\n',
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
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-upgrade-config-"));
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
          verification: [{ argv: ["npm", "run", "typecheck"] }],
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

function runCli(args, repository, environment = process.env) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], {
    cwd: repository,
    encoding: "utf8",
    env: environment,
  });
}

function install(repository) {
  const planned = runCli(["plan", "--config", writeConfig()], repository);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout).result;
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-upgrade-install-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const installed = runCli(
    ["install", "--plan", planPath, "--confirm", plan.planHash],
    repository,
  );
  assert.equal(installed.status, 0, installed.stderr);
}

function treeHash(repository) {
  const hash = createHash("sha256");
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === repository && name === ".git") {
        continue;
      }
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        hash.update(relative(repository, path));
        hash.update(readFileSync(path));
      }
    }
  };
  visit(repository);
  return hash.digest("hex");
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function directoryHash(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        files.push(path);
      }
    }
  };
  visit(root);
  const hash = createHash("sha256");
  for (const path of files.sort((left, right) =>
    relative(root, left).localeCompare(relative(root, right)),
  )) {
    hash.update(relative(root, path).split("\\").join("/"));
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

test("upgrade previews managed drift as a blocking conflict without overwriting it", () => {
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
    `${readFileSync(workflowPath, "utf8")}# local managed patch\n`,
  );
  const before = treeHash(repository);

  const result = runCli(["upgrade", "--target", "1.0.0"], repository);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.command, "upgrade");
  assert.equal(output.ok, true);
  assert.equal(output.result.mode, "preview");
  assert.equal(output.result.plan.upgrade.targetRelease, "1.0.0");
  assert.deepEqual(
    output.result.conflicts.map(({ path }) => path),
    [".github/workflows/sandcastle.yml"],
  );
  assert.match(output.result.plan.patch, /-# local managed patch/u);
  assert.equal(treeHash(repository), before);

  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-conflicted-upgrade-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(output.result.plan)}\n`);
  const applied = runCli(
    [
      "upgrade",
      "--plan",
      planPath,
      "--confirm",
      output.result.plan.planHash,
    ],
    repository,
  );
  assert.equal(applied.status, 2, applied.stderr);
  assert.equal(
    JSON.parse(applied.stdout).diagnostics[0].code,
    "UPGRADE_CONFLICT",
  );
  assert.equal(treeHash(repository), before);
});

test("upgrade atomically applies a clean exact release and preserves project-owned files", () => {
  const repository = createRepository();
  install(repository);
  const manifestPath = join(repository, ".sandcastle", "installation.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const workflowPath = join(
    repository,
    ".github",
    "workflows",
    "sandcastle.yml",
  );
  writeFileSync(
    workflowPath,
    "name: Sandcastle Queue 0.0.9\non:\n  workflow_dispatch:\npermissions: {}\n",
  );
  manifest.managedAssets[".github/workflows/sandcastle.yml"].sha256 =
    fileHash(workflowPath);

  const codeReviewRoot = join(
    repository,
    ".agents",
    "skills",
    "code-review",
  );
  const codeReviewPath = join(codeReviewRoot, "SKILL.md");
  writeFileSync(
    codeReviewPath,
    `${readFileSync(codeReviewPath, "utf8")}\nLegacy upstream 0.0.9 behavior.\n`,
  );
  manifest.managedAssets[".agents/skills/code-review/SKILL.md"].sha256 =
    fileHash(codeReviewPath);

  const lockPath = join(repository, "skills-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.skills["code-review"].computedHash = directoryHash(codeReviewRoot);
  lock.skills["code-review"].ref = "0".repeat(40);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  manifest.managedAssets["skills-lock.json"].sha256 = fileHash(lockPath);

  const provenancePath = join(
    repository,
    ".sandcastle",
    "skill-provenance.json",
  );
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  provenance.upstreamCommit = "0".repeat(40);
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  manifest.managedAssets[".sandcastle/skill-provenance.json"].sha256 =
    fileHash(provenancePath);

  manifest.installerVersion = "0.0.9";
  manifest.templateVersion = "0.9.0";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const configPath = join(repository, ".sandcastle", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.provider.models.ticket = "project-owned-model";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const configBefore = readFileSync(configPath, "utf8");
  const projectDocPath = join(repository, "docs", "agents", "sandcastle-queue.md");
  writeFileSync(projectDocPath, "# Project-owned upgrade guidance\n");
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

  const previewed = runCli(["upgrade", "--target", "1.0.0"], repository);
  assert.equal(previewed.status, 0, previewed.stderr);
  const preview = JSON.parse(previewed.stdout).result;
  assert.deepEqual(preview.conflicts, []);
  assert.equal(
    preview.updates.some(
      ({ path }) => path === ".github/workflows/sandcastle.yml",
    ),
    true,
  );
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-upgrade-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(preview.plan)}\n`);

  const upgraded = runCli(
    ["upgrade", "--plan", planPath, "--confirm", preview.plan.planHash],
    repository,
  );

  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.equal(JSON.parse(upgraded.stdout).result.changed, true);
  assert.match(readFileSync(workflowPath, "utf8"), /Managed by setup-sandcastle/u);
  assert.equal(
    directoryHash(codeReviewRoot),
    "31d149a480eaa68c11e32f5ee77f0fd0b98a906834d531d881d502352edd0b8e",
  );
  assert.equal(
    JSON.parse(readFileSync(lockPath, "utf8")).skills["code-review"].ref,
    "ed37663cc5fbef691ddfecd080dff42f7e7e350d",
  );
  assert.equal(
    JSON.parse(readFileSync(provenancePath, "utf8")).upstreamCommit,
    "ed37663cc5fbef691ddfecd080dff42f7e7e350d",
  );
  assert.equal(
    JSON.parse(readFileSync(manifestPath, "utf8")).installerVersion,
    "1.0.0",
  );
  assert.equal(readFileSync(configPath, "utf8"), configBefore);
  assert.equal(
    readFileSync(projectDocPath, "utf8"),
    "# Project-owned upgrade guidance\n",
  );
  assert.equal(
    readFileSync(customAdapterPath, "utf8"),
    '{"schemaVersion":1,"projectOwned":true}\n',
  );
});

test("upgrade requires an explicit reviewed diff before migrating project config schema", () => {
  const repository = createRepository();
  install(repository);
  const configPath = join(repository, ".sandcastle", "config.json");
  writeFileSync(
    configPath,
    '{"schemaVersion":0,"legacyQueue":"sandcastle"}\n',
  );
  const targetConfigPath = writeConfig();
  const projectDocPath = join(repository, "docs", "agents", "sandcastle-queue.md");
  writeFileSync(projectDocPath, "# Project-owned schema migration notes\n");

  const previewed = runCli(
    [
      "upgrade",
      "--target",
      "1.0.0",
      "--config",
      targetConfigPath,
    ],
    repository,
  );

  assert.equal(previewed.status, 0, previewed.stderr);
  const preview = JSON.parse(previewed.stdout).result;
  assert.equal(preview.plan.upgrade.configMigration !== null, true);
  assert.match(preview.plan.patch, /-\{"schemaVersion":0,"legacyQueue"/u);
  assert.match(preview.plan.patch, /\+\s+"schemaVersion": 1/u);
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-schema-upgrade-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(preview.plan)}\n`);

  const upgraded = runCli(
    ["upgrade", "--plan", planPath, "--confirm", preview.plan.planHash],
    repository,
  );

  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).schemaVersion, 1);
  assert.equal(
    readFileSync(projectDocPath, "utf8"),
    "# Project-owned schema migration notes\n",
  );
});

test("upgrade rolls back clean managed updates after a mid-apply failure", () => {
  const repository = createRepository();
  install(repository);
  const manifestPath = join(repository, ".sandcastle", "installation.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const workflowPath = join(
    repository,
    ".github",
    "workflows",
    "sandcastle.yml",
  );
  const legacyWorkflow =
    "name: Sandcastle Queue 0.0.9\non:\n  workflow_dispatch:\npermissions: {}\n";
  writeFileSync(workflowPath, legacyWorkflow);
  manifest.installerVersion = "0.0.9";
  manifest.templateVersion = "0.9.0";
  manifest.managedAssets[".github/workflows/sandcastle.yml"].sha256 =
    fileHash(workflowPath);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const previewed = runCli(["upgrade", "--target", "1.0.0"], repository);
  assert.equal(previewed.status, 0, previewed.stderr);
  const plan = JSON.parse(previewed.stdout).result.plan;
  assert.deepEqual(plan.upgrade.conflicts, []);
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-upgrade-failure-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const before = treeHash(repository);
  const protectedDirectory = join(repository, ".sandcastle");
  chmodSync(protectedDirectory, 0o500);

  let upgraded;
  try {
    upgraded = runCli(
      ["upgrade", "--plan", planPath, "--confirm", plan.planHash],
      repository,
    );
  } finally {
    chmodSync(protectedDirectory, 0o700);
  }

  assert.equal(upgraded.status, 3, upgraded.stderr);
  assert.equal(JSON.parse(upgraded.stdout).diagnostics[0].code, "APPLY_FAILED");
  assert.equal(treeHash(repository), before);
  assert.equal(readFileSync(workflowPath, "utf8"), legacyWorkflow);
  assert.equal(
    JSON.parse(readFileSync(manifestPath, "utf8")).installerVersion,
    "0.0.9",
  );
});

test("upgrade accepts only an exact release available in the current CLI", () => {
  const repository = createRepository();
  install(repository);
  const before = treeHash(repository);

  const floating = runCli(["upgrade", "--target", "latest"], repository);
  assert.equal(floating.status, 2, floating.stderr);
  assert.equal(
    JSON.parse(floating.stdout).diagnostics[0].code,
    "TARGET_RELEASE_INVALID",
  );

  const unavailable = runCli(["upgrade", "--target", "0.2.0"], repository);
  assert.equal(unavailable.status, 2, unavailable.stderr);
  assert.equal(
    JSON.parse(unavailable.stdout).diagnostics[0].code,
    "TARGET_RELEASE_UNAVAILABLE",
  );
  assert.equal(treeHash(repository), before);
});

test("rollback regenerates an exact historical release with upgrade-equivalent checks", () => {
  const repository = createRepository();
  install(repository);
  const manifestPath = join(repository, ".sandcastle", "installation.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const workflowPath = join(
    repository,
    ".github",
    "workflows",
    "sandcastle.yml",
  );
  writeFileSync(
    workflowPath,
    "name: Sandcastle Queue 0.2.0\non:\n  workflow_dispatch:\npermissions: {}\n",
  );
  manifest.installerVersion = "0.2.0";
  manifest.templateVersion = "2.0.0";
  manifest.managedAssets[".github/workflows/sandcastle.yml"].sha256 =
    fileHash(workflowPath);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const previewed = runCli(["rollback", "--target", "1.0.0"], repository);

  assert.equal(previewed.status, 0, previewed.stderr);
  const preview = JSON.parse(previewed.stdout).result;
  assert.equal(preview.mode, "preview");
  assert.equal(preview.plan.rollback.targetRelease, "1.0.0");
  assert.equal(preview.plan.rollback.fromInstallerVersion, "0.2.0");
  assert.deepEqual(preview.conflicts, []);
  assert.match(preview.plan.patch, /-name: Sandcastle Queue 0\.2\.0/u);
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-rollback-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(preview.plan)}\n`);

  const rolledBack = runCli(
    ["rollback", "--plan", planPath, "--confirm", preview.plan.planHash],
    repository,
  );

  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(JSON.parse(rolledBack.stdout).result.changed, true);
  assert.match(readFileSync(workflowPath, "utf8"), /Managed by setup-sandcastle/u);
  assert.equal(
    JSON.parse(readFileSync(manifestPath, "utf8")).installerVersion,
    "1.0.0",
  );
});

test("rollback blocks locally modified managed assets without force overwrite", () => {
  const repository = createRepository();
  install(repository);
  const manifestPath = join(repository, ".sandcastle", "installation.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.installerVersion = "0.2.0";
  manifest.templateVersion = "2.0.0";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const workflowPath = join(
    repository,
    ".github",
    "workflows",
    "sandcastle.yml",
  );
  writeFileSync(
    workflowPath,
    `${readFileSync(workflowPath, "utf8")}# locally modified future workflow\n`,
  );
  const before = treeHash(repository);

  const previewed = runCli(["rollback", "--target", "1.0.0"], repository);
  assert.equal(previewed.status, 0, previewed.stderr);
  const plan = JSON.parse(previewed.stdout).result.plan;
  assert.deepEqual(plan.rollback.conflicts.map(({ path }) => path), [
    ".github/workflows/sandcastle.yml",
  ]);
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-conflicted-rollback-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);

  const rolledBack = runCli(
    ["rollback", "--plan", planPath, "--confirm", plan.planHash],
    repository,
  );

  assert.equal(rolledBack.status, 2, rolledBack.stderr);
  assert.equal(
    JSON.parse(rolledBack.stdout).diagnostics[0].code,
    "ROLLBACK_CONFLICT",
  );
  assert.equal(treeHash(repository), before);
});
