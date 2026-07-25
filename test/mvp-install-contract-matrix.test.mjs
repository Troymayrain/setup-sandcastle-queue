import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const allowedWorkflow = ".github/workflows/sandcastle-queue.yml";

const fixtureDefinitions = {
  node: {
    commands: {
      bootstrap: [
        { argv: ["node", "fixture-command.mjs", "bootstrap", "literal;not-shell"] },
      ],
      test: [{ argv: ["node", "fixture-command.mjs", "test", "node"] }],
      verification: [
        { argv: ["node", "fixture-command.mjs", "verification", "node"] },
      ],
    },
    expectedLog: [
      ["node", "bootstrap", "literal;not-shell"],
      ["node", "test", "node"],
      ["node", "verification", "node"],
    ],
    files: {
      "README.md": "# Node fixture\n",
      "fixture-command.mjs": `import { appendFileSync } from "node:fs";
appendFileSync(".command-log", JSON.stringify(["node", ...process.argv.slice(2)]) + "\\n");
`,
      "package-lock.json": `${JSON.stringify(
        {
          name: "node-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": { name: "node-fixture", version: "1.0.0" },
          },
        },
        null,
        2,
      )}\n`,
      "package.json": `${JSON.stringify(
        { name: "node-fixture", private: true, version: "1.0.0" },
        null,
        2,
      )}\n`,
      "src/app.js": "export const fixture = 'node';\n",
    },
  },
  python: {
    commands: {
      bootstrap: [
        {
          argv: [
            "python3",
            "fixture_command.py",
            "bootstrap",
            "literal;not-shell",
          ],
        },
      ],
      test: [{ argv: ["python3", "fixture_command.py", "test", "python"] }],
      verification: [
        { argv: ["python3", "fixture_command.py", "verification", "python"] },
      ],
    },
    expectedLog: [
      ["python", "bootstrap", "literal;not-shell"],
      ["python", "test", "python"],
      ["python", "verification", "python"],
    ],
    files: {
      "README.md": "# Python fixture\n",
      "fixture_command.py": `import json
import sys

with open(".command-log", "a", encoding="utf-8") as output:
    output.write(json.dumps(["python", *sys.argv[1:]], separators=(",", ":")) + "\\n")
`,
      "pyproject.toml": `[project]
name = "python-fixture"
version = "1.0.0"
requires-python = ">=3.12"
dependencies = []
`,
      "src/app.py": "FIXTURE = 'python'\n",
      "uv.lock": "version = 1\nrevision = 3\nrequires-python = \">=3.12\"\n",
    },
  },
  mixed: {
    commands: {
      bootstrap: [
        { argv: ["node", "fixture-command.mjs", "bootstrap-node", "mixed"] },
        {
          argv: [
            "python3",
            "fixture_command.py",
            "bootstrap-python",
            "literal;not-shell",
          ],
        },
      ],
      test: [{ argv: ["python3", "fixture_command.py", "test", "mixed"] }],
      verification: [
        { argv: ["node", "fixture-command.mjs", "verification", "mixed"] },
      ],
    },
    expectedLog: [
      ["node", "bootstrap-node", "mixed"],
      ["python", "bootstrap-python", "literal;not-shell"],
      ["python", "test", "mixed"],
      ["node", "verification", "mixed"],
    ],
    files: {
      "README.md": "# Mixed Node/Python fixture\n",
      "fixture-command.mjs": `import { appendFileSync } from "node:fs";
appendFileSync(".command-log", JSON.stringify(["node", ...process.argv.slice(2)]) + "\\n");
`,
      "fixture_command.py": `import json
import sys

with open(".command-log", "a", encoding="utf-8") as output:
    output.write(json.dumps(["python", *sys.argv[1:]], separators=(",", ":")) + "\\n")
`,
      "package-lock.json": `${JSON.stringify(
        {
          name: "mixed-fixture",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": { name: "mixed-fixture", version: "1.0.0" },
          },
        },
        null,
        2,
      )}\n`,
      "package.json": `${JSON.stringify(
        { name: "mixed-fixture", private: true, version: "1.0.0" },
        null,
        2,
      )}\n`,
      "pyproject.toml": `[project]
name = "mixed-fixture"
version = "1.0.0"
requires-python = ">=3.12"
dependencies = []
`,
      "src/app.js": "export const fixture = 'mixed';\n",
      "src/app.py": "FIXTURE = 'mixed'\n",
      "uv.lock": "version = 1\nrevision = 3\nrequires-python = \">=3.12\"\n",
    },
  },
};

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function createRepository(kind) {
  const definition = fixtureDefinitions[kind];
  const repository = mkdtempSync(join(tmpdir(), `sandcastle-mvp-${kind}-`));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
  writeFiles(repository, definition.files);
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
    `${kind} fixture`,
  ]);
  return repository;
}

function configFor(commands) {
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
    commands,
    models: {
      ticket: "claude-sonnet-4-5",
      finalReview: "claude-sonnet-4-5",
      finalFix: "claude-sonnet-4-5",
    },
    execution: { hostFinalizationReserveMinutes: 15 },
  };
}

function writeConfig(kind, commands) {
  const directory = mkdtempSync(join(tmpdir(), `sandcastle-config-${kind}-`));
  const path = join(directory, "queue-config.json");
  writeFileSync(path, `${JSON.stringify(configFor(commands), null, 2)}\n`);
  return path;
}

