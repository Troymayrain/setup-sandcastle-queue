import assert from "node:assert/strict";
import test from "node:test";

import { orchestrateFirstFinalReview } from "../dist/final-review.js";
import {
  renderFinalFixMarker,
  renderFinalReviewMarker,
} from "../dist/final-review-facts.js";

const integrationHead = "1".repeat(40);
const baseHead = "2".repeat(40);

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
      GITHUB_RUN_ID: "9002",
      GITHUB_TOKEN: "github-secret",
    },
    expectedHead: integrationHead,
    integrationBranch: "sandcastle/integration",
    model: "review-model",
    predecessorRunId: "9001",
    promptFile: "/queue/final-review.md",
  };
}

function fixture({
  frontier = { activated: [], reason: "empty", status: "waiting" },
  verdict = "pass",
} = {}) {
  const comments = [];
  const events = [];
  const boundary = {
    async createFinalReviewMarker(pullRequest, marker) {
      events.push(["marker", pullRequest, marker]);
      comments.push({ body: renderFinalReviewMarker(marker), id: 71 });
      return { id: 71 };
    },
    async createTemporaryMerge(input) {
      events.push(["merge", input]);
      return {
        baseHead,
        integrationHead,
        path: "/temporary/merge",
        async includes() {
          return true;
        },
        async remove() {
          events.push(["remove"]);
        },
        async unchanged() {
          events.push(["unchanged"]);
          return true;
        },
      };
    },
    async dispatchContinuation(payload) {
      events.push(["dispatch", payload]);
    },
    async dispatchFinalFix(payload) {
      events.push(["finalFix", payload]);
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
    async markPullRequestReady(nodeId) {
      events.push(["ready", nodeId]);
    },
    async remoteHead(branch) {
      events.push(["head", branch]);
      return branch === "main" ? baseHead : integrationHead;
    },
    async runCommand(path, argv, environment) {
      events.push(["command", path, argv, environment]);
    },
  };
  const select = async () => {
    events.push(["frontier"]);
    return frontier;
  };
  const runWorkUnit = async (input) => {
    events.push(["review", input]);
    return {
      branch: "temporary",
      commits: [],
      role: "final-review",
      sessionId: "review-session-1",
      status: "complete",
      streamSummary: { jsonLines: 1, lineCount: 1, textLines: 0 },
      verdict,
    };
  };
  return { boundary, comments, events, runWorkUnit, select };
}

test("first Final Review uses a temporary latest-base merge and marks only a proven pass ready", async () => {
  const state = fixture();

  const result = await orchestrateFirstFinalReview(
    options(),
    state.boundary,
    state.select,
    state.runWorkUnit,
  );

  assert.deepEqual(result, {
    baseHead,
    integrationHead,
    markerCommentId: 71,
    pullRequest: 17,
    sessionId: "review-session-1",
    status: "ready-for-human-review",
    verdict: "pass",
  });
  assert.deepEqual(
    state.events.filter(([name]) => name === "command").map(([, , argv]) => argv),
    [
      ["fixture", "bootstrap"],
      ["fixture", "test"],
      ["fixture", "verify"],
    ],
  );
  assert.equal(state.events.find(([name]) => name === "review")[1].role, "final-review");
  assert.equal(state.events.find(([name]) => name === "review")[1].cwd, "/temporary/merge");
  const commandEnvironments = state.events
    .filter(([name]) => name === "command")
    .map(([, , , environment]) => environment);
  assert.equal(
    commandEnvironments.every(
      (environment) =>
        environment.GITHUB_TOKEN === undefined &&
        environment.ANTHROPIC_AUTH_TOKEN === undefined,
    ),
    true,
  );
  assert.ok(
    state.events.findIndex(([name]) => name === "remove") <
      state.events.findIndex(([name]) => name === "marker"),
  );
  assert.ok(
    state.events.findIndex(([name]) => name === "marker") <
      state.events.findIndex(([name]) => name === "ready"),
  );
});

test("needs-fix records the immutable verdict and dispatches one exact-head Final Fix", async () => {
  const state = fixture({ verdict: "needs-fix" });

  const result = await orchestrateFirstFinalReview(
    options(),
    state.boundary,
    state.select,
    state.runWorkUnit,
  );

  assert.equal(result.status, "final-fix-dispatched");
  assert.equal(state.events.some(([name]) => name === "marker"), true);
  assert.equal(state.events.some(([name]) => name === "ready"), false);
  assert.deepEqual(state.events.at(-1), [
    "finalFix",
    {
      inputs: {
        expected_head: integrationHead,
        operation: "final-fix",
        predecessor_run_id: "9002",
      },
      ref: "main",
    },
  ]);
});

test("a prior Final Fix turns a later needs-fix review over to a human", async () => {
  const state = fixture({ verdict: "needs-fix" });
  state.comments.push({
    body: renderFinalFixMarker({
      afterHead: "3".repeat(40),
      beforeHead: "2".repeat(40),
      reviewRunId: "8001",
      runId: "8002",
      schemaVersion: 1,
      sessionId: "prior-fix-session",
      type: "sandcastle-final-fix",
    }),
    id: 70,
  });

  const result = await orchestrateFirstFinalReview(
    options(),
    state.boundary,
    state.select,
    state.runWorkUnit,
  );

  assert.equal(result.status, "needs-human-review");
  assert.equal(state.events.some(([name]) => name === "finalFix"), false);
});

test("blocked work never finalizes and new executable work returns to processing", async () => {
  const blocked = fixture({
    frontier: { activated: [], reason: "blocked", status: "waiting" },
  });
  assert.equal(
    (await orchestrateFirstFinalReview(
      options(),
      blocked.boundary,
      blocked.select,
      blocked.runWorkUnit,
    )).status,
    "waiting",
  );
  assert.equal(blocked.events.some(([name]) => name === "merge"), false);

  const ready = fixture({
    frontier: { activated: [], body: "new Ticket", status: "ready", ticket: 63 },
  });
  assert.equal(
    (await orchestrateFirstFinalReview(
      options(),
      ready.boundary,
      ready.select,
      ready.runWorkUnit,
    )).status,
    "processing",
  );
  assert.equal(ready.events.some(([name]) => name === "dispatch"), true);
  assert.equal(ready.events.some(([name]) => name === "merge"), false);
});

test("a Ticket observed after review returns to processing without publishing a verdict", async () => {
  const state = fixture();
  const frontiers = [
    { activated: [], reason: "empty", status: "waiting" },
    { activated: [], body: "late Ticket", status: "ready", ticket: 63 },
  ];
  state.select = async () => {
    state.events.push(["frontier"]);
    return frontiers.shift();
  };

  const result = await orchestrateFirstFinalReview(
    options(),
    state.boundary,
    state.select,
    state.runWorkUnit,
  );

  assert.deepEqual(result, { status: "processing", ticket: 63 });
  assert.equal(state.events.some(([name]) => name === "review"), true);
  assert.equal(state.events.some(([name]) => name === "dispatch"), true);
  assert.equal(state.events.some(([name]) => name === "marker"), false);
  assert.equal(state.events.some(([name]) => name === "ready"), false);
});

test("stale HEAD and malformed review verdict fail closed without marker or ready transition", async () => {
  const stale = fixture();
  stale.boundary.remoteHead = async () => "3".repeat(40);
  assert.equal(
    (await orchestrateFirstFinalReview(
      options(),
      stale.boundary,
      stale.select,
      stale.runWorkUnit,
    )).status,
    "stale-final-review",
  );

  const malformed = fixture({ verdict: "invalid" });
  await assert.rejects(
    orchestrateFirstFinalReview(
      options(),
      malformed.boundary,
      malformed.select,
      malformed.runWorkUnit,
    ),
    /verdict/u,
  );
  assert.equal(malformed.events.some(([name]) => name === "marker"), false);
  assert.equal(malformed.events.some(([name]) => name === "ready"), false);
});
