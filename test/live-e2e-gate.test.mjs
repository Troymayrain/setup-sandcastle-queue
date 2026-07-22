import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const candidateSha = "a".repeat(40);
const gateId = "live-9400-aaaaaaaaaaaa";

function target(kind, repository) {
  return { fixture: kind, repository };
}

function evidence(kind, repository, runId) {
  const expectedAdapter = kind === "python" ? "python-pip" : "java-maven";
  return {
    audit: {
      artifactId: `${runId}01`,
      commentId: `${runId}02`,
    },
    candidateSha,
    checks: {
      actions: true,
      broker: true,
      draftPullRequest: true,
      issueClosure: true,
      protectedPathMutationRejected: true,
      provider: true,
      remoteDoctor: true,
      runtimeSkills: true,
      sandboxHasGitHubToken: false,
      sandboxHasLongLivedProviderToken: false,
      tests: true,
      verification: true,
    },
    fixture: kind,
    gateId,
    identities: {
      issueNumber: 17,
      pullRequestNumber: 19,
      publishedCommit: "b".repeat(40),
      remoteDoctorArtifactId: `${runId}03`,
      runtimeEnvironmentHash: "c".repeat(64),
      skillHashes: {
        "code-review": "d".repeat(64),
        implement: "e".repeat(64),
        tdd: "f".repeat(64),
      },
    },
    repository,
    run: {
      conclusion: "success",
      event: "workflow_dispatch",
      id: runId,
      url: `https://github.com/${repository}/actions/runs/${runId}`,
    },
    runtimeAdapter: expectedAdapter,
    schemaVersion: 1,
  };
}

function input() {
  return {
    actorPermission: "maintain",
    candidateSha,
    evidence: [
      evidence("python", "sandcastle-fixtures/python-live", "9401"),
      evidence("java-maven", "sandcastle-fixtures/java-live", "9402"),
    ],
    gateId,
    targets: [
      target("python", "sandcastle-fixtures/python-live"),
      target("java-maven", "sandcastle-fixtures/java-live"),
    ],
  };
}

const manualEnvironment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_JOB: "live-e2e-gate",
  GITHUB_RUN_ID: "9400",
};

test("manual maintainer gate accepts candidate-bound Python and Java live evidence", async () => {
  const { evaluateLiveE2EReleaseGate } = await import("../dist/index.js");
  const result = evaluateLiveE2EReleaseGate(input(), manualEnvironment);

  assert.equal(result.ok, true);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.gateId, gateId);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.fixtures.map(({ fixture, repository }) => ({ fixture, repository })),
    [
      { fixture: "python", repository: "sandcastle-fixtures/python-live" },
      { fixture: "java-maven", repository: "sandcastle-fixtures/java-live" },
    ],
  );
  assert.equal(result.fixtures.every(({ checks }) => checks.remoteDoctor), true);
  assert.equal(
    result.fixtures.every(
      ({ checks }) =>
        !checks.sandboxHasGitHubToken &&
        !checks.sandboxHasLongLivedProviderToken &&
        checks.protectedPathMutationRejected,
    ),
    true,
  );
});

test("gate fails closed outside the dedicated manual job or for a non-maintainer", async () => {
  const { evaluateLiveE2EReleaseGate } = await import("../dist/index.js");
  const pullRequestResult = evaluateLiveE2EReleaseGate(input(), {
    ...manualEnvironment,
    GITHUB_EVENT_NAME: "pull_request",
  });
  const nonMaintainerInput = input();
  nonMaintainerInput.actorPermission = "write";
  const nonMaintainerResult = evaluateLiveE2EReleaseGate(
    nonMaintainerInput,
    manualEnvironment,
  );

  assert.equal(pullRequestResult.ok, false);
  assert.deepEqual(
    pullRequestResult.diagnostics.map(({ code }) => code),
    ["LIVE_E2E_CONTEXT_INVALID"],
  );
  assert.equal(nonMaintainerResult.ok, false);
  assert.deepEqual(
    nonMaintainerResult.diagnostics.map(({ code }) => code),
    ["LIVE_E2E_MAINTAINER_REQUIRED"],
  );
});

test("gate rejects incomplete, mismatched, or unsafe fixture evidence without retaining untrusted text", async () => {
  const { evaluateLiveE2EReleaseGate } = await import("../dist/index.js");
  const secret = "provider-token-from-upstream-error";
  const invalid = input();
  invalid.evidence[0] = {
    ...invalid.evidence[0],
    candidateSha: "9".repeat(40),
    upstreamError: secret,
  };
  invalid.evidence[1].checks.sandboxHasGitHubToken = true;

  const result = evaluateLiveE2EReleaseGate(invalid, manualEnvironment);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map(({ code, fixture }) => ({ code, fixture })),
    [
      { code: "LIVE_E2E_EVIDENCE_INVALID", fixture: "python" },
      { code: "LIVE_E2E_EVIDENCE_INVALID", fixture: "java-maven" },
    ],
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(result.fixtures, []);
});

test("release gate workflow is manual-only and isolates live secrets from ordinary CI", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/live-e2e-release-gate.yml", import.meta.url),
    "utf8",
  );
  const trigger = workflow.match(/\non:\n([\s\S]*?)\npermissions:/u)?.[1] ?? "";

  assert.match(trigger, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(trigger, /^  (?:pull_request|push|schedule):/mu);
  assert.match(workflow, /\npermissions: \{\}\n/u);
  assert.match(workflow, /environment: release-live-e2e/u);
  assert.match(workflow, /secrets\.LIVE_E2E_DISPATCH_TOKEN/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /verify-live-e2e/u);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(workflow, /sandcastle-live-e2e-\$\{\{ inputs\.candidate_sha \}\}/u);
});
