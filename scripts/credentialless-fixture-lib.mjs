import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const officialMavenWrapper334 = readFileSync(
  join(projectRoot, "assets", "runtime", "maven-wrapper-3.3.4", "mvnw"),
  "utf8",
);
const forbiddenCredentialNames = [
  "ANTHROPIC_AUTH_TOKEN",
  "LIVE_E2E_DISPATCH_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "SANDCASTLE_RELEASE_TOKEN",
];

function git(repository, arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
  }).trim();
}

function commonConfig(runtime, commands) {
  return {
    audit: { retentionDays: 30 },
    commands,
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

function writeNode(repository, name) {
  writeFileSync(join(repository, ".nvmrc"), "22.22.2\n");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        engines: { node: "22.22.2" },
        name,
        private: true,
        scripts: {
          test: "node --test",
          typecheck: "node --check index.js",
        },
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        name,
        packages: { "": { name } },
        requires: true,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repository, "index.js"), "export const fixture = true;\n");
}

function writePythonPip(repository) {
  writeFileSync(join(repository, ".python-version"), "3.12.8\n");
  writeFileSync(
    join(repository, "requirements.txt"),
    "pytest==8.3.5\nruff==0.9.3\n",
  );
  writeFileSync(
    join(repository, "test_fixture.py"),
    "def test_fixture():\n    assert True\n",
  );
}

function writePythonUv(repository) {
  writeFileSync(join(repository, ".python-version"), "3.12.8\n");
  writeFileSync(
    join(repository, "pyproject.toml"),
    `[project]
name = "fixture"
version = "1.0.0"
requires-python = "==3.12.8"
dependencies = []

[project.scripts]
pytest = "fixture:pytest_main"
ruff = "fixture:ruff_main"
`,
  );
  writeFileSync(
    join(repository, "fixture.py"),
    `def pytest_main():
    return 0

def ruff_main():
    return 0
`,
  );
}

function writeGo(repository) {
  writeFileSync(
    join(repository, "go.mod"),
    "module example.com/fixture\n\ngo 1.23.4\n\ntoolchain go1.23.4\n",
  );
  writeFileSync(
    join(repository, "fixture.go"),
    "package fixture\n\nfunc Value() int { return 1 }\n",
  );
  writeFileSync(
    join(repository, "fixture_test.go"),
    "package fixture\n\nimport \"testing\"\n\nfunc TestValue(t *testing.T) { if Value() != 1 { t.Fail() } }\n",
  );
}

function writeJava(repository) {
  mkdirSync(join(repository, ".mvn", "wrapper"), { recursive: true });
  writeFileSync(join(repository, ".java-version"), "21.0.6\n");
  writeFileSync(
    join(repository, ".mvn", "wrapper", "maven-wrapper.properties"),
    `distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip
distributionSha256Sum=4ec3f26fb1a692473aea0235c300bd20f0f9fe741947c82c1234cefd76ac3a3c
`,
  );
  writeFileSync(
    join(repository, "mvnw"),
    officialMavenWrapper334,
  );
  chmodSync(join(repository, "mvnw"), 0o755);
  mkdirSync(join(repository, "src", "test", "java", "com", "example"), {
    recursive: true,
  });
  writeFileSync(
    join(repository, "pom.xml"),
    `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>fixture</artifactId>
  <version>1.0.0</version>
  <properties><maven.compiler.release>21</maven.compiler.release></properties>
</project>
`,
  );
}

