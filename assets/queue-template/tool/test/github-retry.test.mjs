import assert from "node:assert/strict";
import test from "node:test";

import { RestGitHubHost } from "../dist/github-host.js";

const head = "a".repeat(40);

function host(sleeps) {
  return new RestGitHubHost(
    {
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "github-secret",
    },
    {
      sleep: async (delay) => {
        sleeps.push(delay);
      },
    },
  );
}

test("transient GitHub reads retry the identical request at most three times", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const sleeps = [];
  const responses = [
    new Response("temporary", { status: 500 }),
    new Response("slow down", {
      headers: { "retry-after": "2" },
      status: 429,
    }),
    new Response(JSON.stringify({ object: { sha: head } }), { status: 200 }),
  ];
  globalThis.fetch = async (url, input) => {
    requests.push({ body: input.body, method: input.method, url: String(url) });
    return responses.shift();
  };

  try {
    assert.equal(await host(sleeps).remoteHead("sandcastle/integration"), head);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 3);
  assert.deepEqual(requests.slice(1), [requests[0], requests[0]]);
  assert.deepEqual(sleeps, [250, 2_000]);
});

test("permission failures and uncertain marker creation never retry", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const sleeps = [];
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("forbidden", { status: 403 });
  };
  try {
    await assert.rejects(
      host(sleeps).remoteHead("sandcastle/integration"),
      /status 403/u,
    );
    assert.equal(attempts, 1);

    attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      throw new TypeError("connection interrupted after marker write");
    };
    await assert.rejects(
      host(sleeps).createPublicationMarker(58, {
        afterHead: head,
        beforeHead: "b".repeat(40),
        integrationBranch: "sandcastle/integration",
        issue: 58,
        runId: "9001",
        schemaVersion: 1,
        sessionId: "session-58",
        type: "sandcastle-ticket-publication",
      }),
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(sleeps, []);
});

test("an uncertain workflow dispatch retries the same payload no more than three times", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const sleeps = [];
  globalThis.fetch = async (url, input) => {
    requests.push({ body: input.body, method: input.method, url: String(url) });
    if (requests.length < 3) throw new TypeError("uncertain dispatch response");
    return new Response(null, { status: 204 });
  };
  try {
    await host(sleeps).dispatchContinuation({
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

  assert.equal(requests.length, 3);
  assert.deepEqual(requests.slice(1), [requests[0], requests[0]]);
  assert.deepEqual(sleeps, [250, 1_000]);
});
