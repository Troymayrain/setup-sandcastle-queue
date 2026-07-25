import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcilePublication,
  renderPublicationMarker,
} from "../dist/reconciliation.js";
import {
  completionMessage,
  parseCompletionMetadata,
} from "../dist/publication-facts.js";

const beforeHead = "1".repeat(40);
const afterHead = "2".repeat(40);

function commit(overrides = {}) {
  return {
    message: `Implement Ticket

Sandcastle-Ticket: 58
Sandcastle-Session: session-58
Sandcastle-Before-Head: ${beforeHead}
Sandcastle-Run-Id: 9001`,
    parents: [beforeHead],
    sha: afterHead,
    ...overrides,
  };
}

function marker(overrides = {}) {
  return {
    afterHead,
    beforeHead,
    integrationBranch: "sandcastle/integration",
    issue: 58,
    runId: "9001",
    schemaVersion: 1,
    sessionId: "session-58",
    type: "sandcastle-ticket-publication",
    ...overrides,
  };
}

function clientFixture({ comments = [], issueState = "open", remote = afterHead } = {}) {
  const events = [];
  const mutableComments = [...comments];
  let mutableIssueState = issueState;
  return {
    client: {
      async closeIssue(issue) {
        events.push(["close", issue]);
        mutableIssueState = "closed";
      },
      async createDraftPullRequest(input) {
        events.push(["createDraftPr", input]);
        return { draft: true, number: 19, url: "https://example.invalid/pr/19" };
      },
      async createPublicationMarker(issue, value) {
        events.push(["marker", issue, value]);
        mutableComments.push({
          body: renderPublicationMarker(value),
          id: 700 + mutableComments.length,
        });
        return { id: 700 + mutableComments.length };
      },
      async getCommit(sha) {
        events.push(["commit", sha]);
        return commit();
      },
      async getIssue(issue) {
        events.push(["issue", issue]);
        return { number: issue, state: mutableIssueState };
      },
      async listIntegrationPullRequests(input) {
        events.push(["listPr", input]);
        return [];
      },
      async listIssueComments(issue) {
        events.push(["comments", issue]);
        return structuredClone(mutableComments);
      },
      async remoteHead(branch) {
        events.push(["head", branch]);
        return branch === "main" ? beforeHead : remote;
      },
    },
    events,
  };
}

const options = {
  baseBranch: "main",
  integrationBranch: "sandcastle/integration",
};

test("completion trailers uniquely bind Ticket, session, run, and before_head", () => {
  const metadata = {
    beforeHead,
    issue: 58,
    runId: "9001",
    sessionId: "session-58",
  };
  const message = completionMessage("Implement Ticket", metadata);
  assert.deepEqual(parseCompletionMetadata(message), metadata);
  assert.equal(
    parseCompletionMetadata(
      `${message}\nSandcastle-Session: duplicate-session\n`,
    ),
    null,
  );
  assert.equal(parseCompletionMetadata(`${message}\nextra text\n`), null);
  assert.throws(
    () => completionMessage(message, metadata),
    /already present/u,
  );
});

test("crash after push restores the draft PR, immutable marker, and closure without an Agent", async () => {
  const fixture = clientFixture();

  const result = await reconcilePublication(options, fixture.client);

  assert.equal(result.status, "reconciled");
  assert.equal(result.ticket, 58);
  assert.deepEqual(
    fixture.events
      .filter(([name]) => ["createDraftPr", "marker", "close"].includes(name))
      .map(([name]) => name),
    ["createDraftPr", "marker", "close"],
  );
  assert.equal(
    fixture.events.some(([name]) => /agent|sandcastle/iu.test(name)),
    false,
  );
  assert.ok(
    fixture.events.filter(([name]) => name === "comments").length >= 2,
    "marker visibility must be reread",
  );
});

test("an existing exact marker with an open Issue fills closure only", async () => {
  const fixture = clientFixture({
    comments: [{ body: renderPublicationMarker(marker()), id: 44 }],
  });

  const result = await reconcilePublication(options, fixture.client);

  assert.equal(result.status, "reconciled");
  assert.deepEqual(
    fixture.events
      .filter(([name]) => ["createDraftPr", "marker", "close"].includes(name))
      .map(([name]) => name),
    ["close"],
  );
});

test("complete facts are idempotent and ambiguous facts fail closed without writes", async () => {
  const complete = clientFixture({
    comments: [{ body: renderPublicationMarker(marker()), id: 44 }],
    issueState: "closed",
  });
  assert.equal((await reconcilePublication(options, complete.client)).status, "complete");
  assert.equal(
    complete.events.some(([name]) =>
      ["createDraftPr", "marker", "close"].includes(name),
    ),
    false,
  );

  const conflicts = [
    clientFixture({
      comments: [
        { body: renderPublicationMarker(marker()), id: 44 },
        { body: renderPublicationMarker(marker()), id: 45 },
      ],
    }),
    clientFixture({
      comments: [
        {
          body: renderPublicationMarker(marker({ sessionId: "other-session" })),
          id: 46,
        },
      ],
    }),
    clientFixture({ issueState: "closed" }),
  ];
  for (const fixture of conflicts) {
    const result = await reconcilePublication(options, fixture.client);
    assert.equal(result.status, "conflict");
    assert.equal(
      fixture.events.some(([name]) =>
        ["createDraftPr", "marker", "close"].includes(name),
      ),
      false,
    );
  }
});

test("a branch without a provable completion is none only at the current base", async () => {
  const untouched = clientFixture({ remote: beforeHead });
  assert.deepEqual(await reconcilePublication(options, untouched.client), {
    status: "none",
  });

  const unprovable = clientFixture();
  unprovable.client.getCommit = async () =>
    commit({ message: "missing reserved publication trailers" });
  assert.equal(
    (await reconcilePublication(options, unprovable.client)).status,
    "conflict",
  );
});
