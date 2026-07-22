import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const candidateSha = "7".repeat(40);
const environment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_JOB: "credentialless-gate",
  GITHUB_RUN_ID: "9500",
};

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

test("credentialless gate requires every fixture lifecycle and API contract capability", async () => {
  const {
    ANTHROPIC_CONTRACT_CAPABILITIES,
    CREDENTIALLESS_FIXTURE_IDS,
    FIXTURE_LIFECYCLE_STEPS,
    GITHUB_CONTRACT_CAPABILITIES,
    evaluateCredentiallessFixtureMatrix,
  } = await import("../dist/index.js");
  const input = {
    candidateSha,
    contracts: {
      anthropic: [...ANTHROPIC_CONTRACT_CAPABILITIES],
      candidateSha,
      github: [...GITHUB_CONTRACT_CAPABILITIES],
    },
    evidence: CREDENTIALLESS_FIXTURE_IDS.map((fixture) => ({
      candidateSha,
      fixture,
      installation: installationEvidence(fixture),
      observations: {
        audit: true,
        repository: true,
        sandbox: true,
        tracker: true,
      },
      schemaVersion: 1,
      steps: FIXTURE_LIFECYCLE_STEPS.map((id) => ({ id, status: "pass" })),
      usedCredentials: false,
    })),
    schemaVersion: 1,
  };

  const result = evaluateCredentiallessFixtureMatrix(input, environment);

  assert.equal(result.ok, true);
  assert.equal(result.candidateSha, candidateSha);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.fixtures.map(({ fixture }) => fixture),
    CREDENTIALLESS_FIXTURE_IDS,
  );
  assert.deepEqual(result.contracts, input.contracts);
});

test("credentialless gate rejects missing steps, unknown evidence, and exposed secrets without echoing payloads", async () => {
  const {
    ANTHROPIC_CONTRACT_CAPABILITIES,
    CREDENTIALLESS_FIXTURE_IDS,
    FIXTURE_LIFECYCLE_STEPS,
    GITHUB_CONTRACT_CAPABILITIES,
    evaluateCredentiallessFixtureMatrix,
  } = await import("../dist/index.js");
  const secret = "release-secret-must-not-be-retained";
  const evidence = CREDENTIALLESS_FIXTURE_IDS.map((fixture) => ({
    candidateSha,
    fixture,
    installation: installationEvidence(fixture),
    observations: {
      audit: true,
      repository: true,
      sandbox: true,
      tracker: true,
    },
    schemaVersion: 1,
    steps: FIXTURE_LIFECYCLE_STEPS.map((id) => ({ id, status: "pass" })),
    usedCredentials: false,
  }));
  evidence[0] = {
    ...evidence[0],
    upstreamError: secret,
  };
  evidence[1].steps = evidence[1].steps.slice(1);
  evidence.at(-1).installation = {
    operation: "install",
    startingState: "fresh",
  };
  const input = {
    candidateSha,
    contracts: {
      anthropic: [...ANTHROPIC_CONTRACT_CAPABILITIES],
      candidateSha,
      github: [...GITHUB_CONTRACT_CAPABILITIES],
    },
    evidence,
    schemaVersion: 1,
  };

  const invalid = evaluateCredentiallessFixtureMatrix(input, environment);
  const exposed = evaluateCredentiallessFixtureMatrix(input, {
    ...environment,
    ANTHROPIC_AUTH_TOKEN: secret,
  });

  assert.equal(invalid.ok, false);
  assert.deepEqual(
    invalid.diagnostics.slice(0, 2).map(({ code, fixture }) => ({
      code,
      fixture,
    })),
    [
      {
        code: "CREDENTIALLESS_FIXTURE_EVIDENCE_INVALID",
        fixture: CREDENTIALLESS_FIXTURE_IDS[0],
      },
      {
        code: "CREDENTIALLESS_FIXTURE_EVIDENCE_INVALID",
        fixture: CREDENTIALLESS_FIXTURE_IDS[1],
      },
    ],
  );
  assert.equal(JSON.stringify(invalid).includes(secret), false);
  assert.deepEqual(exposed.diagnostics.map(({ code }) => code), [
    "CREDENTIALLESS_CI_SECRET_EXPOSED",
  ]);
  assert.equal(JSON.stringify(exposed).includes(secret), false);
});

test("ordinary PR CI exposes no live or release secret and executes the full fixture matrix", async () => {
  const { CREDENTIALLESS_FIXTURE_IDS } = await import("../dist/index.js");
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const lifecycle = readFileSync(
    new URL("../scripts/credentialless-fixture-lib.mjs", import.meta.url),
    "utf8",
  );
  const dockerfile = readFileSync(
    new URL("fixtures/Dockerfile", import.meta.url),
    "utf8",
  );
  const contractRunner = readFileSync(
    new URL("../scripts/run-contract-ci.mjs", import.meta.url),
    "utf8",
  );
  const trigger = workflow.match(/\non:\n([\s\S]*?)\npermissions:/u)?.[1] ?? "";

  assert.match(trigger, /^  pull_request:/mu);
  assert.match(trigger, /^  push:/mu);
  assert.doesNotMatch(workflow, /secrets\./u);
  assert.doesNotMatch(workflow, /\n    environment:/u);
  assert.doesNotMatch(
    workflow,
    /ANTHROPIC_AUTH_TOKEN|LIVE_E2E_DISPATCH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN/u,
  );
  for (const fixture of CREDENTIALLESS_FIXTURE_IDS) {
    assert.equal(workflow.includes(`- ${fixture}`), true, fixture);
  }
  assert.match(workflow, /run-credentialless-fixture/u);
  assert.doesNotMatch(workflow, /SANDCASTLE_FIXTURE_CONTAINER_BUILT/u);
  assert.match(lifecycle, /"docker",\s*"build"/u);
  assert.match(lifecycle, /"docker",\s*"run"/u);
  assert.doesNotMatch(dockerfile, /\/bin\/true/u);
  assert.match(dockerfile, /dist\/cli\.js/u);
  assert.match(lifecycle, /dst=\/workspace,readonly/u);
  assert.match(lifecycle, /"doctor",\s*"--config"/u);
  assert.match(workflow, /python-version: 3\.12\.8/u);
  assert.match(workflow, /go-version: 1\.23\.4/u);
  assert.match(workflow, /java-version: 21\.0\.6/u);
  assert.match(workflow, /verify-fixture-matrix/u);
  for (const suite of [
    "test/api-contract-ci.test.mjs",
    "test/credential-broker.test.mjs",
    "test/frontier.test.mjs",
    "test/ticket-publish.test.mjs",
  ]) {
    assert.equal(contractRunner.includes(suite), true, suite);
  }
});
