import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
const upstreamCommit = "ed37663cc5fbef691ddfecd080dff42f7e7e350d";

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-skills-repository-"));
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
  return repository;
}

function writeConfig() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-skills-config-"));
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

function install(repository, configPath) {
  const planned = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", configPath],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout).result;
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-skills-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const installed = spawnSync(
    process.execPath,
    [
      cliPath.pathname,
      "install",
      "--plan",
      planPath,
      "--confirm",
      plan.planHash,
    ],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
}

function collectFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current).sort()) {
    const absolute = join(current, entry);
    if (statSync(absolute).isDirectory()) {
      collectFiles(root, absolute, files);
    } else {
      files.push({
        content: readFileSync(absolute),
        path: relative(root, absolute).split("\\").join("/"),
      });
    }
  }
  return files;
}

function skillsCliHash(skillDirectory) {
  const hash = createHash("sha256");
  for (const file of collectFiles(skillDirectory).sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    hash.update(file.path);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

test("install locks verified upstream runtime skills with license provenance", () => {
  const repository = createRepository();
  install(repository, writeConfig());
  const lock = JSON.parse(readFileSync(join(repository, "skills-lock.json"), "utf8"));

  assert.equal(lock.version, 1);
  assert.deepEqual(Object.keys(lock.skills), ["code-review", "implement", "tdd"]);
  for (const [name, skillPath] of [
    ["code-review", "skills/engineering/code-review/SKILL.md"],
    ["implement", "skills/engineering/implement/SKILL.md"],
    ["tdd", "skills/engineering/tdd/SKILL.md"],
  ]) {
    const entry = lock.skills[name];
    assert.deepEqual(
      {
        computedHash: entry.computedHash,
        ref: entry.ref,
        skillPath: entry.skillPath,
        source: entry.source,
        sourceType: entry.sourceType,
      },
      {
        computedHash: skillsCliHash(
          join(repository, ".agents", "skills", name),
        ),
        ref: upstreamCommit,
        skillPath,
        source: "mattpocock/skills",
        sourceType: "github",
      },
    );
  }
  assert.equal(lock.skills["setup-matt-pocock-skills"], undefined);

  const wrapper = readFileSync(
    join(repository, ".agents", "skills", "sandcastle-runtime", "SKILL.md"),
    "utf8",
  );
  assert.match(wrapper, /delegates to the upstream `implement`, `tdd`, and `code-review`/u);
  const notices = readFileSync(
    join(repository, ".sandcastle", "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  assert.match(notices, /Copyright \(c\) 2026 Matt Pocock/u);
  assert.match(notices, /https:\/\/github\.com\/mattpocock\/skills/u);
  assert.match(notices, new RegExp(upstreamCommit, "u"));

  const manifest = JSON.parse(
    readFileSync(join(repository, ".sandcastle", "installation.json"), "utf8"),
  );
  assert.equal(
    manifest.managedAssets["docs/agents/sandcastle-queue.md"],
    undefined,
  );
  assert.equal(
    manifest.projectAssets.includes("docs/agents/sandcastle-queue.md"),
    true,
  );
});

test("reinstall never overwrites a setup-generated project-owned Agent document", () => {
  const repository = createRepository();
  const configPath = writeConfig();
  install(repository, configPath);
  const projectDoc = join(repository, "docs", "agents", "sandcastle-queue.md");
  writeFileSync(projectDoc, "# Project-owned guidance\n\nKeep this local policy.\n");

  install(repository, configPath);

  assert.equal(
    readFileSync(projectDoc, "utf8"),
    "# Project-owned guidance\n\nKeep this local policy.\n",
  );
});
