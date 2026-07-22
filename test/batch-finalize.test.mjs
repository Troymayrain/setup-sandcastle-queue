import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const batchId = "p1-aaaaaaaaaaaa-r9001";
const expectedHead = "b".repeat(40);

function options() {
  return { batchId, expectedHead, pullRequest: 44 };
}

function state() {
  return {
    activeHead: expectedHead,
    pullRequest: {
      head: expectedHead,
      headBranch: `sandcastle/${batchId}`,
      merged: true,
      number: 44,
      state: "closed",
    },
  };
}

test("a merged Batch PR releases the repository for the next Batch", async () => {
  const { finalizeBatch } = await import("../dist/index.js");
  const observed = state();
  const releases = [];
  const result = await finalizeBatch(options(), {
    async readState() {
      return observed;
    },
    async releaseActiveBatch(head) {
      releases.push(head);
      observed.activeHead = null;
      return "released";
    },
  });

  assert.deepEqual(result, {
    batchId,
    head: expectedHead,
    pullRequest: 44,
    status: "finalized",
  });
  assert.deepEqual(releases, [expectedHead]);
});

test("finalize is idempotent only after the same merged PR is verified", async () => {
  const { finalizeBatch } = await import("../dist/index.js");
  const observed = state();
  observed.activeHead = null;
  const result = await finalizeBatch(options(), {
    async readState() {
      return observed;
    },
    async releaseActiveBatch(head) {
      assert.equal(head, expectedHead);
      return "already-released";
    },
  });

  assert.equal(result.status, "already-finalized");
});

test("finalize fails closed for an unmerged PR or another active Batch", async () => {
  const { finalizeBatch } = await import("../dist/index.js");
  let releases = 0;
  const runtime = (observed) => ({
    async readState() {
      return observed;
    },
    async releaseActiveBatch() {
      releases += 1;
      return "released";
    },
  });
  const unmerged = state();
  unmerged.pullRequest.merged = false;
  unmerged.pullRequest.state = "open";
  await assert.rejects(
    finalizeBatch(options(), runtime(unmerged)),
    (error) => error.diagnostics?.[0]?.code === "BATCH_FINALIZE_STATE_INVALID",
  );

  const wrongActive = state();
  wrongActive.activeHead = "c".repeat(40);
  await assert.rejects(
    finalizeBatch(options(), runtime(wrongActive)),
    (error) => error.diagnostics?.[0]?.code === "BATCH_FINALIZE_ACTIVE_REF_MISMATCH",
  );
  assert.equal(releases, 0);
});

test("workflow-host finalizes only the verified merged PR head", async () => {
  const { runWorkflowHostCommand } = await import("../dist/index.js");
  let activeHead = expectedHead;
  let pullRequest = {
    head: { ref: `sandcastle/${batchId}`, sha: expectedHead },
    merged: false,
    number: 44,
    state: "open",
  };
  let deletes = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/pulls/44"
    ) {
      response.end(JSON.stringify(pullRequest));
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
    response.statusCode = 404;
    response.end(JSON.stringify({ url: request.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const eventPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-finalize-event-")),
    "event.json",
  );
  writeFileSync(
    eventPath,
    `${JSON.stringify({
      inputs: {
        batch_id: batchId,
        expected_head: expectedHead,
        operation: "finalize-batch",
        pull_request: "44",
      },
    })}\n`,
  );
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "acme/widget",
    GITHUB_RUN_ID: "9300",
    GITHUB_TOKEN: "test-token",
    SANDCASTLE_OPERATION: "finalize-batch",
  };
  const arguments_ = [
    "--operation",
    "finalize-batch",
    "--batch-id",
    batchId,
    "--expected-head",
    expectedHead,
    "--pull-request",
    "44",
  ];
  try {
    await assert.rejects(
      runWorkflowHostCommand("/repository", arguments_, environment),
      (error) => error.diagnostics?.[0]?.code === "BATCH_FINALIZE_STATE_INVALID",
    );
    assert.equal(deletes, 0);

    pullRequest = { ...pullRequest, merged: true, state: "closed" };
    const completed = await runWorkflowHostCommand(
      "/repository",
      arguments_,
      environment,
    );
    assert.equal(completed.operation, "finalize-batch");
    assert.equal(completed.result.status, "finalized");
    assert.equal(activeHead, null);

    const retried = await runWorkflowHostCommand(
      "/repository",
      arguments_,
      environment,
    );
    assert.equal(retried.result.status, "already-finalized");

    activeHead = "c".repeat(40);
    await assert.rejects(
      runWorkflowHostCommand("/repository", arguments_, environment),
      (error) =>
        error.diagnostics?.[0]?.code ===
        "BATCH_FINALIZE_ACTIVE_REF_MISMATCH",
    );
    assert.equal(activeHead, "c".repeat(40));
    assert.equal(deletes, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
