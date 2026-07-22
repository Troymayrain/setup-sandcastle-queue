import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixtureIds = [
  "mixed-python-pip-node-npm",
  "python-uv",
  "node-npm",
  "go-module",
  "java-maven",
  "custom",
  "existing-install",
  "adopt",
  "upgrade",
];

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], {
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
  writeFileSync(join(repository, "test_fixture.py"), "def test_fixture():\n    assert True\n");
}

function writePythonUv(repository) {
  writeFileSync(join(repository, ".python-version"), "3.12.8\n");
  writeFileSync(
    join(repository, "pyproject.toml"),
    `[project]
name = "fixture"
version = "1.0.0"
requires-python = "==3.12.8"
dependencies = ["pytest==8.3.5", "ruff==0.9.3"]
`,
  );
  writeFileSync(
    join(repository, "uv.lock"),
    `version = 1
revision = 1
requires-python = "==3.12.8"

[[package]]
name = "fixture"
version = "1.0.0"

[[package]]
name = "pytest"
version = "8.3.5"

[[package]]
name = "ruff"
version = "0.9.3"
`,
  );
  writeFileSync(join(repository, "test_fixture.py"), "def test_fixture():\n    assert True\n");
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
    `distributionUrl=https\\://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip
distributionSha256Sum=${"a".repeat(64)}
`,
  );
  writeFileSync(join(repository, "mvnw"), "#!/bin/sh\nexec mvn \"$@\"\n");
  chmodSync(join(repository, "mvnw"), 0o755);
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

async function createFixture(fixture, api) {
  const repository = mkdtempSync(join(tmpdir(), `sandcastle-${fixture}-`));
  execFileSync("git", ["init", "--quiet", repository]);
  execFileSync("git", ["-C", repository, "remote", "add", "origin", `https://github.com/sandcastle-fixtures/${fixture}.git`]);
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

async function executeProposal(fixture, proposal, api) {
  const phases = [];
  const runtime = {
    async run(_command, phase) {
      phases.push(phase);
      return {
        exitCode: 0,
        stdout:
          phase === "environment"
            ? "pytest==8.3.5\nruff==0.9.3\n"
            : "",
      };
    },
  };
  const executed =
    fixture === "mixed-python-pip-node-npm"
      ? await api.executeCompositeRuntime(proposal, { mode: "bootstrap" }, runtime)
      : await api.executeRuntimeAdapter(proposal, { mode: "bootstrap" }, runtime);
  assert.equal(executed.status, "completed");
  assert.equal(phases.includes("bootstrap"), true);
  assert.equal(phases.includes("tests"), true);
  assert.equal(phases.includes("verification"), true);
}

for (const fixture of fixtureIds) {
  test(`credentialless fixture ${fixture} completes the observable lifecycle`, async () => {
    const api = await import("../dist/index.js");
    const { config, proposal, repository } = await createFixture(fixture, api);

    const install = await api.createInstallPlan(repository, config);
    const installed = await api.applyInstallPlan(
      repository,
      install,
      install.planHash,
    );
    assert.equal(installed.changed, true);
    assert.equal(installed.filesWritten.length > 0, true);

    const offline = await api.doctor(repository, undefined, {}, { mode: "offline" });
    assert.equal(offline.ok, true, JSON.stringify(offline.diagnostics));
    assert.equal(offline.mode, "offline");

    const reinstall = await api.createInstallPlan(repository, config);
    assert.equal(reinstall.installationState, "managed");
    assert.equal(reinstall.patch, "");
    const reinstalled = await api.applyInstallPlan(
      repository,
      reinstall,
      reinstall.planHash,
    );
    assert.equal(reinstalled.changed, false);
    assert.deepEqual(reinstalled.filesWritten, []);

    await executeProposal(fixture, proposal, api);

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
    const configPath = join(repository, ".sandcastle", "config.json");
    const configSource = readFileSync(configPath, "utf8");
    writeFileSync(configPath, `${configSource.trimEnd()} \n`);
    await assert.rejects(
      api.checkProtectedPaths(repository, before),
      (error) =>
        error instanceof api.ConfigurationError &&
        error.diagnostics.some(
          ({ code, path }) =>
            code === "PROTECTED_PATH_MODIFIED" &&
            path === ".sandcastle/config.json",
        ),
    );
    writeFileSync(configPath, configSource);

    const workflowPath = join(repository, ".github", "workflows", "sandcastle.yml");
    const workflow = readFileSync(workflowPath, "utf8");
    writeFileSync(workflowPath, `${workflow}# fixture drift\n`);
    const conflicted = await api.createUpgradePreview(repository, "0.1.0");
    assert.equal(
      conflicted.conflicts.some(
        ({ path }) => path === ".github/workflows/sandcastle.yml",
      ),
      true,
    );
    writeFileSync(workflowPath, workflow);

    const manifestPath = join(repository, ".sandcastle", "installation.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.installerVersion = "0.2.0";
    manifest.templateVersion = "2.0.0";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const rollback = await api.createRollbackPreview(repository, "0.1.0");
    assert.equal(rollback.plan.rollback.fromInstallerVersion, "0.2.0");
    await api.applyRollbackPlan(repository, rollback.plan, rollback.plan.planHash);
    assert.equal(
      JSON.parse(readFileSync(manifestPath, "utf8")).installerVersion,
      "0.1.0",
    );
  });
}
