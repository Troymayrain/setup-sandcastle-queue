import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-apply-repository-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  writeFileSync(
    join(repository, "package.json"),
    '{"name":"target-application","private":true}\n',
  );
  execFileSync("git", ["-C", repository, "add", "README.md", "package.json"]);
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
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-apply-config-"));
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
          models: {
            fast: "claude-haiku-4-5",
            finalFix: "claude-sonnet-4-5",
            finalReview: "claude-sonnet-4-5",
            ticket: "claude-sonnet-4-5",
          },
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

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
}

function createPlanFile(repository, configPath) {
  const planned = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", configPath],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout).result;
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-confirmed-plan-"));
  const path = join(directory, "plan.json");
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  return { path, plan };
}

test("install atomically applies a confirmed plan beside unrelated dirty files", () => {
  const repository = createRepository();
  const configPath = writeConfig();
  const { path: planPath, plan } = createPlanFile(repository, configPath);
  const headBefore = git(repository, ["rev-parse", "HEAD"]);
  const indexBefore = git(repository, ["ls-files", "--stage", "-z"]);
  const configBefore = git(repository, ["config", "--local", "--list"]);
  const dependencyManifestBefore = readFileSync(
    join(repository, "package.json"),
    "utf8",
  );
  writeFileSync(join(repository, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(repository, "notes.txt"), "untracked user notes\n");

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
  assert.equal(installed.stderr, "");
  assert.deepEqual(JSON.parse(installed.stdout), {
    command: "install",
    ok: true,
    result: {
      changed: true,
      filesWritten: [
        ".agents/skills/code-review/agents/openai.yaml",
        ".agents/skills/code-review/SKILL.md",
        ".agents/skills/implement/agents/openai.yaml",
        ".agents/skills/implement/SKILL.md",
        ".agents/skills/sandcastle-runtime/SKILL.md",
        ".agents/skills/tdd/agents/openai.yaml",
        ".agents/skills/tdd/mocking.md",
        ".agents/skills/tdd/SKILL.md",
        ".agents/skills/tdd/tests.md",
        ".github/workflows/sandcastle.yml",
        ".sandcastle/config.json",
        ".sandcastle/installation.json",
        ".sandcastle/skill-provenance.json",
        ".sandcastle/THIRD_PARTY_NOTICES.md",
        "docs/agents/sandcastle-queue.md",
        "skills-lock.json",
      ],
      planHash: plan.planHash,
    },
    version: "1.0.0",
  });
  assert.equal(readFileSync(join(repository, "README.md"), "utf8"), "# fixture\nlocal edit\n");
  assert.equal(readFileSync(join(repository, "notes.txt"), "utf8"), "untracked user notes\n");
  assert.equal(
    readFileSync(join(repository, "package.json"), "utf8"),
    dependencyManifestBefore,
  );
  assert.equal(git(repository, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(git(repository, ["ls-files", "--stage", "-z"]), indexBefore);
  assert.equal(git(repository, ["config", "--local", "--list"]), configBefore);
  assert.equal(git(repository, ["diff", "--cached"]), "");
  assert.match(
    readFileSync(
      join(repository, ".github", "workflows", "sandcastle.yml"),
      "utf8",
    ),
    /workflow_dispatch:/u,
  );
  assert.equal(
    JSON.parse(
      readFileSync(join(repository, ".sandcastle", "installation.json"), "utf8"),
    ).installerVersion,
    "1.0.0",
  );
});

test("install rejects a plan that was not confirmed by its exact hash", () => {
  const repository = createRepository();
  const { path: planPath } = createPlanFile(repository, writeConfig());
  const result = spawnSync(
    process.execPath,
    [
      cliPath.pathname,
      "install",
      "--plan",
      planPath,
      "--confirm",
      "0".repeat(64),
    ],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [
    {
      code: "PLAN_NOT_CONFIRMED",
      message: "Installation requires explicit confirmation of the exact plan hash.",
      path: "",
    },
  ]);
  assert.equal(existsSync(join(repository, ".sandcastle")), false);
  assert.equal(existsSync(join(repository, ".github")), false);
});

test("install rejects an untracked collision added after planning", () => {
  const repository = createRepository();
  const { path: planPath, plan } = createPlanFile(repository, writeConfig());
  mkdirSync(join(repository, ".sandcastle"), { recursive: true });
  const collisionPath = join(repository, ".sandcastle", "config.json");
  writeFileSync(collisionPath, "user-owned collision\n");

  const result = spawnSync(
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

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [
    {
      code: "PLAN_STALE",
      message: "Target assets changed after the installation plan was created.",
      path: "",
    },
  ]);
  assert.equal(readFileSync(collisionPath, "utf8"), "user-owned collision\n");
  assert.equal(
    existsSync(join(repository, ".github", "workflows", "sandcastle.yml")),
    false,
  );
  assert.equal(
    existsSync(join(repository, ".sandcastle", "installation.json")),
    false,
  );
});

test("install rolls back every candidate file after a mid-apply filesystem failure", () => {
  const repository = createRepository();
  const { path: planPath, plan } = createPlanFile(repository, writeConfig());
  const protectedDirectory = join(repository, ".sandcastle");
  mkdirSync(protectedDirectory);
  writeFileSync(join(protectedDirectory, "keep.txt"), "user data\n");
  const statusBefore = git(repository, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
  ]);
  chmodSync(protectedDirectory, 0o500);

  let result;
  try {
    result = spawnSync(
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
  } finally {
    chmodSync(protectedDirectory, 0o700);
  }

  assert.equal(result.status, 3);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [
    {
      code: "APPLY_FAILED",
      message: "Installation failed and all target changes were rolled back.",
    },
  ]);
  assert.equal(
    existsSync(join(repository, ".github", "workflows", "sandcastle.yml")),
    false,
  );
  assert.equal(
    existsSync(join(repository, ".sandcastle", "config.json")),
    false,
  );
  assert.equal(
    existsSync(join(repository, ".sandcastle", "installation.json")),
    false,
  );
  assert.equal(
    readFileSync(join(protectedDirectory, "keep.txt"), "utf8"),
    "user data\n",
  );
  assert.equal(
    git(repository, ["status", "--porcelain=v2", "--untracked-files=all"]),
    statusBefore,
  );
});

test("reinstalling an unchanged managed installation is a zero-diff operation", () => {
  const repository = createRepository();
  const configPath = writeConfig();
  const firstPlan = createPlanFile(repository, configPath);
  const firstInstall = spawnSync(
    process.execPath,
    [
      cliPath.pathname,
      "install",
      "--plan",
      firstPlan.path,
      "--confirm",
      firstPlan.plan.planHash,
    ],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(firstInstall.status, 0, firstInstall.stderr);

  const secondPlan = createPlanFile(repository, configPath);
  assert.equal(secondPlan.plan.installationState, "managed");
  assert.equal(secondPlan.plan.patch, "");
  const trackedPaths = [
    ".github/workflows/sandcastle.yml",
    ".sandcastle/config.json",
    ".sandcastle/installation.json",
  ];
  const contentsBefore = Object.fromEntries(
    trackedPaths.map((path) => [path, readFileSync(join(repository, path), "utf8")]),
  );
  const statusBefore = git(repository, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
  ]);
  const headBefore = git(repository, ["rev-parse", "HEAD"]);
  const indexBefore = git(repository, ["ls-files", "--stage", "-z"]);

  const secondInstall = spawnSync(
    process.execPath,
    [
      cliPath.pathname,
      "install",
      "--plan",
      secondPlan.path,
      "--confirm",
      secondPlan.plan.planHash,
    ],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(secondInstall.status, 0, secondInstall.stderr);
  assert.deepEqual(JSON.parse(secondInstall.stdout).result, {
    changed: false,
    filesWritten: [],
    planHash: secondPlan.plan.planHash,
  });
  assert.deepEqual(
    Object.fromEntries(
      trackedPaths.map((path) => [path, readFileSync(join(repository, path), "utf8")]),
    ),
    contentsBefore,
  );
  assert.equal(
    git(repository, ["status", "--porcelain=v2", "--untracked-files=all"]),
    statusBefore,
  );
  assert.equal(git(repository, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(git(repository, ["ls-files", "--stage", "-z"]), indexBefore);
});

test("install refuses a symlinked candidate parent without writing outside the repository", () => {
  const repository = createRepository();
  const outside = mkdtempSync(join(tmpdir(), "sandcastle-install-outside-"));
  symlinkSync(outside, join(repository, ".sandcastle"));

  const planned = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", writeConfig()],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(planned.status, 2, planned.stderr);
  assert.equal(
    JSON.parse(planned.stdout).diagnostics.some(
      ({ code }) => code === "INSTALL_PATH_SYMLINK_FORBIDDEN",
    ),
    true,
  );
  assert.deepEqual(readdirSync(outside), []);
});
