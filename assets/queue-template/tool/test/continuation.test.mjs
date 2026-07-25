import assert from "node:assert/strict";
import test from "node:test";

import { orchestrateProcessingRun } from "../dist/continuation.js";
import { ProcessingDeadlineError } from "../dist/deadline.js";

const oldHead = "1".repeat(40);
const newHead = "2".repeat(40);

function options(overrides = {}) {
  return {
    baseBranch: "main",
    expectedHead: oldHead,
    integrationBranch: "sandcastle/integration",
    operation: "continue",
    predecessorRunId: "8999",
    runId: "9001",
    ...overrides,
  };
}

function fixture({
  currentHead = oldHead,
  frontier = [
    { activated: [], body: "ticket", status: "ready", ticket: 2 },
    { activated: [], body: "next", status: "ready", ticket: 3 },
  ],
  reconciliation = { status: "complete", head: oldHead, ticket: 1 },
} = {}) {
  const events = [];
  const selections = [...frontier];
  return {
    boundary: {
      async dispatchContinuation(payload) {
        events.push(["dispatch", payload]);
      },
      async dispatchFinalReview(payload) {
        events.push(["finalReview", payload]);
      },
      async dispatchFinalRereview(payload) {
        events.push(["finalRereview", payload]);
      },
      async remoteHead(branch) {
        events.push(["head", branch]);
        return currentHead;
      },
    },
    dependencies: {
      async finalize() {
        events.push(["finalize"]);
        return { operation: "final-review", status: "ready" };
      },
      async process(ticket) {
        events.push(["agent", ticket]);
        return { completionCommit: newHead, status: "published", ticket: ticket.number };
      },
      async reconcile() {
        events.push(["reconcile"]);
        return reconciliation;
      },
      async select(activate) {
        events.push(["frontier", activate]);
        return selections.shift() ?? {
          activated: [],
          reason: "empty",
          status: "waiting",
        };
      },
    },
    events,
  };
}

test("stale automatic Continuation Run succeeds without any side effect", async () => {
  const state = fixture({ currentHead: newHead });

  const result = await orchestrateProcessingRun(
    options(),
    state.boundary,
    state.dependencies,
  );

  assert.deepEqual(result, {
    actualHead: newHead,
    expectedHead: oldHead,
    status: "stale-continuation",
  });
  assert.deepEqual(state.events, [["head", "sandcastle/integration"]]);
});

test("stale manual resume fails closed before reconciliation or Agent work", async () => {
  const state = fixture({ currentHead: newHead });

  const result = await orchestrateProcessingRun(
    options({ operation: "resume" }),
    state.boundary,
    state.dependencies,
  );

  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "stale-manual-operation");
  assert.deepEqual(state.events, [["head", "sandcastle/integration"]]);
});

test("confirmed publication fresh-reads Frontier and dispatches only three continuation inputs", async () => {
  const state = fixture();

  const result = await orchestrateProcessingRun(
    options(),
    state.boundary,
    state.dependencies,
  );

  assert.equal(result.status, "continued");
  assert.deepEqual(
    state.events.map(([name]) => name),
    ["head", "reconcile", "frontier", "agent", "frontier", "dispatch"],
  );
  assert.deepEqual(state.events.at(-1)[1], {
    inputs: {
      expected_head: newHead,
      operation: "continue",
      predecessor_run_id: "9001",
    },
    ref: "main",
  });
});

test("waiting, conflict, and zero progress never dispatch", async () => {
  const cases = [
    fixture({
      frontier: [
        { activated: [], body: "ticket", status: "ready", ticket: 2 },
        { activated: [], reason: "blocked", status: "waiting" },
      ],
    }),
    fixture({
      frontier: [{ activated: [], reason: "contradictory", status: "conflict" }],
    }),
    fixture({
      frontier: [{ activated: [], reason: "empty", status: "waiting" }],
      reconciliation: { status: "none" },
    }),
  ];

  for (const state of cases) {
    await orchestrateProcessingRun(options(), state.boundary, state.dependencies);
    assert.equal(
      state.events.some(([name]) => name === "dispatch"),
      false,
    );
  }
});

test("reconciled publication dispatches from fresh facts without rerunning an Agent", async () => {
  const state = fixture({
    frontier: [
      { activated: [], body: "next", status: "ready", ticket: 3 },
    ],
    reconciliation: { head: newHead, status: "reconciled", ticket: 2 },
  });

  const result = await orchestrateProcessingRun(
    options(),
    state.boundary,
    state.dependencies,
  );

  assert.equal(result.status, "continued");
  assert.equal(state.events.some(([name]) => name === "agent"), false);
  assert.equal(state.events.some(([name]) => name === "dispatch"), true);
});

test("confirmed progress dispatches Final Review only when the activated Queue is empty", async () => {
  const state = fixture({
    frontier: [
      { activated: [], body: "last", status: "ready", ticket: 2 },
      { activated: [], reason: "empty", status: "waiting" },
    ],
  });

  const result = await orchestrateProcessingRun(
    options(),
    state.boundary,
    state.dependencies,
  );

  assert.equal(result.status, "final-review-dispatched");
  assert.deepEqual(state.events.at(-1), [
    "finalReview",
    {
      inputs: {
        expected_head: newHead,
        operation: "final-review",
        predecessor_run_id: "9001",
      },
      ref: "main",
    },
  ]);
});

test("Queue completion after a Final Fix resumes independent Rereview", async () => {
  const state = fixture({
    frontier: [
      { activated: [], body: "late Ticket", status: "ready", ticket: 3 },
      { activated: [], reason: "empty", status: "waiting" },
    ],
  });
  state.dependencies.finalize = async () => {
    state.events.push(["finalize"]);
    return { operation: "final-rereview", status: "ready" };
  };

  await orchestrateProcessingRun(
    options(),
    state.boundary,
    state.dependencies,
  );

  assert.deepEqual(state.events.at(-1), [
    "finalRereview",
    {
      inputs: {
        expected_head: newHead,
        operation: "final-rereview",
        predecessor_run_id: "9001",
      },
      ref: "main",
    },
  ]);
});

test("a required dispatch failure fails the current work unit", async () => {
  const state = fixture();
  state.boundary.dispatchContinuation = async () => {
    state.events.push(["dispatch"]);
    throw new Error("dispatch unavailable");
  };

  await assert.rejects(
    orchestrateProcessingRun(options(), state.boundary, state.dependencies),
    /dispatch unavailable/u,
  );
});

test("deadline absence or uncertainty fails without dispatching a Continuation Run", async () => {
  for (const status of [
    "ticket-deadline-exceeded",
    "publication-unknown",
  ]) {
    const state = fixture();
    state.dependencies.process = async () => {
      throw new ProcessingDeadlineError(status);
    };
    await assert.rejects(
      orchestrateProcessingRun(
        options(),
        state.boundary,
        state.dependencies,
      ),
      (error) =>
        error instanceof ProcessingDeadlineError && error.status === status,
    );
    assert.equal(
      state.events.some(([name]) => name === "dispatch"),
      false,
    );
  }
});
