import assert from "node:assert/strict";
import test from "node:test";

import { RestGitHubHost } from "../dist/github-host.js";

const head = "a".repeat(40);

test("GitHub publication adapter uses create-only refs, immutable comments, closure, and draft PR APIs", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    { object: { sha: head } },
    { ref: "refs/heads/sandcastle/integration" },
    { id: 71 },
    { number: 58, state: "closed" },
    [],
    {
      draft: true,
      html_url: "https://example.invalid/pr/31",
      node_id: "PR_node_31",
      number: 31,
    },
    undefined,
  ];
  globalThis.fetch = async (url, input) => {
    requests.push({
      body: input.body === undefined ? undefined : JSON.parse(input.body),
      method: input.method,
      path: new URL(url).pathname + new URL(url).search,
    });
    const response = responses.shift();
    return new Response(
      response === undefined ? null : JSON.stringify(response),
      {
      headers: { "content-type": "application/json" },
        status: response === undefined ? 204 : 200,
      },
    );
  };

  try {
    const client = new RestGitHubHost({
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "github-secret",
    });
    assert.equal(await client.remoteHead("sandcastle/integration"), head);
    await client.createIntegrationBranch("sandcastle/integration", head);
    await client.createPublicationMarker(58, {
      afterHead: head,
      beforeHead: "b".repeat(40),
      integrationBranch: "sandcastle/integration",
      issue: 58,
      runId: "9001",
      schemaVersion: 1,
      sessionId: "fresh-session",
      type: "sandcastle-ticket-publication",
    });
    await client.closeIssue(58);
    assert.deepEqual(
      await client.listIntegrationPullRequests({
        base: "main",
        head: "sandcastle/integration",
      }),
      [],
    );
    assert.equal(
      (
        await client.createDraftPullRequest({
          base: "main",
          head: "sandcastle/integration",
          title: "Sandcastle Queue integration",
        })
      ).draft,
      true,
    );
    await client.dispatchContinuation({
      inputs: {
        expected_head: head,
        operation: "continue",
        predecessor_run_id: "9001",
      },
      ref: "main",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    requests.map(({ method }) => method),
    ["GET", "POST", "POST", "PATCH", "GET", "POST", "POST"],
  );
  assert.deepEqual(requests[1].body, {
    ref: "refs/heads/sandcastle/integration",
    sha: head,
  });
  assert.match(
    requests[2].body.body,
    /^<!-- sandcastle-ticket-publication\n\{.+\}\n-->$/u,
  );
  assert.deepEqual(requests[3].body, { state: "closed" });
  assert.match(requests[4].path, /state=open/u);
  assert.deepEqual(requests[5].body, {
    base: "main",
    body: "This draft accumulates fully published Sandcastle Queue Tickets.",
    draft: true,
    head: "sandcastle/integration",
    title: "Sandcastle Queue integration",
  });
  assert.deepEqual(requests[6].body, {
    inputs: {
      expected_head: head,
      operation: "continue",
      predecessor_run_id: "9001",
    },
    ref: "main",
  });
  assert.match(
    requests[6].path,
    /actions\/workflows\/sandcastle-queue\.yml\/dispatches$/u,
  );
});

test("Final Review marker creation and ready transition use distinct non-retried writes", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    { id: 72 },
    {
      data: {
        markPullRequestReadyForReview: {
          pullRequest: { id: "PR_node_31", isDraft: false },
        },
      },
    },
  ];
  globalThis.fetch = async (url, input) => {
    requests.push({
      body: JSON.parse(input.body),
      path: new URL(url).pathname,
    });
    return new Response(JSON.stringify(responses.shift()), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };

  try {
    const client = new RestGitHubHost({
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "github-secret",
    });
    await client.createFinalReviewMarker(31, {
      baseHead: "b".repeat(40),
      integrationHead: head,
      runId: "9002",
      schemaVersion: 1,
      type: "sandcastle-final-review",
      verdict: "pass",
    });
    await client.markPullRequestReady("PR_node_31");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  assert.equal(requests[0].path, "/repos/acme/widget/issues/31/comments");
  assert.match(
    requests[0].body.body,
    /^<!-- sandcastle-final-review\n\{.+\}\n-->$/u,
  );
  assert.equal(requests[1].path, "/graphql");
  assert.deepEqual(requests[1].body.variables, {
    pullRequestId: "PR_node_31",
  });
});

test("Final Fix and Rereview use immutable PR markers and bound workflow dispatches", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [{ id: 73 }, { id: 74 }, undefined, undefined];
  globalThis.fetch = async (url, input) => {
    requests.push({
      body: JSON.parse(input.body),
      path: new URL(url).pathname,
    });
    const response = responses.shift();
    return new Response(
      response === undefined ? null : JSON.stringify(response),
      { status: response === undefined ? 204 : 200 },
    );
  };

  try {
    const client = new RestGitHubHost({
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "github-secret",
    });
    await client.createFinalFixMarker(31, {
      afterHead: head,
      beforeHead: "b".repeat(40),
      reviewRunId: "9002",
      runId: "9003",
      schemaVersion: 1,
      sessionId: "fix-session",
      type: "sandcastle-final-fix",
    });
    await client.createFinalRereviewMarker(31, {
      baseHead: "b".repeat(40),
      fixRunId: "9003",
      integrationHead: head,
      runId: "9004",
      schemaVersion: 1,
      type: "sandcastle-final-rereview",
      verdict: "needs-fix",
    });
    await client.dispatchFinalFix({
      inputs: {
        expected_head: "b".repeat(40),
        operation: "final-fix",
        predecessor_run_id: "9002",
      },
      ref: "main",
    });
    await client.dispatchFinalRereview({
      inputs: {
        expected_head: head,
        operation: "final-rereview",
        predecessor_run_id: "9003",
      },
      ref: "main",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(requests[0].body.body, /sandcastle-final-fix/u);
  assert.match(requests[1].body.body, /sandcastle-final-rereview/u);
  assert.equal(requests[2].body.inputs.operation, "final-fix");
  assert.equal(requests[3].body.inputs.operation, "final-rereview");
  assert.equal(
    requests.every(({ path }) =>
      /issues\/31\/comments|sandcastle-queue\.yml\/dispatches/u.test(path),
    ),
    true,
  );
});
