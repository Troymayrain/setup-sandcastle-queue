import assert from "node:assert/strict";
import test from "node:test";

import {
  startAnthropicContractServer,
  startGitHubContractServer,
} from "./support/contract-servers.mjs";

async function retry(url) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) return response;
    if (attempt === 2 || ![429, 502, 503, 504].includes(response.status)) {
      return response;
    }
  }
  throw new Error("unreachable");
}

test("local GitHub contract covers pagination, stale facts, native dependencies, writes, rate limits, and transient failures", async () => {
  const github = await startGitHubContractServer();
  try {
    const first = await fetch(
      `${github.apiUrl}/repos/acme/widget/issues?state=all&per_page=2&page=1`,
    );
    assert.equal(first.status, 200);
    assert.match(first.headers.get("link"), /rel="next"/u);
    const stale = await first.json();
    assert.deepEqual(stale[1].labels, [{ name: "ready-for-agent" }]);
    const second = await fetch(
      `${github.apiUrl}/repos/acme/widget/issues?state=all&per_page=2&page=2`,
    );
    assert.equal((await second.json())[0].number, 3);

    const fresh = await fetch(`${github.apiUrl}/repos/acme/widget/issues/2`);
    assert.deepEqual(
      (await fresh.json()).labels.map(({ name }) => name),
      ["ready-for-agent", "sandcastle"],
    );
    const blockers = await fetch(
      `${github.apiUrl}/repos/acme/widget/issues/2/dependencies/blocked_by`,
    );
    assert.equal((await blockers.json())[0].state, "closed");

    const comment = await fetch(
      `${github.apiUrl}/repos/acme/widget/issues/2/comments`,
      {
        body: JSON.stringify({ body: "sanitized audit" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    assert.equal(comment.status, 201);
    const commit = await fetch(`${github.apiUrl}/repos/acme/widget/git/commits`, {
      body: JSON.stringify({ message: "Published Commit" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.match((await commit.json()).sha, /^[a-f0-9]{40}$/u);
    const branch = await fetch(
      `${github.apiUrl}/repos/acme/widget/git/refs/heads/sandcastle%2Factive`,
      {
        body: JSON.stringify({ sha: "b".repeat(40) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    assert.equal(branch.status, 201);
    const pullRequest = await fetch(`${github.apiUrl}/repos/acme/widget/pulls`, {
      body: JSON.stringify({ base: "main", head: "sandcastle/active" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal((await pullRequest.json()).draft, true);

    assert.equal((await retry(`${github.apiUrl}/contract/rate-limit`)).status, 200);
    assert.equal((await retry(`${github.apiUrl}/contract/transient`)).status, 200);
    assert.deepEqual(github.attempts, { rateLimit: 2, transient: 2 });
  } finally {
    await github.close();
  }
});

test("local Anthropic-compatible contract covers streaming, errors, model allowlists, and broker metadata", async () => {
  const anthropic = await startAnthropicContractServer();
  const headers = {
    authorization: "Bearer session-token",
    "content-type": "application/json",
    "x-sandcastle-batch": "p1-aaaaaaaaaaaa-r9500",
    "x-sandcastle-session": "session-9500",
  };
  try {
    const streamed = await fetch(`${anthropic.apiUrl}/v1/messages`, {
      body: JSON.stringify({ model: "ticket-model", stream: true }),
      headers,
      method: "POST",
    });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get("content-type"), /text\/event-stream/u);
    assert.match(await streamed.text(), /message_stop/u);

    const restricted = await fetch(`${anthropic.apiUrl}/v1/messages`, {
      body: JSON.stringify({ model: "unapproved-model", stream: true }),
      headers,
      method: "POST",
    });
    assert.equal(restricted.status, 400);
    assert.equal((await restricted.json()).error.type, "model_not_allowed");

    const failed = await fetch(`${anthropic.apiUrl}/v1/messages`, {
      body: JSON.stringify({
        metadata: { scenario: "error" },
        model: "fast-model",
        stream: true,
      }),
      headers,
      method: "POST",
    });
    assert.equal(failed.status, 529);
    assert.equal((await failed.json()).error.type, "overloaded_error");
    assert.deepEqual(
      anthropic.requests.map(({ batch, model, session }) => ({
        batch,
        model,
        session,
      })),
      [
        {
          batch: "p1-aaaaaaaaaaaa-r9500",
          model: "ticket-model",
          session: "session-9500",
        },
        {
          batch: "p1-aaaaaaaaaaaa-r9500",
          model: "unapproved-model",
          session: "session-9500",
        },
        {
          batch: "p1-aaaaaaaaaaaa-r9500",
          model: "fast-model",
          session: "session-9500",
        },
      ],
    );
  } finally {
    await anthropic.close();
  }
});
