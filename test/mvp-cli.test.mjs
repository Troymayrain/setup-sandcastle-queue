import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { assertSafeAssetPath } from "../dist/mvp/installer.js";

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

function gitControlSnapshot(repository) {
  const read = (args) =>
    execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  return {
    branch: read(["branch", "--show-current"]),
    head: read(["rev-parse", "HEAD"]),
    index: read(["ls-files", "--stage"]),
    stash: read(["stash", "list"]),
  };
}

function confirmAfterPrompt(repository, args, mutate) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath.pathname, ...args], {
      cwd: repository,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let confirmed = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!confirmed && stdout.includes("Type yes to continue:")) {
        confirmed = true;
        mutate();
        child.stdin.end("yes\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });
}

test("public CLI exposes only init, doctor, help, and version", () => {
  const repository = createRepository();
  const help = run(repository, ["--help"]);
  const version = run(repository, ["--version"]);
  const legacy = run(repository, ["plan"]);
  const alias = run(repository, ["-h"]);
  const extra = run(repository, ["doctor", "--offline", "--bogus"]);

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /init/u);
  assert.match(help.stdout, /doctor \[--offline\] \[--json\]/u);
  assert.doesNotMatch(help.stdout, /\b(plan|install|upgrade|uninstall|batch)\b/u);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageMetadata.version);
  assert.equal(legacy.status, 2);
  assert.equal(alias.status, 2);
  assert.equal(extra.status, 2);
});

test("init previews and installs only the Queue Template namespaces", () => {
  const repository = createRepository();
  const config = writeConfig(repository);
  const beforeGit = gitControlSnapshot(repository);

  const result = run(repository, ["init", "--config", config], "yes\n");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /diff --git a\/\.sandcastle\/config\.json/u);
  assert.match(
    result.stdout,
    /diff --git a\/\.github\/workflows\/sandcastle-queue\.yml/u,
  );
  assert.match(result.stdout, /installed/u);
  assert.deepEqual(gitControlSnapshot(repository), beforeGit);

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

  const missing = writeConfig(repository, (value) => {
    delete value.models.finalFix;
  });
  assert.equal(run(repository, ["init", "--config", missing]).status, 2);

  const unsupported = writeConfig(repository, (value) => {
    value.schemaVersion = 2;
  });
  assert.equal(run(repository, ["init", "--config", unsupported]).status, 2);

  assert.equal(
    run(repository, ["init", "--config", join(repository, "absent.json")]).status,
    3,
  );
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

  const full = run(repository, ["doctor", "--json"]);
  assert.equal(full.status, 4);
  assert.equal(JSON.parse(full.stdout).mode, "full");
  assert.deepEqual(JSON.parse(full.stdout).checks.remote, {
    code: "REMOTE_NOT_CONFIGURED",
    status: "fail",
  });
});

test("init reports a parent-path collision as an exact conflict inventory", () => {
  const repository = createRepository();
  const config = writeConfig(repository);
  writeFileSync(join(repository, ".sandcastle"), "occupied\n");

  const result = run(repository, ["init", "--config", config]);

  assert.equal(result.status, 4);
  const output = JSON.parse(result.stdout);
  assert.equal(output.code, "INSTALLATION_PARTIAL");
  assert.ok(output.inventory.conflicting.includes(".sandcastle/config.json"));
});

for (const staleKind of ["head", "head-reference", "index", "index-flags", "target"]) {
  test(`init rejects a stale ${staleKind} after the preview confirmation boundary`, async () => {
    const repository = createRepository();
    const config = writeConfig(repository);
    const result = await confirmAfterPrompt(
      repository,
      ["init", "--config", config],
      () => {
        if (staleKind === "head") {
          writeFileSync(join(repository, "HEAD-CHANGE"), "changed\n");
          execFileSync("git", ["-C", repository, "add", "HEAD-CHANGE"]);
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
            "head changed",
          ]);
        } else if (staleKind === "head-reference") {
          execFileSync("git", ["-C", repository, "switch", "-c", "same-head"]);
        } else if (staleKind === "index") {
          writeFileSync(join(repository, "INDEX-CHANGE"), "changed\n");
          execFileSync("git", ["-C", repository, "add", "INDEX-CHANGE"]);
        } else if (staleKind === "index-flags") {
          execFileSync("git", [
            "-C",
            repository,
            "update-index",
            "--assume-unchanged",
            "README.md",
          ]);
        } else {
          mkdirSync(join(repository, ".sandcastle"), { recursive: true });
          writeFileSync(join(repository, ".sandcastle", "README.md"), "occupied\n");
        }
      },
    );

    assert.equal(result.status, 4, result.stderr);
    assert.equal(JSON.parse(result.stdout.slice(result.stdout.lastIndexOf("\n{") + 1)).code, "INSTALLATION_STALE");
    assert.equal(existsSync(join(repository, ".github", "workflows", "sandcastle-queue.yml")), false);
  });
}

test("init rolls back every installed asset when a write fails", async () => {
  const repository = createRepository();
  const config = writeConfig(repository);
  mkdirSync(join(repository, ".sandcastle"));

  const result = await confirmAfterPrompt(
    repository,
    ["init", "--config", config],
    () => chmodSync(join(repository, ".sandcastle"), 0o500),
  );
  chmodSync(join(repository, ".sandcastle"), 0o700);

  assert.equal(result.status, 3, result.stderr);
  assert.equal(existsSync(join(repository, ".github", "workflows", "sandcastle-queue.yml")), false);
  assert.deepEqual(readdirSync(join(repository, ".sandcastle")), []);
});

test("init rejects symlink parents and asset path traversal", () => {
  const repository = createRepository();
  const outside = mkdtempSync(join(tmpdir(), "sandcastle-outside-"));
  const config = writeConfig(repository);
  symlinkSync(outside, join(repository, ".sandcastle"));

  const result = run(repository, ["init", "--config", config]);

  assert.equal(result.status, 4);
  assert.equal(JSON.parse(result.stdout).code, "INSTALL_PATH_SYMLINK_FORBIDDEN");
  assert.deepEqual(readdirSync(outside), []);
  assert.throws(() => assertSafeAssetPath(repository, "../outside"), {
    code: "INSTALL_PATH_OUTSIDE_REPOSITORY",
  });
  assert.throws(() => assertSafeAssetPath(repository, "/tmp/outside"), {
    code: "INSTALL_PATH_OUTSIDE_REPOSITORY",
  });
});

test("init works when the Git directory is stored separately", () => {
  const parent = mkdtempSync(join(tmpdir(), "sandcastle-separate-git-"));
  const repository = join(parent, "worktree");
  const gitDirectory = join(parent, "metadata.git");
  mkdirSync(repository);
  execFileSync("git", [
    "init",
    "--quiet",
    `--separate-git-dir=${gitDirectory}`,
    repository,
  ]);
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
  const config = writeConfig(repository);

  const result = run(repository, ["init", "--config", config], "yes\n");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(repository, ".sandcastle", "config.json")), true);
});
