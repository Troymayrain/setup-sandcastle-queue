import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const strictMaven = [
  "./mvnw",
  "--batch-mode",
  "--no-transfer-progress",
  "--strict-checksums",
];

function pom(dependencyVersion = "5.11.4", pluginVersion = "3.5.2") {
  return `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>fixture</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>${dependencyVersion}</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>${pluginVersion}</version>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

function wrapperProperties(checksum = "a".repeat(64)) {
  return `distributionUrl=https\\://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.9/apache-maven-3.9.9-bin.zip
distributionSha256Sum=${checksum}
`;
}

function createJavaRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-java-adapter-"));
  execFileSync("git", ["init", "--quiet", repository]);
  mkdirSync(join(repository, ".mvn", "wrapper"), { recursive: true });
  writeFileSync(join(repository, ".java-version"), "21.0.6\n");
  writeFileSync(join(repository, "pom.xml"), pom());
  writeFileSync(
    join(repository, ".mvn", "wrapper", "maven-wrapper.properties"),
    wrapperProperties(),
  );
  writeFileSync(join(repository, "mvnw"), "#!/bin/sh\nexec mvn \"$@\"\n", {
    mode: 0o755,
  });
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return repository;
}

function config() {
  return {
    audit: { retentionDays: 30 },
    commands: {
      tests: [{ argv: [...strictMaven, "test"] }],
      verification: [
        { argv: [...strictMaven, "verify", "-DskipTests"] },
      ],
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
    runtime: {
      adapter: "java-maven",
      tools: { maven: "3.9.9" },
      version: "21.0.6",
    },
    schemaVersion: 1,
  };
}

test("java-maven fixes JDK 21 and a checksum-bound Maven Wrapper", async () => {
  const { executeRuntimeAdapter, proposeRuntime } = await import(
    "../dist/index.js"
  );
  const repository = createJavaRepository();
  const proposal = await proposeRuntime(repository);

  assert.deepEqual(proposal.runtime, {
    adapter: "java-maven",
    confirmed: false,
    signals: [
      ".java-version",
      ".mvn/wrapper/maven-wrapper.properties#distributionUrl",
    ],
    tools: { maven: "3.9.9" },
    version: "21.0.6",
  });
  assert.deepEqual(proposal.adapterPlan.bootstrap, [
    { argv: [...strictMaven, "dependency:go-offline"] },
  ]);
  assert.deepEqual(proposal.adapterPlan.networkHosts, [
    "repo.maven.apache.org",
  ]);
  assert.deepEqual(proposal.commands, config().commands);

  const calls = [];
  const runtime = {
    async run(command, phase) {
      calls.push({ command, phase });
      return { exitCode: 0, stdout: "" };
    },
  };
  const bootstrapped = await executeRuntimeAdapter(
    proposal,
    { mode: "bootstrap" },
    runtime,
  );
  assert.equal(bootstrapped.status, "completed");
  assert.deepEqual(calls.map(({ phase }) => phase), [
    "bootstrap",
    "tests",
    "verification",
  ]);

  writeFileSync(
    join(repository, ".mvn", "wrapper", "maven-wrapper.properties"),
    wrapperProperties("b".repeat(64)),
  );
  const changed = await proposeRuntime(repository);
  calls.length = 0;
  const drifted = await executeRuntimeAdapter(
    changed,
    {
      expectedEnvironmentHash: bootstrapped.environmentHash,
      mode: "continuation",
    },
    runtime,
  );
  assert.equal(drifted.status, "environment-drift");
  assert.deepEqual(calls, []);
});

test("java-maven rejects invalid wrapper checksums and non-JDK-21 runtimes", async () => {
  const { ConfigurationError, proposeRuntime } = await import("../dist/index.js");
  const checksum = createJavaRepository();
  writeFileSync(
    join(checksum, ".mvn", "wrapper", "maven-wrapper.properties"),
    wrapperProperties("not-a-sha256"),
  );
  await assert.rejects(proposeRuntime(checksum), (error) => {
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.diagnostics[0]?.code, "MAVEN_WRAPPER_CHECKSUM_INVALID");
    return true;
  });

  const java = createJavaRepository();
  writeFileSync(join(java, ".java-version"), "17.0.14\n");
  await assert.rejects(proposeRuntime(java), (error) => {
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.diagnostics[0]?.code, "JAVA_RUNTIME_INVALID");
    return true;
  });
});

test("java-maven rejects dependency and plugin snapshots or ranges", async () => {
  const { ConfigurationError, proposeRuntime } = await import("../dist/index.js");
  for (const [dependencyVersion, pluginVersion] of [
    ["5.11.4-SNAPSHOT", "3.5.2"],
    ["[5.0,6.0)", "3.5.2"],
    ["5.11.4", "[3.0,4.0)"],
  ]) {
    const repository = createJavaRepository();
    writeFileSync(
      join(repository, "pom.xml"),
      pom(dependencyVersion, pluginVersion),
    );
    await assert.rejects(proposeRuntime(repository), (error) => {
      assert.equal(error instanceof ConfigurationError, true);
      assert.equal(error.diagnostics[0]?.code, "MAVEN_VERSION_POLICY_INVALID");
      return true;
    });
  }
});

test("installer planning never writes control-plane dependencies into pom.xml", async () => {
  const { createInstallPlan } = await import("../dist/index.js");
  const repository = createJavaRepository();
  const pomPath = join(repository, "pom.xml");
  const before = readFileSync(pomPath, "utf8");
  const plan = await createInstallPlan(repository, config());

  assert.equal(plan.assets.some(({ path }) => path === "pom.xml"), false);
  assert.equal(readFileSync(pomPath, "utf8"), before);
});
