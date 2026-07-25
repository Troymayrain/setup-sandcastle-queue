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
