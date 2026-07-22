import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const baseSha = "b".repeat(40);
const candidateSha = "a".repeat(40);
const gateId = "batch-9900-aaaaaaaaaaaa";
const legacyDogfood = {
  reportSha256: "c".repeat(64),
  runId: "9800",
};
const parentIssue = 200;
const releaseVersion = "0.1.0";
const repository = "sandcastle-dogfood/real-project";
const tickets = [201, 202, 203];

function ticketEvidence(issueNumber, order, dependencies, suffix) {
  return {
    contextId: `context-${issueNumber}`,
    dependencies,
    implementationCount: 1,
    issueNumber,
    order,
    publicationCount: 1,
    publishedCommit: suffix.repeat(40),
    runId: `990${order}`,
    sessionId: `session-${issueNumber}`,
    skills: {
      "code-review": "1".repeat(64),
      implement: "2".repeat(64),
      tdd: "3".repeat(64),
    },
  };
}

function evidence() {
  return {
    audit: {
      artifactId: "9930",
      commentId: "9931",
      containsRawTranscript: false,
      containsSecrets: false,
      eventCount: 18,
      links: {
        commits: 4,
        issues: 4,
        pullRequests: 1,
        runs: 9,
        sessions: 3,
        skills: 9,
      },
      sanitized: true,
      timelineSha256: "4".repeat(64),
    },
    baseSha,
    candidateSha,
    checks: {
      auditTimelineComplete: true,
      cumulativeFinalReview: true,
      manualEnrollment: true,
      nativeDependencies: true,
      newParentPrd: true,
      noDuplicateImplementation: true,
      noDuplicatePublication: true,
      processing: true,
      recoverySemantics: true,
    },
    continuation: {
      checkpointElapsedSeconds: 21_000,
      continuationRunId: "9911",
      predecessorRunId: "9910",
      stateSha256: "5".repeat(64),
      verified: true,
    },
    finalReview: {
      cumulative: true,
      findingsAfterPath: 0,
      findingsBeforePath: 1,
      path: "final-fix",
      pathCommit: "6".repeat(40),
      pathRunId: "9920",
      pullRequestNumber: 250,
      readyHead: "6".repeat(40),
      reviewedHead: "7".repeat(40),
      specEvidenceSha256: "8".repeat(64),
      standardsEvidenceSha256: "9".repeat(64),
    },
    gateId,
    parentIssue,
    prerequisite: {
      legacyDogfoodReportSha256: legacyDogfood.reportSha256,
      legacyDogfoodRunId: legacyDogfood.runId,
    },
    recoveries: {
      firstTicket: {
        failureRunId: "9940",
        implementationCount: 1,
        publicationCount: 1,
        recoveryRunId: "9941",
        strategy: "resume",
        ticket: tickets[0],
      },
      pushBeforeClosure: {
        closureCount: 1,
        implementationCount: 1,
        publicationCount: 1,
        publishedCommit: "e".repeat(40),
        recoveryRunId: "9942",
        ticket: tickets[1],
      },
    },
    releaseVersion,
    repository,
    run: {
      conclusion: "success",
      event: "workflow_dispatch",
      id: "9901",
      url: `https://github.com/${repository}/actions/runs/9901`,
    },
    schemaVersion: 1,
    tickets: [
      ticketEvidence(tickets[0], 1, [], "d"),
      ticketEvidence(tickets[1], 2, [tickets[0]], "e"),
      ticketEvidence(tickets[2], 3, [tickets[0], tickets[1]], "f"),
    ],
  };
}

function input() {
  return {
    actorPermission: "maintain",
    baseSha,
    candidateSha,
    evidence: evidence(),
    gateId,
    legacyDogfood,
    parentIssue,
    releaseVersion,
    repository,
    tickets,
  };
}

const manualEnvironment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_JOB: "batch-dogfood-gate",
  GITHUB_RUN_ID: "9900",
};

