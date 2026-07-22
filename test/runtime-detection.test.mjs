import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

function createNodeRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-runtime-node-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, ".nvmrc"), "22.22.2\n");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        name: "runtime-fixture",
        private: true,
        engines: { node: "22.22.2" },
        scripts: {
          test: "node --test",
          typecheck: "tsc --noEmit",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, "package-lock.json"),
    '{"name":"runtime-fixture","lockfileVersion":3,"packages":{}}\n',
  );
  return repository;
}

function status(repository) {
  return execFileSync(
    "git",
    ["-C", repository, "status", "--porcelain=v2", "--untracked-files=all"],
    { encoding: "utf8" },
  );
}

test("propose detects an exact Node npm runtime and direct completion commands", () => {
  const repository = createNodeRepository();
  const before = status(repository);
  const result = spawnSync(process.execPath, [cliPath.pathname, "propose"], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    command: "propose",
    ok: true,
    result: {
      adapterPlan: {
        bootstrap: [{ argv: ["npm", "ci"] }],
        environment: {
          inputs: [
            {
              path: "package-lock.json",
              sha256:
                "118500de73eec6dd0d2ca09649505b7270dcebfc53f80f6aba367cd9a853ff03",
            },
            {
              path: "package.json",
              sha256:
                "8dd6fcbf71783f3ae91cdfb98bec1cab021daaf705d9eebf5c4885282ccc0028",
            },
          ],
        },
        networkHosts: ["registry.npmjs.org"],
      },
      commands: {
        tests: [{ argv: ["npm", "test"] }],
        verification: [{ argv: ["npm", "run", "typecheck"] }],
      },
      runtime: {
        adapter: "node-npm",
        confirmed: false,
        signals: [".nvmrc", "package.json#engines.node"],
        version: "22.22.2",
      },
    },
    version: "1.0.0",
  });
  assert.equal(status(repository), before);
});

test("propose fails closed on conflicting versions until one is explicitly confirmed", () => {
  const repository = createNodeRepository();
  const packagePath = join(repository, "package.json");
  const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
  packageMetadata.engines.node = "20.19.4";
  writeFileSync(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);

  const ambiguous = spawnSync(process.execPath, [cliPath.pathname, "propose"], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(ambiguous.status, 2);
  assert.deepEqual(JSON.parse(ambiguous.stdout).diagnostics, [
    {
      code: "RUNTIME_VERSION_CONFLICT",
      message: "Project runtime declarations disagree on the exact Node.js version.",
      path: "/runtime",
    },
  ]);

  const confirmed = spawnSync(
    process.execPath,
    [
      cliPath.pathname,
      "propose",
      "--confirm-runtime",
      "node-npm@22.22.2",
    ],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.deepEqual(JSON.parse(confirmed.stdout).result.runtime, {
    adapter: "node-npm",
    confirmed: true,
    signals: [".nvmrc", "package.json#engines.node"],
    version: "22.22.2",
  });
});

test("propose requires an explicit adapter choice for a mixed runtime repository", () => {
  const repository = createNodeRepository();
  writeFileSync(join(repository, ".python-version"), "3.12.8\n");
  writeFileSync(join(repository, "requirements.txt"), "pytest==8.3.5\n");

  const ambiguous = spawnSync(process.execPath, [cliPath.pathname, "propose"], {
    cwd: repository,
    encoding: "utf8",
  });
  assert.equal(ambiguous.status, 2);
  assert.deepEqual(JSON.parse(ambiguous.stdout).diagnostics, [
    {
      code: "AMBIGUOUS_RUNTIME",
      message: "Multiple runtime adapters were detected; confirm one explicitly.",
      path: "/runtime",
    },
  ]);

  const confirmed = spawnSync(
    process.execPath,
    [
      cliPath.pathname,
      "propose",
      "--confirm-runtime",
      "python-pip@3.12.8",
    ],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.deepEqual(JSON.parse(confirmed.stdout).result, {
    adapterPlan: {
      bootstrap: [
        {
          argv: [
            "python",
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--requirement",
            "requirements.txt",
          ],
        },
      ],
      environment: {
        inputs: [
          {
            path: "requirements.txt",
            sha256:
              "a0e201ecda2bc871726ea3bb5db9cfe6b2109f60d8da88eecf910b790794b03d",
          },
        ],
        probe: { argv: ["python", "-m", "pip", "freeze", "--all"] },
      },
      networkHosts: ["files.pythonhosted.org", "pypi.org"],
    },
    commands: {
      tests: [{ argv: ["python", "-m", "pytest"] }],
      verification: [],
    },
    runtime: {
      adapter: "python-pip",
      confirmed: true,
      signals: [".python-version"],
      version: "3.12.8",
    },
  });
});

test("resolve-models applies explicit semantic-role fallbacks", () => {
  const repository = createNodeRepository();
  const configPath = join(repository, "sandcastle-input.json");
  writeFileSync(
    configPath,
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

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "resolve-models", "--config", configPath],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    command: "resolve-models",
    ok: true,
    result: {
      fallbacks: {
        fast: "ticket",
        finalFix: "ticket",
        finalReview: "ticket",
      },
      roles: {
        fast: "ticket-model",
        finalFix: "ticket-model",
        finalReview: "ticket-model",
        ticket: "ticket-model",
      },
    },
    version: "1.0.0",
  });
});

test("validate-config accepts only the supported custom adapter schema version", () => {
  const repository = createNodeRepository();
  const config = {
    schemaVersion: 1,
    queue: {
      ownershipLabel: "sandcastle",
      readyLabel: "ready-for-agent",
    },
    runtime: {
      adapter: "custom",
      custom: {
        bootstrap: [{ argv: ["acme", "install", "--frozen"] }],
        name: "acme-runtime",
        schemaVersion: 1,
      },
      networkHosts: [],
      version: "7.4.2",
    },
    commands: {
      tests: [{ argv: ["acme", "test"] }],
      verification: [{ argv: ["acme", "verify"] }],
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
  };
  const configPath = join(repository, "custom-config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const valid = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", configPath],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(valid.status, 0, valid.stderr);

  config.runtime.custom.schemaVersion = 2;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const unsupported = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", configPath],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(unsupported.status, 2);
  assert.deepEqual(JSON.parse(unsupported.stdout).diagnostics, [
    {
      code: "UNSUPPORTED_CUSTOM_ADAPTER_SCHEMA",
      message: "Only custom adapter schema version 1 is supported.",
      path: "/runtime/custom/schemaVersion",
    },
  ]);
});

test("propose fails closed when any runtime declaration is not exact", () => {
  const repository = createNodeRepository();
  writeFileSync(join(repository, ".nvmrc"), "22\n");

  const result = spawnSync(process.execPath, [cliPath.pathname, "propose"], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [
    {
      code: "RUNTIME_VERSION_INVALID",
      message: "Every detected runtime declaration must use an exact x.y.z version.",
      path: "/runtime",
    },
  ]);
});

test("propose refuses a runtime with no observable test command", () => {
  const repository = createNodeRepository();
  const packagePath = join(repository, "package.json");
  const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
  delete packageMetadata.scripts.test;
  writeFileSync(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);

  const result = spawnSync(process.execPath, [cliPath.pathname, "propose"], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [
    {
      code: "MISSING_TEST_COMMAND",
      message: "No supported test command could be proposed for the detected runtime.",
      path: "/runtime",
    },
  ]);
});
