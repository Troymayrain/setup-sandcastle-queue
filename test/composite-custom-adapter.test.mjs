import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function createMixedRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-composite-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, ".python-version"), "3.12.8\n");
  writeFileSync(
    join(repository, "requirements.txt"),
    "pytest==8.3.5\nruff==0.9.3\n",
  );
  writeFileSync(join(repository, ".nvmrc"), "22.22.2\n");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        name: "mixed-fixture",
        private: true,
        engines: { node: "22.22.2" },
        scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, "package-lock.json"),
    '{"name":"mixed-fixture","lockfileVersion":3,"packages":{}}\n',
  );
  return repository;
}

function customConfig(overrides = {}) {
  const runtime = {
    adapter: "custom",
    custom: {
      bootstrap: [{ argv: ["acme-runtime", "install", "--frozen"] }],
      name: "acme-runtime",
      schemaVersion: 1,
    },
    networkHosts: ["packages.example.com"],
    version: "7.4.2",
    ...overrides,
  };
  return {
    audit: { retentionDays: 30 },
    commands: {
      tests: [{ argv: ["acme-runtime", "test"] }],
      verification: [{ argv: ["acme-runtime", "verify"] }],
    },
    execution: {
      jobTimeoutMinutes: 350,
      maxTicketsPerRun: 3,
      minimumRemainingMinutes: 140,
      processingBudgetMinutes: 300,
      ticketTimeoutMinutes: 120,
    },
    provider: {
      kind: "anthropic-compatible",
      models: { ticket: "ticket-model" },
    },
    queue: { ownershipLabel: "sandcastle", readyLabel: "ready-for-agent" },
    runtime,
    schemaVersion: 1,
  };
}

test("composite bootstraps Python and Node in confirmed order before all completion commands", async () => {
  const { executeCompositeRuntime, proposeCompositeRuntime } = await import(
    "../dist/index.js"
  );
  const repository = createMixedRepository();
  await assert.rejects(
    proposeCompositeRuntime(repository),
    (error) => error.diagnostics?.[0]?.code === "COMPOSITE_ORDER_REQUIRED",
  );
  const proposal = await proposeCompositeRuntime(repository, [
    "python-pip",
    "node-npm",
  ]);

  assert.deepEqual(
    proposal.components.map(({ runtime }) => ({
      adapter: runtime.adapter,
      version: runtime.version,
    })),
    [
      { adapter: "python-pip", version: "3.12.8" },
      { adapter: "node-npm", version: "22.22.2" },
    ],
  );
  assert.deepEqual(proposal.runtime.order, ["python-pip", "node-npm"]);

  const calls = [];
  const result = await executeCompositeRuntime(
    proposal,
    { mode: "bootstrap" },
    {
      async run(command, phase) {
        calls.push({ argv: command.argv, phase });
        return {
          exitCode: 0,
          stdout:
            phase === "environment"
              ? "pytest==8.3.5\nruff==0.9.3\n"
              : "",
        };
      },
    },
  );
  assert.equal(result.status, "completed");
  assert.match(result.environmentHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(calls, [
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
      phase: "bootstrap",
    },
    {
      argv: ["python", "-m", "pip", "freeze", "--all"],
      phase: "environment",
    },
    { argv: ["npm", "ci"], phase: "bootstrap" },
    { argv: ["python", "-m", "pytest"], phase: "tests" },
    { argv: ["npm", "test"], phase: "tests" },
    {
      argv: ["python", "-m", "ruff", "check", "."],
      phase: "verification",
    },
    { argv: ["npm", "run", "typecheck"], phase: "verification" },
  ]);

  calls.length = 0;
  const drifted = await executeCompositeRuntime(
    proposal,
    {
      expectedEnvironmentHash: result.environmentHash,
      mode: "continuation",
    },
    {
      async run(command, phase) {
        calls.push({ argv: command.argv, phase });
        return {
          exitCode: 0,
          stdout:
            phase === "environment"
              ? "pytest==8.4.0\nruff==0.9.3\n"
              : "",
        };
      },
    },
  );
  assert.equal(drifted.status, "environment-drift");
  assert.deepEqual(calls, [
    {
      argv: ["python", "-m", "pip", "freeze", "--all"],
      phase: "environment",
    },
  ]);
});

test("composite stops on the first adapter or completion command failure", async () => {
  const {
    InfrastructureError,
    executeCompositeRuntime,
    proposeCompositeRuntime,
  } = await import("../dist/index.js");
  const proposal = await proposeCompositeRuntime(createMixedRepository(), [
    "python-pip",
    "node-npm",
  ]);
  for (const failingArgv of ["npm ci", "npm test"]) {
    const calls = [];
    await assert.rejects(
      executeCompositeRuntime(proposal, { mode: "bootstrap" }, {
        async run(command, phase) {
          calls.push(command.argv.join(" "));
          return {
            exitCode: command.argv.join(" ") === failingArgv ? 7 : 0,
            stdout:
              phase === "environment"
                ? "pytest==8.3.5\nruff==0.9.3\n"
                : "",
          };
        },
      }),
      (error) => {
        assert.equal(error instanceof InfrastructureError, true);
        return true;
      },
    );
    assert.equal(calls.includes("npm run typecheck"), false);
  }
});