function runCli(repository, configPath, input) {
  return spawnSync(
    process.execPath,
    [cliPath.pathname, "init", "--config", configPath],
    {
      cwd: repository,
      encoding: "utf8",
      input,
      timeout: 30_000,
    },
  );
}

function filesUnder(root, current = root) {
  if (!existsSync(current)) return [];
  return readdirSync(current)
    .sort()
    .flatMap((name) => {
      if (current === root && name === ".git") return [];
      const path = join(current, name);
      return statSync(path).isDirectory()
        ? filesUnder(root, path)
        : [relative(root, path).split("\\").join("/")];
    });
}

function snapshot(root) {
  return Object.fromEntries(
    filesUnder(root).map((path) => [
      path,
      {
        mode: statSync(join(root, path)).mode,
        sha256: sha256(readFileSync(join(root, path))),
      },
    ]),
  );
}

function runToolCommand(toolRoot, args) {
  const result = spawnSync("npm", args, {
    cwd: toolRoot,
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(
    result.status,
    0,
    `npm ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
}

async function runDeclaredCommands(repository, commands) {
  const toolDist = join(repository, ".sandcastle", "tool", "dist");
  const [{ NodeIntegrationHost }, { runCommandGroups }] = await Promise.all([
    import(pathToFileURL(join(toolDist, "host-boundary.js"))),
    import(pathToFileURL(join(toolDist, "finalization.js"))),
  ]);
  const host = new NodeIntegrationHost(
    repository,
    {
      GITHUB_REPOSITORY: "acme/fixture",
      GITHUB_TOKEN: "host-only-test-token",
    },
    {},
  );
  await runCommandGroups(
    [commands.bootstrap, commands.test, commands.verification],
    (argv) =>
      host.runCommand(argv, {
        PATH: process.env.PATH,
      }),
  );
}

for (const [kind, definition] of Object.entries(fixtureDefinitions)) {
  test(`${kind} repository satisfies the Fresh, Idempotent, Partial, and Conflict install contracts`, async () => {
    const repository = createRepository(kind);
    const configPath = writeConfig(kind, definition.commands);
    const applicationBefore = Object.fromEntries(
      Object.keys(definition.files).map((path) => [
        path,
        sha256(readFileSync(join(repository, path))),
      ]),
    );

    const fresh = runCli(repository, configPath, "yes\n");

    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.stdout, /installed as Project-controlled Assets/u);
    const installedFiles = filesUnder(repository).filter(
      (path) => !Object.hasOwn(definition.files, path),
    );
    assert.ok(installedFiles.length > 8);
    assert.equal(
      installedFiles.every(
        (path) => path.startsWith(".sandcastle/") || path === allowedWorkflow,
      ),
      true,
      installedFiles.join("\n"),
    );
    for (const [path, hash] of Object.entries(applicationBefore)) {
      assert.equal(sha256(readFileSync(join(repository, path))), hash, path);
    }
    assert.equal(existsSync(join(repository, "node_modules")), false);
    assert.equal(
      readFileSync(join(repository, ".sandcastle", "config.json"), "utf8").includes(
        '"runtime"',
      ),
      false,
    );
    assert.equal(
      installedFiles.some((path) => /(?:adapter|runtime-detect)/iu.test(path)),
      false,
    );

    const beforeIdempotent = snapshot(repository);
    const idempotent = runCli(repository, configPath);
    assert.equal(idempotent.status, 0, idempotent.stderr);
    assert.match(idempotent.stdout, /already initialized; no writes performed/u);
    assert.deepEqual(snapshot(repository), beforeIdempotent);

    const toolRoot = join(repository, ".sandcastle", "tool");
    runToolCommand(toolRoot, ["ci"]);
    runToolCommand(toolRoot, ["run", "typecheck"]);
    runToolCommand(toolRoot, ["test"]);

    await runDeclaredCommands(repository, definition.commands);
    const observed = readFileSync(join(repository, ".command-log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(observed, definition.expectedLog);
    assert.equal(existsSync(join(repository, "not-shell")), false);

    const readmePath = join(repository, ".sandcastle", "README.md");
    const templateReadme = readFileSync(readmePath, "utf8");
    writeFileSync(readmePath, "occupied by the project\n");
    const conflict = runCli(repository, configPath);
    assert.equal(conflict.status, 4, conflict.stderr);
    const conflictOutput = JSON.parse(conflict.stdout);
    assert.equal(conflictOutput.code, "INSTALLATION_CONFLICT");
    assert.deepEqual(conflictOutput.inventory.conflicting, [".sandcastle/README.md"]);

    writeFileSync(readmePath, templateReadme);
    rmSync(join(repository, ".sandcastle", "config.schema.json"));
    const partial = runCli(repository, configPath);
    assert.equal(partial.status, 4, partial.stderr);
    const partialOutput = JSON.parse(partial.stdout);
    assert.equal(partialOutput.code, "INSTALLATION_PARTIAL");
    assert.deepEqual(partialOutput.inventory.missing, [
      ".sandcastle/config.schema.json",
    ]);

    for (const [path, hash] of Object.entries(applicationBefore)) {
      assert.equal(sha256(readFileSync(join(repository, path))), hash, path);
    }
  });
}
