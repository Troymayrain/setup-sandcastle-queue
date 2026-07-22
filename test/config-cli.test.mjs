import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-config-cli-"));
  execFileSync("git", ["init", "--quiet", repository]);
  return repository;
}

function validConfig() {
  return {
    schemaVersion: 1,
    queue: {
      ownershipLabel: "sandcastle",
      readyLabel: "ready-for-agent",
    },
    runtime: {
      adapter: "node-npm",
      version: "22.22.2",
    },
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
    audit: {
      retentionDays: 30,
    },
  };
}

test("version reports the package SemVer through the CLI process boundary", () => {
  const repository = createRepository();
  const result = spawnSync(process.execPath, [cliPath.pathname, "version"], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    command: "version",
    ok: true,
    version: packageMetadata.version,
  });
});

test("validate-config accepts the six versioned configuration sections", () => {
  const repository = createRepository();
  writeFileSync(
    join(repository, "sandcastle.json"),
    `${JSON.stringify(validConfig(), null, 2)}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", "sandcastle.json"],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    command: "validate-config",
    ok: true,
    result: {
      configPath: "sandcastle.json",
      schemaVersion: 1,
    },
    version: packageMetadata.version,
  });
});

test("validate-config rejects unknown fields without echoing their values", () => {
  const repository = createRepository();
  const config = validConfig();
  config.provider.token = "never-print-this-secret";
  writeFileSync(
    join(repository, "sandcastle.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", "sandcastle.json"],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("never-print-this-secret"), false);
  assert.deepEqual(JSON.parse(result.stdout), {
    category: "configuration",
    code: "CONFIG_INVALID",
    command: "validate-config",
    diagnostics: [
      {
        code: "UNKNOWN_FIELD",
        message: "Unknown field 'token'.",
        path: "/provider",
      },
    ],
    ok: false,
    version: packageMetadata.version,
  });
});

test("validate-config reports an unsupported schema as a configuration error", () => {
  const repository = createRepository();
  const config = validConfig();
  config.schemaVersion = 2;
  writeFileSync(
    join(repository, "sandcastle.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", "sandcastle.json"],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    category: "configuration",
    code: "CONFIG_INVALID",
    command: "validate-config",
    diagnostics: [
      {
        code: "UNSUPPORTED_SCHEMA",
        message: "Only schema version 1 is supported.",
        path: "/schemaVersion",
      },
    ],
    ok: false,
    version: packageMetadata.version,
  });
});

test("validate-config fails closed when an execution limit is unsafe", () => {
  const repository = createRepository();
  const config = validConfig();
  config.execution.maxTicketsPerRun = 4;
  writeFileSync(
    join(repository, "sandcastle.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", "sandcastle.json"],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [
    {
      code: "INVALID_LIMIT",
      message: "Execution limit is outside the supported safety bounds.",
      path: "/execution/maxTicketsPerRun",
    },
  ]);
});

test("validate-config requires at least one completion test command", () => {
  const repository = createRepository();
  const config = validConfig();
  config.commands.tests = [];
  writeFileSync(
    join(repository, "sandcastle.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", "sandcastle.json"],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [
    {
      code: "MISSING_TESTS",
      message: "At least one test command is required.",
      path: "/commands/tests",
    },
  ]);
});

test("validate-config rejects shell execution and interpolation", () => {
  const repository = createRepository();
  const config = validConfig();
  config.commands.tests = [
    { argv: ["bash", "-lc", "npm test && curl ${ANTHROPIC_AUTH_TOKEN}"] },
  ];
  writeFileSync(
    join(repository, "sandcastle.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", "sandcastle.json"],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout.includes("ANTHROPIC_AUTH_TOKEN"), false);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [
    {
      code: "UNSAFE_COMMAND",
      message: "Commands must be direct argv specifications without shell execution or interpolation.",
      path: "/commands/tests/0",
    },
  ]);
});

test("validate-config returns a stable infrastructure error when the file cannot be read", () => {
  const repository = createRepository();
  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", "missing.json"],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 3);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    category: "infrastructure",
    code: "INFRASTRUCTURE_ERROR",
    command: "validate-config",
    diagnostics: [
      {
        code: "CONFIG_READ_FAILED",
        message: "Unable to read project configuration.",
      },
    ],
    ok: false,
    version: packageMetadata.version,
  });
});

test("validate-config classifies malformed JSON without echoing source text", () => {
  const repository = createRepository();
  writeFileSync(
    join(repository, "sandcastle.json"),
    '{"provider":{"token":"never-print-this-secret"',
  );

  const result = spawnSync(
    process.execPath,
    [cliPath.pathname, "validate-config", "--config", "sandcastle.json"],
    { cwd: repository, encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("never-print-this-secret"), false);
  assert.deepEqual(JSON.parse(result.stdout).diagnostics, [
    {
      code: "INVALID_JSON",
      message: "Project configuration is not valid JSON.",
      path: "",
    },
  ]);
});

test("validate-config rejects missing command arguments with a stable result", () => {
  const repository = createRepository();
  const result = spawnSync(process.execPath, [cliPath.pathname, "validate-config"], {
    cwd: repository,
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    category: "configuration",
    code: "CLI_USAGE_ERROR",
    command: "validate-config",
    diagnostics: [
      {
        code: "MISSING_ARGUMENT",
        message: "validate-config requires --config <path>.",
      },
    ],
    ok: false,
    version: packageMetadata.version,
  });
});
