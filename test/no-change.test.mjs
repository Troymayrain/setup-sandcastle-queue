import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const limits = {
  jobTimeoutMinutes: 350,
  maxTicketsPerRun: 3,
  minimumRemainingMinutes: 140,
  processingBudgetMinutes: 300,
  ticketTimeoutMinutes: 120,
};

async function requestBody(request) {
  let source = "";
  for await (const chunk of request) source += chunk;
  return source ? JSON.parse(source) : null;
}

function eventFile(inputs) {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-no-change-event-"));
  const path = join(directory, "event.json");
  writeFileSync(path, `${JSON.stringify({ inputs })}\n`);
  return path;
}

test("zero-diff Tickets and Batches require separate workflow-authorized human decisions", async () => {
  const {
    acceptTicketNoChange,
    completeNoChangeBatch,
    readBatchRunState,
    recordTicketNoChange,
    runBatch,
  } = await import("../dist/index.js");
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-no-change-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const base = "a".repeat(40);
  const batchId = "p1-aaaaaaaaaaaa-r9001";
  const branch = `sandcastle/${batchId}`;
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const configPath = join(repository, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({
      audit: { retentionDays: 30 },
      commands: { tests: [{ argv: ["npm", "test"] }], verification: [] },
      execution: limits,
      provider: { kind: "anthropic-compatible", models: { ticket: "ticket" } },
      queue: { ownershipLabel: "sandcastle", readyLabel: "ready-for-agent" },
      runtime: { adapter: "node-npm", version: "22.22.2" },
      schemaVersion: 1,
    })}\n`,
  );
  const issues = new Map([
    [
      1,
      {
        assignees: [],
        body: "# Parent",
        closed_at: null,
        labels: [],
        number: 1,
        state: "open",
      },
    ],
    [
      2,
      {
        assignees: [],
        body: "## Parent\n\n#1\n",
        closed_at: null,
        issue_dependencies_summary: { blocked_by: 0 },
        labels: [{ name: "ready-for-agent" }, { name: "sandcastle" }],
        number: 2,
        state: "open",
      },
    ],
  ]);
  const comments = new Map([
    [1, []],
    [2, []],
  ]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({ body, method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/repos/acme/widget") {
      response.end('{"default_branch":"main"}');
      return;
    }
    if (
      request.method === "GET" &&
      (request.url ===
        `/repos/acme/widget/git/ref/heads/${encodeURIComponent(branch)}` ||
        request.url === "/repos/acme/widget/git/ref/heads/sandcastle%2Factive")
    ) {
      response.end(JSON.stringify({ object: { sha: base } }));
      return;
    }
    if (request.method === "GET" && request.url === "/repos/acme/widget/actions/runs/9001") {
      response.end(
        '{"created_at":"2026-07-22T10:00:00Z","id":9001,"repository":{"full_name":"acme/widget"}}',
      );
      return;
    }
    if (
      request.method === "GET" &&
      request.url ===
        "/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=1"
    ) {
      response.end('[{"number":1},{"number":2}]');
      return;
    }
    if (
      request.method === "GET" &&
      request.url ===
        `/repos/acme/widget/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=1`
    ) {
      response.end(
        JSON.stringify([
          {
            commit: { message: "Base" },
            parents: [{ sha: "0".repeat(40) }],
            sha: base,
          },
        ]),
      );
      return;
    }
    const commentsMatch = request.url?.match(
      /^\/repos\/acme\/widget\/issues\/(\d+)\/comments(?:\?per_page=100&page=1)?$/u,
    );
    if (commentsMatch) {
      const number = Number(commentsMatch[1]);
      if (request.method === "GET") {
        response.end(JSON.stringify(comments.get(number)));
      } else if (request.method === "POST") {
        const comment = {
          body: body.body,
          id: 4000 + comments.get(number).length,
        };
        comments.get(number).push(comment);
        response.statusCode = 201;
        response.end(JSON.stringify(comment));
      }
      return;
    }
    const issueMatch = request.url?.match(/^\/repos\/acme\/widget\/issues\/(\d+)$/u);
    if (issueMatch) {
      const number = Number(issueMatch[1]);
      const issue = issues.get(number);
      if (request.method === "GET") {
        response.end(JSON.stringify(issue));
      } else if (request.method === "PATCH") {
        issue.state = body.state;
        issue.closed_at = "2026-07-22T12:00:00Z";
        response.end(JSON.stringify(issue));
      }
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ url: request.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseEnvironment = {
    ...process.env,
    GITHUB_ACTOR: "maintainer",
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    GITHUB_REPOSITORY: "acme/widget",
    GITHUB_RUN_ID: "9200",
    GITHUB_TOKEN: "test-token",
  };
  const candidate = { batchId, expectedHead: base, sessionId, ticket: 2 };
  try {
    const recorded = await recordTicketNoChange(
      repository,
      candidate,
      configPath,
      baseEnvironment,
    );
    assert.equal(recorded.status, "waiting-no-change");
    await recordTicketNoChange(
      repository,
      candidate,
      configPath,
      baseEnvironment,
    );
    assert.equal(comments.get(2).length, 1, "candidate recording is idempotent");

    const waiting = await readBatchRunState(
      repository,
      batchId,
      configPath,
      baseEnvironment,
    );
    assert.equal(waiting.tickets[0].status, "waiting-no-change");

    await assert.rejects(
      acceptTicketNoChange(
        repository,
        { ...candidate, reason: "Already satisfied by the current base." },
        configPath,
        baseEnvironment,
      ),
      (error) => error.diagnostics?.[0]?.code === "NO_CHANGE_AUTHORIZATION_REQUIRED",
    );
    assert.equal(issues.get(2).state, "open");

    const ticketEvent = eventFile({
      batch_id: batchId,
      expected_head: base,
      operation: "accept-no-change",
      reason: "Already satisfied by the current base.",
      ticket: "2",
    });
    const accepted = await acceptTicketNoChange(
      repository,
      { ...candidate, reason: "Already satisfied by the current base." },
      configPath,
      {
        ...baseEnvironment,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: ticketEvent,
      },
    );
    assert.equal(accepted.status, "accepted-no-change");
    assert.equal(issues.get(2).state, "closed");

    const completedState = await readBatchRunState(
      repository,
      batchId,
      configPath,
      baseEnvironment,
    );
    assert.equal(completedState.tickets[0].status, "accepted-no-change");
    const run = await runBatch(
      repository,
      {
        batchId,
        limits,
        mode: "resume",
        runId: "9201",
        startedAt: "2026-07-22T12:01:00Z",
      },
      {
        dispatchContinuation: async () => assert.fail("must not continue"),
        processTicket: async () => assert.fail("must not create an empty commit"),
        readState: async () => completedState,
      },
    );
    assert.equal(run.status, "completed-no-change");

    const batchEvent = eventFile({
      batch_id: batchId,
      expected_head: base,
      operation: "complete-no-change",
      reason: "All child work was already satisfied.",
    });
    const completed = await completeNoChangeBatch(
      repository,
      {
        batchId,
        expectedHead: base,
        reason: "All child work was already satisfied.",
      },
      configPath,
      {
        ...baseEnvironment,
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: batchEvent,
      },
    );
    assert.equal(completed.status, "completed-no-change");
    assert.equal(issues.get(1).state, "closed");
    assert.match(comments.get(1)[0].body, /sandcastle-batch-no-change-completion/u);
    assert.equal(
      requests.some(({ url }) => url?.includes("/pulls")),
      false,
      "a cumulative zero-diff Batch must not create a PR",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
