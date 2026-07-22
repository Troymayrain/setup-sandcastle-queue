import assert from "node:assert/strict";
import test from "node:test";

const batchId = "p1-aaaaaaaaaaaa-r9001";
const branch = `sandcastle/${batchId}`;
const expectedHead = "b".repeat(40);

function options() {
  return {
    actor: "maintainer",
    batchId,
    expectedHead,
    pullRequest: 44,
    reason: "Stopping this Batch for a controlled recovery.",
    runId: "9200",
    trigger: "workflow_dispatch",
  };
}

function publication(ticket, commit, recordBatchId = batchId) {
  return {
    batchId: recordBatchId,
    commit,
    pullRequest: { draft: true, number: 44, url: "https://example.invalid/pr/44" },
    schemaVersion: 1,
    sessionId: `${ticket}23e4567-e89b-42d3-a456-42661417400${ticket}`,
    ticket,
  };
}

function abortState() {
  return {
    abortRecords: [],
    activeProcessingRuns: [],
    batch: {
      branch,
      id: batchId,
      parent: 1,
      remoteHead: expectedHead,
    },
    defaultBranchHead: "c".repeat(40),
    parent: { number: 1, state: "open" },
    pullRequest: {
      draft: true,
      head: expectedHead,
      merged: false,
      number: 44,
      state: "open",
    },
    tickets: [
      { number: 2, publication: publication(2, "d".repeat(40)), state: "closed" },
      { number: 3, publication: publication(3, "e".repeat(40)), state: "closed" },
      {
        number: 4,
        publication: publication(4, "f".repeat(40), "p9-ffffffffffff-r1"),
        state: "closed",
      },
      { number: 5, publication: publication(5, "1".repeat(40)), state: "open" },
    ],
  };
}

test("abort preserves evidence and reopens only this Batch's unmerged Published Tickets", async () => {
  const { abortBatch } = await import("../dist/index.js");
  const state = abortState();
  const calls = [];
  const result = await abortBatch("/repository", options(), {
    async appendAudit(record) {
      calls.push({ kind: "audit", record });
      state.abortRecords.push(record);
    },
    async closePullRequest(number) {
      calls.push({ kind: "close-pr", number });
      state.pullRequest.state = "closed";
    },
    async commitInDefaultBranch(commit, defaultHead) {
      assert.equal(defaultHead, state.defaultBranchHead);
      return commit === "e".repeat(40);
    },
    async readState() {
      return state;
    },
    async reopenTicket(number) {
      calls.push({ kind: "reopen", number });
      state.tickets.find((ticket) => ticket.number === number).state = "open";
    },
  });

  assert.equal(result.status, "aborted");
  assert.deepEqual(result.reopenedTickets, [2]);
  assert.equal(result.preservedBranch, branch);
  assert.deepEqual(
    calls.map(({ kind }) => kind),
    ["audit", "close-pr", "reopen", "audit"],
  );
  assert.deepEqual(
    state.abortRecords.map(({ stage }) => stage),
    ["started", "completed"],
  );
  assert.equal(state.abortRecords[0].eventId, state.abortRecords[1].eventId);
  assert.equal(state.parent.state, "open");
  assert.equal(state.pullRequest.state, "closed");
  assert.equal(state.tickets.find(({ number }) => number === 3).state, "closed");
  assert.equal(state.tickets.find(({ number }) => number === 4).state, "closed");
});

test("abort refuses every write while a processing run is active", async () => {
  const { abortBatch } = await import("../dist/index.js");
  const state = abortState();
  state.activeProcessingRuns.push({ id: 91, status: "in_progress" });
  const noWrite = () => assert.fail("active processing must block abort writes");
  await assert.rejects(
    abortBatch("/repository", options(), {
      appendAudit: noWrite,
      closePullRequest: noWrite,
      commitInDefaultBranch: async () => {
        noWrite();
      },
      async readState() {
        return state;
      },
      reopenTicket: noWrite,
    }),
    (error) => error.diagnostics?.[0]?.code === "BATCH_ABORT_ACTIVE_RUN",
  );
});

test("abort resumes the same immutable decision after a cross-API crash", async () => {
  const {
    abortBatch,
    parseBatchAbortRecord,
    renderBatchAbortRecord,
  } = await import("../dist/index.js");
  const state = abortState();
  const mutations = [];
  let failAfterReopen = true;
  const runtime = {
    async appendAudit(record) {
      state.abortRecords.push(record);
    },
    async checkpoint(point) {
      if (point === "after-ticket-reopen" && failAfterReopen) {
        failAfterReopen = false;
        throw new Error("simulated runner crash");
      }
    },
    async closePullRequest(number) {
      mutations.push(`close-pr:${number}`);
      state.pullRequest.state = "closed";
    },
    async commitInDefaultBranch(commit) {
      return commit === "e".repeat(40);
    },
    async readState() {
      return state;
    },
    async reopenTicket(number) {
      mutations.push(`reopen:${number}`);
      state.tickets.find((ticket) => ticket.number === number).state = "open";
    },
  };

  await assert.rejects(abortBatch("/repository", options(), runtime));
  assert.deepEqual(state.abortRecords.map(({ stage }) => stage), ["started"]);
  const eventId = state.abortRecords[0].eventId;

  const resumed = await abortBatch("/repository", options(), runtime);
  assert.equal(resumed.status, "aborted");
  assert.equal(resumed.auditEventId, eventId);
  assert.deepEqual(mutations, ["close-pr:44", "reopen:2"]);
  assert.deepEqual(state.abortRecords.map(({ stage }) => stage), [
    "started",
    "completed",
  ]);
  const rendered = renderBatchAbortRecord(state.abortRecords[1]);
  assert.deepEqual(parseBatchAbortRecord(rendered), state.abortRecords[1]);
});
