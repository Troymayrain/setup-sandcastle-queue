import assert from "node:assert/strict";
import { createServer } from "node:http";
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
    async releaseActiveBatch(head) {
      assert.equal(head, expectedHead);
      calls.push({ kind: "release-active" });
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
    ["audit", "close-pr", "reopen", "audit", "release-active"],
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
      releaseActiveBatch: noWrite,
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
  let releases = 0;
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
    async releaseActiveBatch(head) {
      assert.equal(head, expectedHead);
      releases += 1;
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
  const retried = await abortBatch("/repository", options(), runtime);
  assert.equal(retried.status, "already-aborted");
  assert.equal(releases, 2);
  const rendered = renderBatchAbortRecord(state.abortRecords[1]);
  assert.deepEqual(parseBatchAbortRecord(rendered), state.abortRecords[1]);
});

test("workflow abort releases the exact active ref and retries after deletion", async () => {
  const { runWorkflowAbort } = await import(
    "../dist/workflow/abort-runtime.js"
  );
  let activeHead = expectedHead;
  let pullState = "open";
  let deletes = 0;
  const comments = [];
  const server = createServer(async (request, response) => {
    let source = "";
    for await (const chunk of request) source += chunk;
    const body = source ? JSON.parse(source) : null;
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/repos/acme/widget") {
      response.end('{"default_branch":"main"}');
      return;
    }
    if (
      request.method === "GET" &&
      request.url ===
        `/repos/acme/widget/git/ref/heads/${encodeURIComponent(branch)}`
    ) {
      response.end(JSON.stringify({ object: { sha: expectedHead } }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/git/ref/heads/main"
    ) {
      response.end(JSON.stringify({ object: { sha: "c".repeat(40) } }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/git/ref/heads/sandcastle%2Factive"
    ) {
      if (activeHead) {
        response.end(JSON.stringify({ object: { sha: activeHead } }));
      } else {
        response.statusCode = 404;
        response.end('{"message":"Not Found"}');
      }
      return;
    }
    if (
      request.method === "DELETE" &&
      request.url === "/repos/acme/widget/git/refs/heads/sandcastle%2Factive"
    ) {
      deletes += 1;
      activeHead = null;
      response.statusCode = 204;
      response.end();
      return;
    }
    if (
      request.url === "/repos/acme/widget/pulls/44" &&
      request.method === "GET"
    ) {
      response.end(
        JSON.stringify({
          draft: true,
          head: { ref: branch, sha: expectedHead },
          merged: false,
          number: 44,
          state: pullState,
        }),
      );
      return;
    }
    if (
      request.url === "/repos/acme/widget/pulls/44" &&
      request.method === "PATCH"
    ) {
      pullState = body.state;
      response.end(JSON.stringify({ number: 44, state: pullState }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url ===
        "/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=1"
    ) {
      response.end('[{"body":"# Parent","number":1,"state":"open"}]');
      return;
    }
    if (
      request.method === "GET" &&
      request.url?.startsWith(
        "/repos/acme/widget/actions/workflows/sandcastle.yml/runs?",
      )
    ) {
      response.end('{"workflow_runs":[]}');
      return;
    }
    if (
      request.method === "GET" &&
      request.url ===
        "/repos/acme/widget/issues/44/comments?per_page=100&page=1"
    ) {
      response.end(JSON.stringify(comments));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/repos/acme/widget/issues/44/comments"
    ) {
      const comment = { body: body.body, id: 5000 + comments.length };
      comments.push(comment);
      response.statusCode = 201;
      response.end(JSON.stringify(comment));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ method: request.method, url: request.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const workflowOptions = {
    actor: "maintainer",
    batchId,
    environment: {
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "test-token",
    },
    expectedHead,
    pullRequest: 44,
    reason: "Stopping this Batch for a controlled recovery.",
    repositoryPath: "/repository",
    runId: "9200",
  };
  try {
    const result = await runWorkflowAbort(workflowOptions);
    assert.equal(result.status, "aborted");
    assert.equal(pullState, "closed");
    assert.equal(activeHead, null);
    assert.equal(deletes, 1);
    assert.equal(comments.length, 2);

    const retried = await runWorkflowAbort(workflowOptions);
    assert.equal(retried.status, "already-aborted");
    assert.equal(deletes, 1);
    assert.equal(comments.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
