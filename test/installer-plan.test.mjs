import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
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
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-plan-repository-"));
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
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-plan-config-"));
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

function repositorySnapshot(repository) {
  return {
    config: execFileSync("git", ["-C", repository, "config", "--local", "--list"], {
      encoding: "utf8",
    }),
    head: execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }),
    status: execFileSync(
      "git",
      ["-C", repository, "status", "--porcelain=v2", "--untracked-files=all"],
      { encoding: "utf8" },
    ),
  };
}

test("plan deterministically previews a complete fresh install without repository writes", () => {
  const repository = createRepository();
  const configPath = writeConfig();
  const before = repositorySnapshot(repository);

  const first = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", configPath],
    { cwd: repository, encoding: "utf8" },
  );
  const second = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", configPath],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, "");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(repositorySnapshot(repository), before);
  assert.equal(existsSync(join(repository, ".sandcastle")), false);
  assert.equal(existsSync(join(repository, ".github", "workflows")), false);

  const output = JSON.parse(first.stdout);
  assert.equal(output.command, "plan");
  assert.equal(output.ok, true);
  assert.equal(output.result.installationState, "fresh");
  assert.equal(output.result.installerVersion, "0.1.0");
  assert.equal(output.result.templateVersion, "1.0.0");
  assert.match(output.result.planHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    output.result.assets.map(({ path, ownership, sha256 }) => ({
      hashIsSha256: /^[a-f0-9]{64}$/u.test(sha256),
      ownership,
      path,
    })),
    [
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".agents/skills/code-review/agents/openai.yaml",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".agents/skills/code-review/SKILL.md",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".agents/skills/implement/agents/openai.yaml",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".agents/skills/implement/SKILL.md",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".agents/skills/sandcastle-runtime/SKILL.md",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".agents/skills/tdd/agents/openai.yaml",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".agents/skills/tdd/mocking.md",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".agents/skills/tdd/SKILL.md",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".agents/skills/tdd/tests.md",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".github/workflows/sandcastle.yml",
      },
      {
        hashIsSha256: true,
        ownership: "project",
        path: ".sandcastle/config.json",
      },
      {
        hashIsSha256: true,
        ownership: "installer-state",
        path: ".sandcastle/installation.json",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".sandcastle/skill-provenance.json",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: ".sandcastle/THIRD_PARTY_NOTICES.md",
      },
      {
        hashIsSha256: true,
        ownership: "project",
        path: "docs/agents/sandcastle-queue.md",
      },
      {
        hashIsSha256: true,
        ownership: "installer",
        path: "skills-lock.json",
      },
    ],
  );
  assert.match(output.result.patch, /new file mode 100644/u);
  assert.match(output.result.patch, /\+\s+"schemaVersion": 1/u);
  assert.match(output.result.patch, /b\/\.github\/workflows\/sandcastle\.yml/u);
  assert.match(output.result.patch, /b\/\.sandcastle\/installation\.json/u);
});

test("plan distinguishes unmanaged and managed Sandcastle assets", () => {
  const configPath = writeConfig();
  const unmanagedRepository = createRepository();
  mkdirSync(join(unmanagedRepository, ".github", "workflows"), {
    recursive: true,
  });
  writeFileSync(
    join(unmanagedRepository, ".github", "workflows", "sandcastle.yml"),
    "name: legacy Sandcastle\n",
  );

  const unmanaged = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", configPath],
    { cwd: unmanagedRepository, encoding: "utf8" },
  );
  assert.equal(unmanaged.status, 0, unmanaged.stderr);
  assert.equal(JSON.parse(unmanaged.stdout).result.installationState, "unmanaged");

  const managedRepository = createRepository();
  mkdirSync(join(managedRepository, ".sandcastle"), { recursive: true });
  writeFileSync(
    join(managedRepository, ".sandcastle", "installation.json"),
    "{}\n",
  );
  const managed = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", configPath],
    { cwd: managedRepository, encoding: "utf8" },
  );
  assert.equal(managed.status, 0, managed.stderr);
  assert.equal(JSON.parse(managed.stdout).result.installationState, "managed");
});

test("plan saves secretless pending state and resumes the identical plan", () => {
  const repository = createRepository();
  const configPath = writeConfig();
  const before = repositorySnapshot(repository);
  const secret = "provider-token-must-not-be-persisted";
  const baseUrl = "https://private-provider.example.invalid";
  const environment = {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_BASE_URL: baseUrl,
  };

  const saved = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", configPath, "--save-pending"],
    { cwd: repository, encoding: "utf8", env: environment },
  );

  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(repositorySnapshot(repository), before);
  const pendingPath = join(
    repository,
    ".git",
    "sandcastle",
    "pending-plan.json",
  );
  assert.equal(existsSync(pendingPath), true);
  const pending = readFileSync(pendingPath, "utf8");
  assert.equal(pending.includes(secret), false);
  assert.equal(pending.includes(baseUrl), false);

  const resumed = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--resume-pending"],
    { cwd: repository, encoding: "utf8", env: environment },
  );

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.stdout, saved.stdout);
  assert.deepEqual(repositorySnapshot(repository), before);
});