function writeCustomRuntime(repository) {
  mkdirSync(join(repository, "bin"), { recursive: true });
  const executable = join(repository, "bin", "acme-runtime");
  writeFileSync(
    executable,
    `#!/bin/sh
set -eu
case "\${1:-}" in
  install)
    test "\${2:-}" = "--frozen"
    : > .acme-runtime-installed
    ;;
  test|verify)
    test -f .acme-runtime-installed
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  chmodSync(executable, 0o755);
}

function writeLegacyInstallation(repository) {
  const workflowDirectory = join(repository, ".github", "workflows");
  mkdirSync(workflowDirectory, { recursive: true });
  writeFileSync(
    join(workflowDirectory, "sandcastle.yml"),
    "name: Legacy Sandcastle\non:\n  workflow_dispatch:\n",
  );
}

function commandArguments(command) {
  if (Array.isArray(command)) return command;
  if (command && Array.isArray(command.argv)) return command.argv;
  throw new TypeError("A command argv array is required.");
}

export function runObservedProcess(command, context = {}) {
  const argv = commandArguments(command);
  const completed = spawnSync(argv[0], argv.slice(1), {
    cwd: context.cwd,
    encoding: "utf8",
    env: context.environment,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  return {
    exitCode: completed.status ?? 1,
    stdout: completed.stdout ?? "",
  };
}

function assertCommandSucceeded(result, boundary) {
  if (
    !result ||
    !Number.isInteger(result.exitCode) ||
    result.exitCode !== 0 ||
    typeof result.stdout !== "string"
  ) {
    throw new Error(`The credentialless ${boundary} command failed.`);
  }
}

async function observed(runner, command, context, boundary) {
  const result = await runner(command, context);
  assertCommandSucceeded(result, boundary);
  return result;
}

async function createFixture(fixture, api, runtimeRunner, environment) {
  const repository = mkdtempSync(join(tmpdir(), `sandcastle-${fixture}-`));
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync("git", [
    "-C",
    repository,
    "remote",
    "add",
    "origin",
    `https://github.com/sandcastle-fixtures/${fixture}.git`,
  ]);
  writeFileSync(join(repository, "README.md"), `# ${fixture}\n`);

  let config;
  let proposal;
  if (fixture === "mixed-python-pip-node-npm") {
    writePythonPip(repository);
    writeNode(repository, "mixed-fixture");
    proposal = await api.proposeCompositeRuntime(repository, [
      "python-pip",
      "node-npm",
    ]);
    config = commonConfig(
      {
        adapter: "composite",
        composite: {
          adapters: proposal.runtime.components.map(
            ({ adapter, tools, version }) => ({
              adapter,
              ...(tools ? { tools } : {}),
              version,
            }),
          ),
          schemaVersion: 1,
        },
        version: proposal.runtime.version,
      },
      proposal.commands,
    );
  } else if (fixture === "python-uv") {
    writePythonUv(repository);
    await observed(
      runtimeRunner,
      ["uv", "lock", "--offline"],
      { cwd: repository, environment, phase: "fixture-prepare" },
      "runtime",
    );
    proposal = await api.proposeRuntime(repository);
    config = commonConfig(
      { adapter: "python-uv", version: proposal.runtime.version },
      proposal.commands,
    );
  } else if (fixture === "go-module") {
    writeGo(repository);
    proposal = await api.proposeRuntime(repository);
    config = commonConfig(
      { adapter: "go-module", version: proposal.runtime.version },
      proposal.commands,
    );
  } else if (fixture === "java-maven") {
    writeJava(repository);
    proposal = await api.proposeRuntime(repository);
    config = commonConfig(
      {
        adapter: "java-maven",
        tools: proposal.runtime.tools,
        version: proposal.runtime.version,
      },
      proposal.commands,
    );
  } else if (fixture === "custom") {
    writeCustomRuntime(repository);
    config = commonConfig(
      {
        adapter: "custom",
        custom: {
          bootstrap: [{ argv: ["acme-runtime", "install", "--frozen"] }],
          name: "acme-runtime",
          schemaVersion: 1,
        },
        networkHosts: ["packages.example.com"],
        version: "7.4.2",
      },
      {
        tests: [{ argv: ["acme-runtime", "test"] }],
        verification: [{ argv: ["acme-runtime", "verify"] }],
      },
    );
    proposal = api.createCustomRuntimeProposal(config);
  } else {
    writeNode(repository, `${fixture}-fixture`);
    proposal = await api.proposeRuntime(repository);
    config = commonConfig(
      { adapter: "node-npm", version: proposal.runtime.version },
      proposal.commands,
    );
  }

  if (fixture === "adopt") writeLegacyInstallation(repository);

  git(repository, ["add", "."]);
  git(repository, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return { config, proposal, repository };
}

function installationEvidence(fixture) {
  if (fixture === "existing-install") {
    return { operation: "reinstall", startingState: "managed" };
  }
  if (fixture === "adopt") {
    return { operation: "adopt", startingState: "unmanaged" };
  }
  if (fixture === "upgrade") {
    return { operation: "upgrade", startingState: "managed" };
  }
  return { operation: "install", startingState: "fresh" };
}

