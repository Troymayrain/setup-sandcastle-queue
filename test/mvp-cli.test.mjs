import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
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
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-mvp-cli-"));
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

function validConfig() {
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
      ticket: "claude-sonnet-4-5",
      finalReview: "claude-sonnet-4-5",
      finalFix: "claude-sonnet-4-5",
    },
    execution: { hostFinalizationReserveMinutes: 15 },
  };
}

function writeConfig(repository, mutate = () => {}) {
  const config = validConfig();
  mutate(config);
  const path = join(repository, "queue-config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

function run(repository, args, input) {
  return spawnSync(process.execPath, [cliPath.pathname, ...args], {
    cwd: repository,
    encoding: "utf8",
    input,
  });
}

function filesUnder(root, current = root) {
  if (!existsSync(current)) return [];
  return readdirSync(current).flatMap((name) => {
    const path = join(current, name);
    return statSync(path).isDirectory()
      ? filesUnder(root, path)
      : [relative(root, path).split("\\").join("/")];
  });
}

test("public CLI exposes only init, doctor, help, and version", () => {
  const repository = createRepository();
  const help = run(repository, ["--help"]);
  const version = run(repository, ["--version"]);
  const legacy = run(repository, ["plan"]);

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /init/u);
  assert.match(help.stdout, /doctor \[--offline\] \[--json\]/u);
  assert.doesNotMatch(help.stdout, /\b(plan|install|upgrade|uninstall|batch)\b/u);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageMetadata.version);
  assert.equal(legacy.status, 2);
});

test("init previews and installs only the Queue Template namespaces", () => {
  const repository = createRepository();
  const config = writeConfig(repository);
  const beforeHead = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });

  const result = run(repository, ["init", "--config", config], "yes\n");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /diff --git a\/\.sandcastle\/config\.json/u);
  assert.match(
    result.stdout,
    /diff --git a\/\.github\/workflows\/sandcastle-queue\.yml/u,
  );
  assert.match(result.stdout, /installed/u);
  assert.equal(
    execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }),
    beforeHead,
  );

  const installed = filesUnder(repository).filter(
    (path) =>
      !path.startsWith(".git/") &&
      path !== "README.md" &&
      path !== "queue-config.json",
  );
  assert.ok(installed.length > 8);
  assert.equal(
    installed.every(
      (path) =>
        path.startsWith(".sandcastle/") ||
        path === ".github/workflows/sandcastle-queue.yml",
    ),
    true,
  );
  assert.equal(existsSync(join(repository, ".sandcastle", "installation.json")), false);
});

test("init is idempotent and partial or conflicting footprints fail closed", () => {
  const repository = createRepository();
  const config = writeConfig(repository);
  assert.equal(run(repository, ["init", "--config", config], "yes\n").status, 0);
  const before = execFileSync(
    "git",
    ["-C", repository, "status", "--porcelain=v2", "--untracked-files=all"],
    { encoding: "utf8" },
  );

  const idempotent = run(repository, ["init", "--config", config]);
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.match(idempotent.stdout, /already initialized/u);
  assert.equal(
    execFileSync(
      "git",
      ["-C", repository, "status", "--porcelain=v2", "--untracked-files=all"],
      { encoding: "utf8" },
    ),
    before,
  );

  writeFileSync(join(repository, ".sandcastle", "README.md"), "project edit\n");
  const conflict = run(repository, ["init", "--config", config]);
  assert.equal(conflict.status, 4);
  const conflictOutput = JSON.parse(conflict.stdout);
  assert.equal(conflictOutput.code, "INSTALLATION_CONFLICT");
  assert.deepEqual(conflictOutput.inventory.conflicting, [".sandcastle/README.md"]);

  const partialRepository = createRepository();
  const partialConfig = writeConfig(partialRepository);
  execFileSync("mkdir", ["-p", join(partialRepository, ".sandcastle")]);
  writeFileSync(join(partialRepository, ".sandcastle", "README.md"), "occupied\n");
  const partial = run(partialRepository, ["init", "--config", partialConfig]);
  assert.equal(partial.status, 4);
  const partialOutput = JSON.parse(partial.stdout);
  assert.equal(partialOutput.code, "INSTALLATION_PARTIAL");
  assert.ok(partialOutput.inventory.missing.includes(".sandcastle/config.json"));
  assert.deepEqual(partialOutput.inventory.conflicting, [".sandcastle/README.md"]);
});

test("strict configuration fails closed without echoing unknown secret values", () => {
  const repository = createRepository();
  const config = writeConfig(repository, (value) => {
    value.providerToken = "never-print-this-secret";
  });

  const result = run(repository, ["init", "--config", config]);

  assert.equal(result.status, 2);
  assert.equal(result.stdout.includes("never-print-this-secret"), false);
  assert.equal(JSON.parse(result.stdout).code, "CONFIG_INVALID");
});

test("doctor --offline is read-only and marks remote checks not-run", () => {
  const repository = createRepository();
  const config = writeConfig(repository);
  assert.equal(run(repository, ["init", "--config", config], "yes\n").status, 0);
  const before = execFileSync(
    "git",
    ["-C", repository, "status", "--porcelain=v2", "--untracked-files=all"],
    { encoding: "utf8" },
  );

  const result = run(repository, ["doctor", "--offline", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.mode, "offline");
  assert.deepEqual(output.checks.remote, { status: "not-run" });
  assert.equal(
    execFileSync(
      "git",
      ["-C", repository, "status", "--porcelain=v2", "--untracked-files=all"],
      { encoding: "utf8" },
    ),
    before,
  );
});
