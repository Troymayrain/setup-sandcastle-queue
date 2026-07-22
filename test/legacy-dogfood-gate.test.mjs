import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const baselineSha = "b".repeat(40);
const candidateSha = "a".repeat(40);
const gateId = "legacy-9800-aaaaaaaaaaaa";
const releaseVersion = "0.1.0";
const repository = "sandcastle-dogfood/legacy-real";

function evidence() {
  return {
    baselineSha,
    candidateSha,
    checks: {
      adopt: true,
      codeReviewPatchMigrated: true,
      failureAtomicity: true,
      integrationPullRequestsResolved: true,
      legacyWorkflowQuiescent: true,
      localDoctor: true,
      managedDriftConflict: true,
      remoteDoctor: true,
      rollback: true,
      skillExtensionsMigrated: true,
      upstreamSnapshotsRestored: true,
      upgrade: true,
    },
    findings: [],
    gateId,
    gitEffects: {
      automaticCommits: 0,
      automaticPushes: 0,
      automaticResets: 0,
      automaticStashes: 0,
    },
    identities: {
      adoptPlanHash: "c".repeat(64),
      remoteDoctorArtifactId: "980103",
      rollbackPlanHash: "d".repeat(64),
      upgradePlanHash: "e".repeat(64),
    },
    operationCounts: {
      adopt: 1,
      managedDriftConflict: 1,
      rollback: 1,
      upgrade: 1,
    },
    release: {
      installerPackageSha256: "f".repeat(64),
      releaseManifestSha256: "1".repeat(64),
      skillSnapshotSha256: "2".repeat(64),
      version: releaseVersion,
    },
    repository,
    run: {
      conclusion: "success",
      event: "workflow_dispatch",
      id: "9801",
      url: `https://github.com/${repository}/actions/runs/9801`,
    },
    schemaVersion: 1,
    stateHashes: {
      failedApplyAfter: "3".repeat(64),
      failedApplyBefore: "3".repeat(64),
      managedDriftAfter: "4".repeat(64),
      managedDriftBefore: "4".repeat(64),
      rollbackActual: "5".repeat(64),
      rollbackExpected: "5".repeat(64),
    },
  };
}

function input() {
  return {
    actorPermission: "maintain",
    baselineSha,
    candidateSha,
    evidence: evidence(),
    gateId,
    releaseVersion,
    repository,
  };
}

const manualEnvironment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_JOB: "legacy-dogfood-gate",
  GITHUB_RUN_ID: "9800",
};

test("manual maintainer gate accepts release-bound legacy lifecycle evidence", async () => {
  const { evaluateLegacyDogfoodGate } = await import("../dist/index.js");
  const result = evaluateLegacyDogfoodGate(input(), manualEnvironment);

  assert.equal(result.ok, true);
  assert.equal(result.baselineSha, baselineSha);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.gateId, gateId);
  assert.equal(result.releaseVersion, releaseVersion);
  assert.equal(result.repository, repository);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.run, {
    id: "9801",
    url: `https://github.com/${repository}/actions/runs/9801`,
  });
});

test("legacy dogfood gate fails closed outside its manual job or for a non-maintainer", async () => {
  const { evaluateLegacyDogfoodGate } = await import("../dist/index.js");
  const wrongContext = evaluateLegacyDogfoodGate(input(), {
    ...manualEnvironment,
    GITHUB_EVENT_NAME: "pull_request",
  });
  const unauthorized = input();
  unauthorized.actorPermission = "write";
  const wrongActor = evaluateLegacyDogfoodGate(
    unauthorized,
    manualEnvironment,
  );

  assert.deepEqual(
    wrongContext.diagnostics.map(({ code }) => code),
    ["LEGACY_DOGFOOD_CONTEXT_INVALID"],
  );
  assert.deepEqual(
    wrongActor.diagnostics.map(({ code }) => code),
    ["LEGACY_DOGFOOD_MAINTAINER_REQUIRED"],
  );
});

test("legacy dogfood gate rejects partial state, automatic git effects, and unreleased findings", async () => {
  const { evaluateLegacyDogfoodGate } = await import("../dist/index.js");
  const invalid = input();
  invalid.evidence = {
    ...invalid.evidence,
    findings: [
      {
        code: "DOGFOOD-ADOPT-1",
        fixedInRelease: "0.2.0",
        issueNumber: 101,
        reverified: true,
      },
    ],
    gitEffects: {
      ...invalid.evidence.gitEffects,
      automaticPushes: 1,
    },
    stateHashes: {
      ...invalid.evidence.stateHashes,
      failedApplyAfter: "9".repeat(64),
    },
    upstreamError: "token-from-target-workflow",
  };

  const result = evaluateLegacyDogfoodGate(invalid, manualEnvironment);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["LEGACY_DOGFOOD_EVIDENCE_INVALID"],
  );
  assert.equal(JSON.stringify(result).includes("token-from-target-workflow"), false);
  assert.deepEqual(result.findings, []);
  assert.equal(result.run, null);
});

test("legacy dogfood workflow is manual-only, dispatches one target, and cannot mutate git history", () => {
  const workflow = readFileSync(
    new URL(
      "../.github/workflows/legacy-dogfood-release-gate.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const trigger = workflow.match(/\non:\n([\s\S]*?)\npermissions:/u)?.[1] ?? "";

  assert.match(trigger, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(trigger, /^  (?:pull_request|push|schedule):/mu);
  assert.match(workflow, /\npermissions: \{\}\n/u);
  assert.match(workflow, /environment: release-legacy-dogfood/u);
  assert.match(workflow, /secrets\.LEGACY_DOGFOOD_DISPATCH_TOKEN/u);
  assert.match(workflow, /sandcastle-legacy-dogfood\.yml/u);
  assert.match(workflow, /verify-legacy-dogfood/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(
    workflow,
    /target_ref="\$\(gh api "repos\/\$\{LEGACY_REPOSITORY\}" --jq \.default_branch\)"/u,
  );
  assert.match(workflow, /\[\[ -z "\$target_ref" \]\]/u);
  assert.match(workflow, /--ref "\$target_ref"/u);
  assert.doesNotMatch(workflow, /--ref main/u);
  assert.match(
    workflow,
    /sandcastle-legacy-dogfood-\$\{\{ inputs\.candidate_sha \}\}/u,
  );
  assert.doesNotMatch(workflow, /git\s+(?:commit|push|reset|stash)\b/u);
});
