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
  assert.match(workflow, /docker build/u);
  assert.match(workflow, /run-credentialless-fixture/u);
  assert.match(workflow, /verify-fixture-matrix/u);
});