test("composite rejects unconfirmed order and component version conflicts", async () => {
  const { ConfigurationError, proposeCompositeRuntime } = await import(
    "../dist/index.js"
  );
  const repository = createMixedRepository();
  await assert.rejects(
    proposeCompositeRuntime(repository, ["node-npm", "go-module"]),
    (error) => {
      assert.equal(error instanceof ConfigurationError, true);
      assert.equal(error.diagnostics[0]?.code, "COMPOSITE_ORDER_INVALID");
      return true;
    },
  );

  const packagePath = join(repository, "package.json");
  const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
  packageMetadata.engines.node = "20.19.4";
  writeFileSync(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);
  await assert.rejects(
    proposeCompositeRuntime(repository, ["python-pip", "node-npm"]),
    (error) => {
      assert.equal(error instanceof ConfigurationError, true);
      assert.equal(error.diagnostics[0]?.code, "RUNTIME_VERSION_CONFLICT");
      return true;
    },
  );
});

test("composite config records ordered exact component versions under schema v1", async () => {
  const { ConfigurationError, validateProjectConfig } = await import(
    "../dist/index.js"
  );
  const candidate = customConfig();
  candidate.runtime = {
    adapter: "composite",
    composite: {
      adapters: [
        { adapter: "python-pip", version: "3.12.8" },
        { adapter: "node-npm", version: "22.22.2" },
      ],
      schemaVersion: 1,
    },
    version: "1.0.0",
  };
  assert.equal(validateProjectConfig(candidate), candidate);

  candidate.runtime.composite.schemaVersion = 2;
  assert.throws(
    () => validateProjectConfig(candidate),
    (error) => {
      assert.equal(error instanceof ConfigurationError, true);
      assert.equal(
        error.diagnostics[0]?.code,
        "UNSUPPORTED_COMPOSITE_ADAPTER_SCHEMA",
      );
      return true;
    },
  );
});

test("versioned custom adapter declares exact bootstrap, commands, and hosts", async () => {
  const {
    createCustomRuntimeProposal,
    executeRuntimeAdapter,
    validateProjectConfig,
  } = await import("../dist/index.js");
  const config = validateProjectConfig(customConfig());
  const proposal = createCustomRuntimeProposal(config);

  assert.deepEqual(proposal, {
    adapterPlan: {
      bootstrap: [{ argv: ["acme-runtime", "install", "--frozen"] }],
      environment: { inputs: [] },
      networkHosts: ["packages.example.com"],
    },
    commands: {
      tests: [{ argv: ["acme-runtime", "test"] }],
      verification: [{ argv: ["acme-runtime", "verify"] }],
    },
    runtime: {
      adapter: "custom",
      confirmed: true,
      signals: [".sandcastle/config.json#runtime.custom"],
      version: "7.4.2",
    },
  });
  const calls = [];
  const result = await executeRuntimeAdapter(
    proposal,
    { mode: "bootstrap" },
    {
      async run(command, phase) {
        calls.push({ command, phase });
        return { exitCode: 0, stdout: "" };
      },
    },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map(({ phase }) => phase), [
    "bootstrap",
    "tests",
    "verification",
  ]);
});

test("custom adapter rejects wildcard/IP hosts, host networking, sockets, and unsafe commands", async () => {
  const { ConfigurationError, validateProjectConfig } = await import(
    "../dist/index.js"
  );
  const unsafe = [
    customConfig({ networkHosts: ["*.example.com"] }),
    customConfig({ networkHosts: ["10.0.0.0/8"] }),
    customConfig({
      custom: {
        bootstrap: [{ argv: ["docker", "run", "--network=host", "image"] }],
        name: "acme-runtime",
        schemaVersion: 1,
      },
    }),
    customConfig({
      custom: {
        bootstrap: [
          {
            argv: [
              "docker",
              "run",
              "--volume",
              "/var/run/docker.sock:/var/run/docker.sock",
              "image",
            ],
          },
        ],
        name: "acme-runtime",
        schemaVersion: 1,
      },
    }),
  ];
  const shell = customConfig();
  shell.commands.tests = [{ argv: ["sh", "-c", "acme-runtime test"] }];
  unsafe.push(shell);

  for (const candidate of unsafe) {
    assert.throws(
      () => validateProjectConfig(candidate),
      (error) => {
        assert.equal(error instanceof ConfigurationError, true);
        assert.equal(
          error.diagnostics.some(({ code }) =>
            [
              "CUSTOM_ADAPTER_UNSAFE",
              "SANDBOX_HOST_INVALID",
              "UNSAFE_COMMAND",
            ].includes(code),
          ),
          true,
        );
        return true;
      },
    );
  }
});
