import assert from "node:assert/strict";
import test from "node:test";

import {
  renderFinalFixMarker,
  renderFinalRereviewMarker,
} from "../dist/final-review-facts.js";
import { orchestrateFinalRereview } from "../dist/final-rereview.js";

const fixedHead = "2".repeat(40);
const baseHead = "b".repeat(40);
const rereviewFinding = {
  line: 9,
  path: "src/recovery.ts",
  problem: "The fix still skips the backup gate.",
  requiredFix: "Require the backup gate before recovery.",
};

function options() {
  return {
    baseBranch: "main",
    commands: {
      bootstrap: [{ argv: ["fixture", "bootstrap"] }],
      test: [{ argv: ["fixture", "test"] }],
      verification: [{ argv: ["fixture", "verify"] }],
    },
    environment: {
      ANTHROPIC_AUTH_TOKEN: "provider-secret",
      ANTHROPIC_BASE_URL: "https://provider.example",
      GITHUB_RUN_ID: "9004",
      GITHUB_TOKEN: "github-secret",
    },
    expectedHead: fixedHead,
    integrationBranch: "sandcastle/integration",
    model: "review-model",
    predecessorRunId: "9003",
    promptFile: "/queue/final-review.md",
  };
}

function fixture({
  currentHead = fixedHead,
  findings,
  sessionId = "rereview-session-1",
  verdict = "pass",
} = {}) {
  findings ??= verdict === "needs-fix" ? [rereviewFinding] : [];
  const events = [];
  const comments = [{
    body: renderFinalFixMarker({
      afterHead: fixedHead,
      beforeHead: "1".repeat(40),
      reviewRunId: "9002",
      runId: "9003",
      schemaVersion: 1,
      sessionId: "fix-session-1",
      type: "sandcastle-final-fix",
    }),
    id: 72,
  }];
  const boundary = {
    async createFinalRereviewMarker(pullRequest, marker) {
      events.push(["marker", pullRequest, marker]);
      comments.push({ body: renderFinalRereviewMarker(marker), id: 73 });
      return { id: 73 };
    },
    async createTemporaryMerge(input) {
      events.push(["merge", input]);
      return {
        baseHead,
        integrationHead: currentHead,
        path: "/temporary/rereview",
        async includes() {
          return true;
        },
        async remove() {
          events.push(["remove"]);
        },
        async unchanged() {
          return true;
        },
      };
    },
    async dispatchContinuation(payload) {
      events.push(["continue", payload]);
    },
    async listIntegrationPullRequests() {
      return [{
        draft: true,
        nodeId: "PR_node_17",
        number: 17,
        state: "open",
        url: "https://example.invalid/pr/17",
      }];
    },
    async listIssueComments() {
      return structuredClone(comments);
    },
    async markPullRequestReady(nodeId) {
      events.push(["ready", nodeId]);
    },
    async remoteHead(branch) {
      return branch === "main" ? baseHead : currentHead;
    },
    async runCommand(path, argv, environment) {
      events.push(["command", path, argv, environment]);
    },
  };
  const frontiers = [
    { activated: [], reason: "empty", status: "waiting" },
    { activated: [], reason: "empty", status: "waiting" },
  ];
  const select = async () => frontiers.shift();
  const runWorkUnit = async (input) => ({
    branch: "temporary",
    commits: [],
    role: "final-rereview",
    sessionId,
    status: "complete",
    streamSummary: { jsonLines: 1, lineCount: 1, textLines: 0 },
    findings,
    verdict,
  });
  return { boundary, events, frontiers, runWorkUnit, select };
}

test("independent Final Rereview publishes a pass marker and marks the PR ready", async () => {
  const state = fixture();

  const result = await orchestrateFinalRereview(
    options(),
    state.boundary,
    state.select,
    state.runWorkUnit,
  );

  assert.deepEqual(result, {
    baseHead,
    integrationHead: fixedHead,
    markerCommentId: 73,
    pullRequest: 17,
    sessionId: "rereview-session-1",
    status: "ready-for-human-review",
    verdict: "pass",
  });
  assert.equal(state.events.some(([name]) => name === "ready"), true);
});

test("failed rereview records needs-fix and never authorizes a second automatic fix", async () => {
  const state = fixture({ verdict: "needs-fix" });

  const result = await orchestrateFinalRereview(
    options(),
    state.boundary,
    state.select,
    state.runWorkUnit,
  );

  assert.equal(result.status, "needs-human-review");
  assert.equal(state.events.some(([name]) => name === "ready"), false);
  assert.deepEqual(
    state.events.find(([name]) => name === "marker")[2].findings,
    [rereviewFinding],
  );
  assert.equal(
    state.events.some(([name]) => /fix/iu.test(name)),
    false,
  );
});

test("Rereview resumes after late Ticket commits that descend from the Final Fix", async () => {
  const laterHead = "4".repeat(40);
  const state = fixture({ currentHead: laterHead });
  const resumed = options();
  resumed.expectedHead = laterHead;
  resumed.predecessorRunId = "9005";

  const result = await orchestrateFinalRereview(
    resumed,
    state.boundary,
    state.select,
    state.runWorkUnit,
  );

  assert.equal(result.status, "ready-for-human-review");
  assert.equal(result.integrationHead, laterHead);
  const marker = state.events.find(([name]) => name === "marker")[2];
  assert.equal(marker.integrationHead, laterHead);
  assert.equal(marker.fixRunId, "9003");
});

test("fixing session cannot approve itself and a late Ticket suppresses rereview marker", async () => {
  const sameSession = fixture({ sessionId: "fix-session-1" });
  await assert.rejects(
    orchestrateFinalRereview(
      options(),
      sameSession.boundary,
      sameSession.select,
      sameSession.runWorkUnit,
    ),
    /independent/u,
  );
  assert.equal(sameSession.events.some(([name]) => name === "marker"), false);

  const late = fixture();
  late.frontiers[1] = {
    activated: [],
    body: "late Ticket",
    status: "ready",
    ticket: 64,
  };
  assert.deepEqual(
    await orchestrateFinalRereview(
      options(),
      late.boundary,
      late.select,
      late.runWorkUnit,
    ),
    { status: "processing", ticket: 64 },
  );
  assert.equal(late.events.some(([name]) => name === "continue"), true);
  assert.equal(late.events.some(([name]) => name === "marker"), false);
});
