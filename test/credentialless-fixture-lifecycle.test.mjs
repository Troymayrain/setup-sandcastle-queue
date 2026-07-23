import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { runCredentiallessFixtureLifecycle } from "../scripts/credentialless-fixture-lib.mjs";

const candidateSha = "7".repeat(40);

function actualNodeCommand(exitCode) {
  return () => {
    const completed = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `process.exit(${exitCode})`],
      { encoding: "utf8" },
    );
    return {
      exitCode: completed.status ?? 1,
      stdout: completed.stdout ?? "",
    };
  };
}

function credentiallessEnvironment(bin) {
  const environment = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  for (const name of [
    "ANTHROPIC_AUTH_TOKEN",
    "LIVE_E2E_DISPATCH_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "SANDCASTLE_RELEASE_TOKEN",
  ]) {
    delete environment[name];
  }
  return environment;
}

test("credentialless Node fixture records only observed lifecycle steps", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-fixture-success-"));
  const output = join(directory, "evidence.json");

  await runCredentiallessFixtureLifecycle({
    candidateSha,
    containerRunner: actualNodeCommand(0),
    fixture: "node-npm",
    observationRunner: actualNodeCommand(0),
    output,
  });

  const evidence = JSON.parse(readFileSync(output, "utf8"));
  const { FIXTURE_LIFECYCLE_STEPS } = await import("../dist/index.js");
  assert.deepEqual(
    evidence.steps,
    FIXTURE_LIFECYCLE_STEPS.map((id) => ({ id, status: "pass" })),
  );
  assert.equal(evidence.fixture, "node-npm");
  assert.deepEqual(evidence.installation, {
    operation: "install",
    startingState: "fresh",
  });
  assert.equal(evidence.usedCredentials, false);
});

test("credentialless fixture container runs as the host repository owner", async () => {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  ) {
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-fixture-user-"));
  const output = join(directory, "evidence.json");
  const dockerLog = join(directory, "docker.log");
  const bin = join(directory, "bin");
  const docker = join(bin, "docker");
  mkdirSync(bin);
  writeFileSync(dockerLog, "");
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\n' "$*" >> "$SANDCASTLE_DOCKER_LOG"
`,
  );
  chmodSync(docker, 0o755);
  const environment = {
    ...credentiallessEnvironment(bin),
    SANDCASTLE_DOCKER_LOG: dockerLog,
  };

  await runCredentiallessFixtureLifecycle({
    candidateSha,
    environment,
    fixture: "node-npm",
    observationRunner: actualNodeCommand(0),
    output,
    runtimeRunner: actualNodeCommand(0),
  });

  const dockerRun = readFileSync(dockerLog, "utf8")
    .split("\n")
    .find((line) => line.startsWith("run "));
  assert.match(
    dockerRun,
    new RegExp(
      `(?:^| )--user ${process.getuid()}:${process.getgid()}(?: |$)`,
      "u",
    ),
  );
});

test("python-uv fixture executes its offline test and verification shims", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-fixture-uv-"));
  const output = join(directory, "evidence.json");
  const bin = join(directory, "bin");
  const uv = join(bin, "uv");
  mkdirSync(bin);
  writeFileSync(
    uv,
    `#!/bin/sh
set -eu
case "$1" in
  lock)
    test "$2" = "--offline"
    printf '%s\n' \
      'version = 1' \
      '[[package]]' \
      'name = "fixture"' \
      'version = "1.0.0"' > uv.lock
    ;;
  sync)
    test "$2" = "--frozen"
    test -x bin/pytest
    test -x bin/ruff
    ;;
  run)
    test "$2" = "--frozen"
    shift 2
    exec "$@"
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  chmodSync(uv, 0o755);
  const environment = credentiallessEnvironment(bin);

  const evidence = await runCredentiallessFixtureLifecycle({
    candidateSha,
    containerRunner: actualNodeCommand(0),
    environment,
    fixture: "python-uv",
    observationRunner: actualNodeCommand(0),
    output,
  });

  assert.equal(evidence.fixture, "python-uv");
});

test("go-module fixture starts from a tidy module manifest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-fixture-go-"));
  const output = join(directory, "evidence.json");
  const bin = join(directory, "bin");
  const go = join(bin, "go");
  mkdirSync(bin);
  writeFileSync(
    go,
    `#!/bin/sh
set -eu
case "$1" in
  mod)
    case "$2" in
      download)
        ;;
      verify)
        printf '%s\n' "all modules verified"
        ;;
      *)
        exit 2
        ;;
    esac
    ;;
  test|vet)
    test "$2" = "./..."
    ! grep -q '^toolchain ' go.mod
    ;;
  *)
    exit 2
    ;;
esac
`,
  );
  chmodSync(go, 0o755);
  const environment = credentiallessEnvironment(bin);

  const evidence = await runCredentiallessFixtureLifecycle({
    candidateSha,
    containerRunner: actualNodeCommand(0),
    environment,
    fixture: "go-module",
    observationRunner: actualNodeCommand(0),
    output,
  });

  assert.equal(evidence.fixture, "go-module");
});

test("credentialless lifecycle fixtures exercise existing, adoption, and upgrade states", async () => {
  const scenarios = [
    ["existing-install", { operation: "reinstall", startingState: "managed" }],
    ["adopt", { operation: "adopt", startingState: "unmanaged" }],
    ["upgrade", { operation: "upgrade", startingState: "managed" }],
  ];

  for (const [fixture, installation] of scenarios) {
    const directory = mkdtempSync(join(tmpdir(), `sandcastle-fixture-${fixture}-`));
    const output = join(directory, "evidence.json");
    const evidence = await runCredentiallessFixtureLifecycle({
      candidateSha,
      containerRunner: actualNodeCommand(0),
      fixture,
      observationRunner: actualNodeCommand(0),
      output,
    });
    assert.deepEqual(evidence.installation, installation, fixture);
  }
});

for (const boundary of ["container", "runtime", "observations"]) {
  test(`credentialless fixture leaves no pass evidence when the ${boundary} command fails`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `sandcastle-fixture-${boundary}-`));
    const output = join(directory, "evidence.json");
    writeFileSync(output, '{"stale":"pass"}\n');

    await assert.rejects(
      runCredentiallessFixtureLifecycle({
        candidateSha,
        containerRunner:
          boundary === "container"
            ? actualNodeCommand(17)
            : actualNodeCommand(0),
        fixture: "node-npm",
        observationRunner:
          boundary === "observations"
            ? actualNodeCommand(19)
            : actualNodeCommand(0),
        output,
        ...(boundary === "runtime"
          ? { runtimeRunner: actualNodeCommand(18) }
          : {}),
      }),
    );

    assert.equal(existsSync(output), false);
  });
}