test("manual gate accepts dependency-ordered three-ticket Batch dogfood evidence", async () => {
  const { evaluateBatchDogfoodGate } = await import("../dist/index.js");
  const result = evaluateBatchDogfoodGate(input(), manualEnvironment);

  assert.equal(result.ok, true);
  assert.equal(result.baseSha, baseSha);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.gateId, gateId);
  assert.equal(result.parentIssue, parentIssue);
  assert.equal(result.releaseVersion, releaseVersion);
  assert.equal(result.repository, repository);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.tickets.map(
      ({ issueNumber, order, publishedCommit, sessionId }) => ({
        issueNumber,
        order,
        publishedCommit,
        sessionId,
      }),
    ),
    [
      {
        issueNumber: 201,
        order: 1,
        publishedCommit: "d".repeat(40),
        sessionId: "session-201",
      },
      {
        issueNumber: 202,
        order: 2,
        publishedCommit: "e".repeat(40),
        sessionId: "session-202",
      },
      {
        issueNumber: 203,
        order: 3,
        publishedCommit: "f".repeat(40),
        sessionId: "session-203",
      },
    ],
  );
  assert.equal(result.finalReview?.path, "final-fix");
  assert.equal(result.audit?.timelineSha256, "4".repeat(64));
});

test("Batch dogfood gate fails closed outside its manual job or for a non-maintainer", async () => {
  const { evaluateBatchDogfoodGate } = await import("../dist/index.js");
  const wrongContext = evaluateBatchDogfoodGate(input(), {
    ...manualEnvironment,
    GITHUB_EVENT_NAME: "push",
  });
  const unauthorized = input();
  unauthorized.actorPermission = "write";
  const wrongActor = evaluateBatchDogfoodGate(unauthorized, manualEnvironment);

  assert.deepEqual(
    wrongContext.diagnostics.map(({ code }) => code),
    ["BATCH_DOGFOOD_CONTEXT_INVALID"],
  );
  assert.deepEqual(
    wrongActor.diagnostics.map(({ code }) => code),
    ["BATCH_DOGFOOD_MAINTAINER_REQUIRED"],
  );
});

test("Batch dogfood gate rejects duplicate work, late checkpoints, unsafe audit, and stale prerequisites", async () => {
  const { evaluateBatchDogfoodGate } = await import("../dist/index.js");
  const invalid = input();
  invalid.evidence = {
    ...invalid.evidence,
    audit: {
      ...invalid.evidence.audit,
      containsRawTranscript: true,
    },
    continuation: {
      ...invalid.evidence.continuation,
      checkpointElapsedSeconds: 21_600,
    },
    prerequisite: {
      ...invalid.evidence.prerequisite,
      legacyDogfoodReportSha256: "0".repeat(64),
    },
    tickets: [
      invalid.evidence.tickets[0],
      {
        ...invalid.evidence.tickets[1],
        publicationCount: 2,
        publishedCommit: invalid.evidence.tickets[0].publishedCommit,
        sessionId: invalid.evidence.tickets[0].sessionId,
      },
      invalid.evidence.tickets[2],
    ],
    upstreamError: "provider-token-from-dogfood",
  };

  const result = evaluateBatchDogfoodGate(invalid, manualEnvironment);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["BATCH_DOGFOOD_EVIDENCE_INVALID"],
  );
  assert.equal(JSON.stringify(result).includes("provider-token-from-dogfood"), false);
  assert.deepEqual(result.tickets, []);
  assert.equal(result.audit, null);
  assert.equal(result.finalReview, null);
});

test("Batch dogfood workflow is manual-only and requires the legacy dogfood prerequisite", () => {
  const workflow = readFileSync(
    new URL(
      "../.github/workflows/batch-dogfood-release-gate.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const trigger = workflow.match(/\non:\n([\s\S]*?)\npermissions:/u)?.[1] ?? "";

  assert.match(trigger, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(trigger, /^  (?:pull_request|push|schedule):/mu);
  assert.match(workflow, /\npermissions: \{\}\n/u);
  assert.match(workflow, /environment: release-batch-dogfood/u);
  assert.match(workflow, /legacy_dogfood_run_id/u);
  assert.match(workflow, /Sandcastle legacy lifecycle dogfood gate/u);
  assert.match(workflow, /secrets\.BATCH_DOGFOOD_DISPATCH_TOKEN/u);
  assert.match(workflow, /sandcastle-batch-dogfood\.yml/u);
  assert.match(workflow, /verify-batch-dogfood/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(
    workflow,
    /target_ref="\$\(gh api "repos\/\$\{DOGFOOD_REPOSITORY\}" --jq \.default_branch\)"/u,
  );
  assert.match(workflow, /\[\[ -z "\$target_ref" \]\]/u);
  assert.match(workflow, /--ref "\$target_ref"/u);
  assert.doesNotMatch(workflow, /--ref main/u);
  assert.match(
    workflow,
    /sandcastle-batch-dogfood-\$\{\{ inputs\.candidate_sha \}\}/u,
  );
});
