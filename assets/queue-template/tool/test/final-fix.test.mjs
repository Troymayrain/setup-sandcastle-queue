import assert from "node:assert/strict";
import test from "node:test";

import {
  renderFinalFixMarker,
  renderFinalReviewMarker,
} from "../dist/final-review-facts.js";
import { orchestrateFinalFix } from "../dist/final-fix.js";

const reviewedHead = "1".repeat(40);
const fixedHead = "2".repeat(40);

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
      GITHUB_RUN_ID: "9003",
      GITHUB_TOKEN: "github-secret",
    },
    expectedHead: reviewedHead,
    integrationBranch: "sandcastle/integration",
    model: "fix-model",
    predecessorRunId: "9002",
    promptFile: "/queue/final-fix.md",
    repository: "/repository",
  };
}

function fixture() {
  const events = [];
  const comments = [{
    body: renderFinalReviewMarker({
      baseHead: "b".repeat(40),
      integrationHead: reviewedHead,
      runId: "9002",
      schemaVersion: 1,
      type: "sandcastle-final-review",
      verdict: "needs-fix",
    }),
    id: 71,
  }];
  let remoteHead = reviewedHead;
  const boundary = {
    async checkoutIntegration(branch, head) {
      events.push(["checkout", branch, head]);
    },
    async commitParents(head) {
      events.push(["parents", head]);
      return [reviewedHead];
    },
    async createFinalFixMarker(pullRequest, marker) {
      events.push(["marker", pullRequest, marker]);
      comments.push({ body: renderFinalFixMarker(marker), id: 72 });
      return { id: 72 };
    },
    async dispatchContinuation(payload) {
      events.push(["continue", payload]);
    },
    async dispatchFinalRereview(payload) {
      events.push(["rereview", payload]);
    },
    async isClean() {
      events.push(["clean"]);
      return true;
    },
    async listIntegrationPullRequests(input) {
      events.push(["pulls", input]);
      return [{
        draft: true,
        nodeId: "PR_node_17",
        number: 17,
        state: "open",
        url: "https://example.invalid/pr/17",
      }];
    },
    async listIssueComments(issue) {
      events.push(["comments", issue]);
      return structuredClone(comments);
    },
    async localHead() {
      events.push(["localHead"]);
      return fixedHead;
    },
    async pushIntegration(branch, before, after) {
      events.push(["push", branch, before, after]);
      remoteHead = after;
      return after;
    },
    async remoteHead() {
      events.push(["head"]);
      return remoteHead;
    },
    async runCommand(argv, environment) {
      events.push(["command", argv, environment]);
    },
  };
  const frontiers = [
    { activated: [], reason: "empty", status: "waiting" },
    { activated: [], reason: "empty", status: "waiting" },
  ];
  const select = async () => {
    events.push(["frontier"]);
    return frontiers.shift();
  };
  const runWorkUnit = async (input) => {
    events.push(["fix", input]);
    return {
      branch: "sandcastle/integration",
      commits: [fixedHead],
      role: "final-fix",
      sessionId: "fix-session-1",
      status: "complete",
      streamSummary: { jsonLines: 1, lineCount: 1, textLines: 0 },
    };
  };
  return { boundary, comments, events, frontiers, runWorkUnit, select };
}

test("authorized Final Fix publishes one new HEAD and dispatches independent rereview", async () => {
  const state = fixture();

  const result = await orchestrateFinalFix(
    options(),
    state.boundary,
    state.select,
    state.runWorkUnit,
  );

  assert.deepEqual(result, {
    beforeHead: reviewedHead,
    completionCommit: fixedHead,
    markerCommentId: 72,
    pullRequest: 17,
    sessionId: "fix-session-1",
    status: "final-rereview-dispatched",
  });
  assert.deepEqual(
    state.events.filter(([name]) => name === "command").map(([, argv]) => argv),
    [
      ["fixture", "bootstrap"],
      ["fixture", "test"],
      ["fixture", "verify"],
    ],
  );
  assert.deepEqual(state.events.at(-1), [
    "rereview",
    {
      inputs: {
        expected_head: fixedHead,
        operation: "final-rereview",
        predecessor_run_id: "9003",
      },
      ref: "main",
    },
  ]);
});

test("an unproven Final Fix push stops before marker and Rereview dispatch", async () => {
  const state = fixture();
  state.boundary.pushIntegration = async (branch, before, after) => {
    state.events.push(["push", branch, before, after]);
    return before;
  };

  await assert.rejects(
    orchestrateFinalFix(
      options(),
      state.boundary,
      state.select,
      state.runWorkUnit,
    ),
    /verification failed after push/u,
  );
  assert.equal(
    state.events.some(([name]) => ["marker", "rereview"].includes(name)),
    false,
  );
});

test("a Final Fix commit handoff failure identifies the rejected proof", async () => {
  const state = fixture();
  state.boundary.localHead = async () => reviewedHead;

  await assert.rejects(
    orchestrateFinalFix(
      options(),
      state.boundary,
      state.select,
      state.runWorkUnit,
    ),
    /Final Fix commit proof failed: head-not-advanced/u,
  );
  assert.equal(
    state.events.some(([name]) => ["push", "marker", "rereview"].includes(name)),
    false,
  );
});

test("stale or already-consumed Final Fix authorization cannot write", async () => {
  const stale = fixture();
  const staleOptions = options();
  staleOptions.predecessorRunId = "8999";
  assert.equal(
    (await orchestrateFinalFix(
      staleOptions,
      stale.boundary,
      stale.select,
      stale.runWorkUnit,
    )).status,
    "conflict",
  );
  assert.equal(stale.events.some(([name]) => name === "checkout"), false);

  const consumed = fixture();
  consumed.comments.push({
    body: renderFinalFixMarker({
      afterHead: fixedHead,
      beforeHead: reviewedHead,
      reviewRunId: "9002",
      runId: "9003",
      schemaVersion: 1,
      sessionId: "fix-session-1",
      type: "sandcastle-final-fix",
    }),
    id: 72,
  });
  assert.equal(
    (await orchestrateFinalFix(
      options(),
      consumed.boundary,
      consumed.select,
      consumed.runWorkUnit,
    )).status,
    "conflict",
  );
  assert.equal(consumed.events.some(([name]) => name === "checkout"), false);
});

test("a Ticket observed after fix publication returns to processing without rereview", async () => {
  const state = fixture();
  state.frontiers[1] = {
    activated: [],
    body: "late Ticket",
    status: "ready",
    ticket: 64,
  };

  const result = await orchestrateFinalFix(
    options(),
    state.boundary,
    state.select,
    state.runWorkUnit,
  );

  assert.deepEqual(result, { status: "processing", ticket: 64 });
  assert.equal(state.events.some(([name]) => name === "continue"), true);
  assert.equal(state.events.some(([name]) => name === "rereview"), false);
});