async function applyFreshInstall(repository, config, api) {
  const plan = await api.createInstallPlan(repository, config);
  if (plan.installationState !== "fresh") {
    throw new Error("The credentialless fresh install did not start fresh.");
  }
  const result = await api.applyInstallPlan(repository, plan, plan.planHash);
  if (!result.changed || result.filesWritten.length === 0) {
    throw new Error("The credentialless install did not write managed assets.");
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function prepareUpgradeSource(repository) {
  const workflowPath = join(
    repository,
    ".github",
    "workflows",
    "sandcastle.yml",
  );
  const manifestPath = join(repository, ".sandcastle", "installation.json");
  const legacyWorkflow =
    "# Managed by setup-sandcastle-queue 0.9.0.\nname: Sandcastle Queue 0.9.0\non:\n  workflow_dispatch:\npermissions: {}\n";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(workflowPath, legacyWorkflow);
  manifest.installerVersion = "0.9.0";
  manifest.templateVersion = "0.9.0";
  manifest.managedAssets[".github/workflows/sandcastle.yml"].sha256 =
    sha256(legacyWorkflow);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function startAdoptionContractServer() {
  const repository = "sandcastle-fixtures/adopt";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const workflowPrefix =
      `/repos/${repository}/actions/workflows/sandcastle.yml/runs?status=`;
    if (request.url?.startsWith(workflowPrefix)) {
      response.end('{"total_count":0,"workflow_runs":[]}');
      return;
    }
    if (request.url === `/repos/${repository}/pulls?state=open&per_page=100&page=1`) {
      response.end("[]");
      return;
    }
    response.statusCode = 404;
    response.end('{"message":"Not Found"}');
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function applyFixtureInstallation(
  fixture,
  repository,
  config,
  api,
  environment,
) {
  if (fixture === "existing-install") {
    await applyFreshInstall(repository, config, api);
    const plan = await api.createInstallPlan(repository, config);
    const result = await api.applyInstallPlan(repository, plan, plan.planHash);
    if (
      plan.installationState !== "managed" ||
      plan.patch !== "" ||
      result.changed ||
      result.filesWritten.length !== 0
    ) {
      throw new Error("The existing-install fixture did not exercise a managed reinstall.");
    }
    return;
  }

  if (fixture === "adopt") {
    const contractServer = await startAdoptionContractServer();
    try {
      const preview = await api.createAdoptionPreview(
        repository,
        config,
        [],
        {
          ...environment,
          GITHUB_API_URL: contractServer.apiUrl,
          GITHUB_TOKEN: "credentialless-local-contract-token",
        },
      );
      const result = await api.applyAdoptPlan(
        repository,
        preview.plan,
        preview.plan.planHash,
      );
      if (
        preview.plan.installationState !== "unmanaged" ||
        !result.changed ||
        result.filesWritten.length === 0
      ) {
        throw new Error("The adopt fixture did not migrate an unmanaged installation.");
      }
    } finally {
      await contractServer.close();
    }
    return;
  }

  if (fixture === "upgrade") {
    await applyFreshInstall(repository, config, api);
    prepareUpgradeSource(repository);
    const preview = await api.createUpgradePreview(repository, "1.0.0");
    const result = await api.applyUpgradePlan(
      repository,
      preview.plan,
      preview.plan.planHash,
    );
    if (
      preview.plan.installationState !== "managed" ||
      preview.plan.upgrade?.fromInstallerVersion !== "0.9.0" ||
      preview.conflicts.length !== 0 ||
      !preview.updates.some(
        ({ path }) => path === ".github/workflows/sandcastle.yml",
      ) ||
      !result.changed
    ) {
      throw new Error("The upgrade fixture did not replace an older managed release.");
    }
    return;
  }

  await applyFreshInstall(repository, config, api);
}

function runtimeEnvironment(repository, environment) {
  const result = { ...environment };
  for (const name of forbiddenCredentialNames) delete result[name];
  result.PATH = `${join(repository, "bin")}:${environment.PATH ?? ""}`;
  return result;
}

async function executeProposal(
  fixture,
  repository,
  proposal,
  api,
  runtimeRunner,
  environment,
) {
  const runnerEnvironment = runtimeEnvironment(repository, environment);
  const runtime = {
    async run(command, phase, index) {
      return runtimeRunner(command, {
        cwd: repository,
        environment: runnerEnvironment,
        index,
        phase,
      });
    },
  };
  const executed =
    fixture === "mixed-python-pip-node-npm"
      ? await api.executeCompositeRuntime(proposal, { mode: "bootstrap" }, runtime)
      : await api.executeRuntimeAdapter(proposal, { mode: "bootstrap" }, runtime);
  if (executed.status !== "completed") {
    throw new Error("The credentialless runtime did not complete.");
  }
  const executions =
    fixture === "mixed-python-pip-node-npm"
      ? executed.components.flatMap((component) => component.executions)
      : executed.executions;
  for (const phase of ["bootstrap", "tests", "verification"]) {
    if (!executions.some((execution) => execution.phase === phase)) {
      throw new Error(`The credentialless runtime omitted ${phase}.`);
    }
  }
}

async function runDockerFixture(_command, context) {
  const tag = `sandcastle-fixture:${context.fixture}-${process.pid}-${Date.now()}`;
  const build = runObservedProcess(
    [
      "docker",
      "build",
      "--build-arg",
      `FIXTURE=${context.fixture}`,
      "--tag",
      tag,
      "--file",
      "test/fixtures/Dockerfile",
      ".",
    ],
    { cwd: projectRoot, environment: context.environment },
  );
  if (build.exitCode !== 0) return build;
  const executed = runObservedProcess(
    [
      "docker",
      "run",
      "--rm",
      "--mount",
      `type=bind,src=${context.repository},dst=/workspace,readonly`,
      "--workdir",
      "/workspace",
      tag,
      "doctor",
      "--config",
      ".sandcastle/config.json",
      "--offline",
    ],
    { cwd: projectRoot, environment: context.environment },
  );
  runObservedProcess(["docker", "image", "rm", tag], {
    cwd: projectRoot,
    environment: context.environment,
  });
  return executed;
}

async function runContractObservations(_command, context) {
  const suites = [
    "test/audit.test.mjs",
    "test/frontier.test.mjs",
    "test/sandbox-policy.test.mjs",
  ];
  if (context.fixture === "existing-install") {
    suites.push("test/installer-apply.test.mjs");
  } else if (context.fixture === "adopt") {
    suites.push("test/adopt.test.mjs");
  } else if (context.fixture === "upgrade") {
    suites.push("test/upgrade.test.mjs");
  }
  return runObservedProcess([process.execPath, "--test", ...suites], {
    cwd: projectRoot,
    environment: context.environment,
  });
}

function recordStep(steps, id) {
  steps.push({ id, status: "pass" });
}

export async function runCredentiallessFixtureLifecycle(options) {
  const {
    candidateSha,
    fixture,
    output,
    environment = process.env,
    runtimeRunner = runObservedProcess,
    containerRunner = runDockerFixture,
    observationRunner = runContractObservations,
  } = options;
  const api = await import("../dist/index.js");
  if (!api.CREDENTIALLESS_FIXTURE_IDS.includes(fixture)) {
    throw new Error("A supported credentialless fixture is required.");
  }
  if (!/^[a-f0-9]{40}$/u.test(candidateSha) || !output) {
    throw new Error("Candidate SHA and output are required.");
  }
  rmSync(output, { force: true });
  if (forbiddenCredentialNames.some((name) => Boolean(environment[name]))) {
    throw new Error("Credentialless fixture execution received a forbidden credential.");
  }
  const steps = [];
  let repository;
  try {
    const fixtureState = await createFixture(
      fixture,
      api,
      runtimeRunner,
      environment,
    );
    ({ repository } = fixtureState);
    const { config, proposal } = fixtureState;

    const installation = installationEvidence(fixture);
    await applyFixtureInstallation(
      fixture,
      repository,
      config,
      api,
      environment,
    );
    recordStep(steps, "install");

    const offline = await api.doctor(repository, undefined, {}, { mode: "offline" });
    if (!offline.ok || offline.mode !== "offline") {
      throw new Error("The credentialless offline doctor failed.");
    }
    recordStep(steps, "offline-doctor");

    const reinstall = await api.createInstallPlan(repository, config);
    const reinstalled = await api.applyInstallPlan(
      repository,
      reinstall,
      reinstall.planHash,
    );
    if (
      reinstall.installationState !== "managed" ||
      reinstall.patch !== "" ||
      reinstalled.changed ||
      reinstalled.filesWritten.length !== 0
    ) {
      throw new Error("The credentialless reinstall was not zero-diff.");
    }
    recordStep(steps, "zero-diff-reinstall");

    git(repository, ["add", "."]);
    git(repository, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "install control plane",
    ]);
    const before = git(repository, ["rev-parse", "HEAD"]);

    await observed(
      containerRunner,
      ["fixture-container", fixture],
      { environment, fixture, repository },
      "container",
    );
    recordStep(steps, "container-build");

    await executeProposal(
      fixture,
      repository,
      proposal,
      api,
      runtimeRunner,
      environment,
    );
    recordStep(steps, "bootstrap");
    recordStep(steps, "tests");
    recordStep(steps, "verification");

    const configPath = join(repository, ".sandcastle", "config.json");
    const configSource = readFileSync(configPath, "utf8");
    writeFileSync(configPath, `${configSource.trimEnd()} \n`);
    let protectedPathRejected = false;
    try {
      await api.checkProtectedPaths(repository, before);
    } catch (error) {
      protectedPathRejected =
        error instanceof api.ConfigurationError &&
        error.diagnostics.some(
          ({ code, path }) =>
            code === "PROTECTED_PATH_MODIFIED" &&
            path === ".sandcastle/config.json",
        );
    }
    writeFileSync(configPath, configSource);
    if (!protectedPathRejected) {
      throw new Error("The credentialless protected-path gate did not reject drift.");
    }
    recordStep(steps, "protected-path-gate");

    const workflowPath = join(
      repository,
      ".github",
      "workflows",
      "sandcastle.yml",
    );
    const workflow = readFileSync(workflowPath, "utf8");
    writeFileSync(workflowPath, `${workflow}# fixture drift\n`);
    const conflicted = await api.createUpgradePreview(repository, "1.0.0");
    writeFileSync(workflowPath, workflow);
    if (
      !conflicted.conflicts.some(
        ({ path }) => path === ".github/workflows/sandcastle.yml",
      )
    ) {
      throw new Error("The credentialless upgrade did not detect managed drift.");
    }
    recordStep(steps, "upgrade-conflict");

    const manifestPath = join(
      repository,
      ".sandcastle",
      "installation.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.installerVersion = "0.2.0";
    manifest.templateVersion = "2.0.0";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const rollback = await api.createRollbackPreview(repository, "1.0.0");
    await api.applyRollbackPlan(
      repository,
      rollback.plan,
      rollback.plan.planHash,
    );
    if (
      JSON.parse(readFileSync(manifestPath, "utf8")).installerVersion !==
      "1.0.0"
    ) {
      throw new Error("The credentialless rollback did not restore the release.");
    }
    recordStep(steps, "rollback");

    await observed(
      observationRunner,
      ["credentialless-contract-observations", fixture],
      { environment, fixture },
      "contract observation",
    );

    if (
      steps.length !== api.FIXTURE_LIFECYCLE_STEPS.length ||
      steps.some(({ id }, index) => id !== api.FIXTURE_LIFECYCLE_STEPS[index])
    ) {
      throw new Error("The credentialless lifecycle evidence is incomplete.");
    }
    const evidence = {
      candidateSha,
      fixture,
      installation,
      observations: {
        audit: true,
        repository: true,
        sandbox: true,
        tracker: true,
      },
      schemaVersion: 1,
      steps,
      usedCredentials: false,
    };
    mkdirSync(dirname(output), { recursive: true });
    const temporaryOutput = join(
      dirname(output),
      `.${randomUUID()}.credentialless-evidence.tmp`,
    );
    writeFileSync(temporaryOutput, `${JSON.stringify(evidence)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryOutput, output);
    return evidence;
  } finally {
    if (repository) rmSync(repository, { force: true, recursive: true });
  }
}
