import assert from "node:assert/strict";
import test from "node:test";

import {
  renderFinalFixMarker,
  renderFinalRereviewMarker,
} from "../dist/final-review-facts.js";
import { nextFinalOperation } from "../dist/finalization.js";

const branches = {
  baseBranch: "main",
  integrationBranch: "sandcastle/integration",
};

function boundary(comments) {
  return {
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
      return comments;
    },
  };
}

test("remote Final Fix facts select Rereview after later Ticket work", async () => {
  const comments = [{
    body: renderFinalFixMarker({
      afterHead: "2".repeat(40),
      beforeHead: "1".repeat(40),
      reviewRunId: "9002",
      runId: "9003",
      schemaVersion: 1,
      sessionId: "fix-session",
      type: "sandcastle-final-fix",
    }),
    id: 72,
  }];

  assert.deepEqual(await nextFinalOperation(branches, boundary([])), {
    operation: "final-review",
    status: "ready",
  });
  assert.deepEqual(await nextFinalOperation(branches, boundary(comments)), {
    operation: "final-rereview",
    status: "ready",
  });

  comments.push({
    body: renderFinalRereviewMarker({
      baseHead: "b".repeat(40),
      fixRunId: "9003",
      integrationHead: "4".repeat(40),
      runId: "9006",
      schemaVersion: 1,
      type: "sandcastle-final-rereview",
      verdict: "pass",
    }),
    id: 73,
  });
  assert.equal(
    (await nextFinalOperation(branches, boundary(comments))).status,
    "conflict",
  );
});
