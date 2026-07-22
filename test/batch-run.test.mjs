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

function state(tickets, remoteHead = "a".repeat(40)) {
  return {
    activeHead: remoteHead,
    batchId: "p1-aaaaaaaaaaaa-r9001",
    branch: "sandcastle/p1-aaaaaaaaaaaa-r9001",
    defaultBranch: "main",
    initialRunId: "9001",
    originalBaseSha: "a".repeat(40),
    parent: 1,
    remoteHead,
    tickets,
  };
}

function ticket(number, status = "executable") {
  return { number, reasons: [], status };
}

test("a processing run executes at most three Tickets sequentially in issue-number order and checkpoints", async () => {
  const { runBatch } = await import("../dist/index.js");
  let current = state([ticket(8), ticket(2), ticket(5), ticket(3)]);
  const processed = [];
  const dispatches = [];
  let active = false;
  const result = await runBatch(
    "/unused",
    {
      batchId: current.batchId,
      limits,
      mode: "process",
      runId: "9100",
      startedAt: "2026-07-22T00:00:00.000Z",
    },
    {
      dispatchContinuation(input) {
        dispatches.push(input);
      },
      now: () => new Date("2026-07-22T00:01:00.000Z"),
      processTicket: async ({ beforeHead, number, signal }) => {
        assert.equal(active, false, "Tickets must never overlap");
        assert.equal(signal.aborted, false);
        active = true;
        await Promise.resolve();
        processed.push(number);
        const head = String(number).repeat(40).slice(0, 40);
        current = state(
          current.tickets.map((candidate) =>
            candidate.number === number
              ? ticket(number, "published")
              : candidate,
          ),
          head,
        );
        active = false;
        return { beforeHead, head, status: "published", ticket: number };
      },
      readState: async () => structuredClone(current),
    },
  );

  assert.deepEqual(processed, [2, 3, 5]);
  assert.equal(result.status, "checkpointed");
  assert.equal(result.reason, "ticket-limit");
  assert.deepEqual(result.processedTickets, [2, 3, 5]);
  assert.deepEqual(dispatches, [
    {
      batchId: current.batchId,
      expectedHead: current.remoteHead,
      predecessorRunId: "9100",
    },
  ]);
});

test("the first Ticket failure stops the run without dispatching a continuation", async () => {
  const { runBatch } = await import("../dist/index.js");
  const current = state([ticket(2), ticket(3), ticket(4)]);
  const processed = [];
  const dispatches = [];
  const result = await runBatch(
    "/unused",
    {
      batchId: current.batchId,
      limits,
      mode: "resume",
      runId: "9101",
      startedAt: "2026-07-22T00:00:00.000Z",
    },
    {
      dispatchContinuation: async (input) => dispatches.push(input),
      now: () => new Date("2026-07-22T00:01:00.000Z"),
      processTicket: async ({ number }) => {
        processed.push(number);
        throw new Error("host verification failed");
      },
      readState: async () => structuredClone(current),
    },
  );

  assert.deepEqual(processed, [2]);
  assert.deepEqual(dispatches, []);
  assert.equal(result.status, "failed");
  assert.equal(result.failedTicket, 2);
  assert.deepEqual(result.processedTickets, []);
});

test("a run checkpoints before starting a Ticket with fewer than 140 job minutes left", async () => {
  const { runBatch } = await import("../dist/index.js");
  let current = state([ticket(2), ticket(3)]);
  let now = new Date("2026-07-22T00:00:00.000Z");
  const dispatches = [];
  const result = await runBatch(
    "/unused",
    {
      batchId: current.batchId,
      limits,
      mode: "process",
      runId: "9102",
      startedAt: now.toISOString(),
    },
    {
      dispatchContinuation: async (input) => dispatches.push(input),
      now: () => now,
      processTicket: async ({ beforeHead, number }) => {
        const head = "b".repeat(40);
        current = state([ticket(2, "published"), ticket(3)], head);
        now = new Date("2026-07-22T03:31:00.000Z");
        return { beforeHead, head, status: "published", ticket: number };
      },
      readState: async () => structuredClone(current),
    },
  );

  assert.equal(result.status, "checkpointed");
  assert.equal(result.reason, "time-budget");
  assert.deepEqual(result.processedTickets, [2]);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].expectedHead, "b".repeat(40));
});

test("stale continuation exits safely and resume classifies authoritative queue states", async () => {
  const { runBatch } = await import("../dist/index.js");
  const current = state([ticket(2), ticket(3)], "b".repeat(40));
  let processCalls = 0;
  const stale = await runBatch(
    "/unused",
    {
      batchId: current.batchId,
      expectedHead: "a".repeat(40),
      limits,
      mode: "continuation",
      predecessorRunId: "9100",
      runId: "9103",
      startedAt: "2026-07-22T00:00:00.000Z",
    },
    {
      dispatchContinuation: async () => assert.fail("must not dispatch"),
      now: () => new Date("2026-07-22T00:01:00.000Z"),
      processTicket: async () => {
        processCalls += 1;
        throw new Error("must not process");
      },
      readState: async () => structuredClone(current),
    },
  );
  assert.equal(stale.status, "stale-continuation");
  assert.equal(processCalls, 0);

  for (const [tickets, expected] of [
    [[ticket(2, "awaiting-enrollment")], "awaiting-enrollment"],
    [[ticket(2, "blocked")], "blocked"],
    [[ticket(2, "conflict")], "conflict"],
    [
      [ticket(2, "preexisting-complete"), ticket(3, "published")],
      "ready-for-final-review",
    ],
  ]) {
    const snapshot = state(
      tickets,
      expected === "ready-for-final-review" ? "b".repeat(40) : undefined,
    );
    const resumed = await runBatch(
      "/unused",
      {
        batchId: snapshot.batchId,
        limits,
        mode: "resume",
        runId: "9104",
        startedAt: "2026-07-22T00:00:00.000Z",
      },
      {
        dispatchContinuation: async () => assert.fail("must not dispatch"),
        now: () => new Date("2026-07-22T00:01:00.000Z"),
        processTicket: async () => assert.fail("must not redo completed Tickets"),
        readState: async () => structuredClone(snapshot),
      },
    );
    assert.equal(resumed.status, expected);
  }
});

function issue(number, overrides = {}) {
  return {
    assignees: [],
    body: number === 1 ? "# Parent" : "## Parent\n\n#1\n",
    closed_at: null,
    html_url: `https://github.com/acme/widget/issues/${number}`,
    id: 2000 + number,
    issue_dependencies_summary: { blocked_by: 0 },
    labels: [{ name: "ready-for-agent" }, { name: "sandcastle" }],
    number,
    state: "open",
    title: number === 1 ? "Parent" : `Ticket ${number}`,
    updated_at: "2026-07-22T10:30:00Z",
    ...overrides,
  };
}

async function requestBody(request) {
  let source = "";
  for await (const chunk of request) source += chunk;
  return source ? JSON.parse(source) : null;
}

test("Batch state is rebuilt from latest GitHub issues, run time, commits, and publication records", async () => {
  const { dispatchBatchContinuation, readBatchRunState } = await import(
    "../dist/index.js"
  );
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-run-state-"));
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
  const published = "b".repeat(40);
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
    [1, issue(1, { labels: [] })],
    [
      2,
      issue(2, {
        closed_at: "2026-07-22T09:00:00Z",
        state: "closed",
      }),
    ],
    [
      3,
      issue(3, {
        closed_at: "2026-07-22T11:00:00Z",
        state: "closed",
      }),
    ],
    [4, issue(4, { labels: [{ name: "ready-for-agent" }] })],
    [5, issue(5, { assignees: [{ login: "human" }] })],
    [
      6,
      issue(6, {
        closed_at: "2026-07-22T11:00:00Z",
        state: "closed",
      }),
    ],
    [7, issue(7)],
  ]);
  const publicationRecord = {
    batchId,
    commit: published,
    pullRequest: {
      draft: true,
      number: 44,
      url: "https://github.com/acme/widget/pull/44",
    },
    schemaVersion: 1,
    sessionId,
    ticket: 3,
  };
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({ body, method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/acme/widget") {
      response.end('{"default_branch":"main"}');
      return;
    }
    if (
      request.url ===
        `/repos/acme/widget/git/ref/heads/${encodeURIComponent(branch)}` ||
      request.url === "/repos/acme/widget/git/ref/heads/sandcastle%2Factive"
    ) {
      response.end(JSON.stringify({ object: { sha: published } }));
      return;
    }
    if (request.url === "/repos/acme/widget/actions/runs/9001") {
      response.end(
        '{"created_at":"2026-07-22T10:00:00Z","id":9001,"repository":{"full_name":"acme/widget"}}',
      );
      return;
    }
    if (
      request.url ===
      "/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=1"
    ) {
      response.end(JSON.stringify([...issues.values()].map(({ number }) => ({ number }))));
      return;
    }
    const issueMatch = request.url?.match(/^\/repos\/acme\/widget\/issues\/(\d+)$/u);
    if (issueMatch) {
      response.end(JSON.stringify(issues.get(Number(issueMatch[1]))));
      return;
    }
    const commentsMatch = request.url?.match(
      /^\/repos\/acme\/widget\/issues\/(\d+)\/comments\?per_page=100&page=1$/u,
    );
    if (commentsMatch) {
      const number = Number(commentsMatch[1]);
      response.end(
        JSON.stringify(
          number === 3
            ? [
                {
                  body: `Published.\n\n<!-- sandcastle-ticket-publication\n${JSON.stringify(publicationRecord)}\n-->`,
                  id: 3003,
                },
              ]
            : [],
        ),
      );
      return;
    }
    if (
      request.url ===
      `/repos/acme/widget/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=1`
    ) {
      response.end(
        JSON.stringify([
          {
            commit: {
              message: `Ticket #3\n\nSandcastle-Batch: ${batchId}\nSandcastle-Ticket: 3\nSandcastle-Session: ${sessionId}\n`,
            },
            parents: [{ sha: base }],
            sha: published,
          },
          {
            commit: { message: "Base" },
            parents: [{ sha: "0".repeat(40) }],
            sha: base,
          },
        ]),
      );
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/repos/acme/widget/actions/workflows/sandcastle.yml/dispatches"
    ) {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ url: request.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const observed = await readBatchRunState(repository, batchId, configPath, {
      ...process.env,
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "test-token",
    });
    assert.equal(observed.remoteHead, published);
    assert.equal(observed.activeHead, published);
    assert.equal(observed.originalBaseSha, base);
    assert.deepEqual(
      observed.tickets.map(({ number, status }) => [number, status]),
      [
        [2, "preexisting-complete"],
        [3, "published"],
        [4, "awaiting-enrollment"],
        [5, "blocked"],
        [6, "conflict"],
        [7, "executable"],
      ],
    );
    assert.equal(
      requests.some(({ url }) => url === "/repos/acme/widget/issues/7"),
      true,
      "latest per-issue reads must replace list snapshots",
    );
    await dispatchBatchContinuation(
      repository,
      observed,
      {
        batchId,
        expectedHead: published,
        predecessorRunId: "9100",
      },
      {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_REPOSITORY: "acme/widget",
        GITHUB_TOKEN: "test-token",
      },
    );
    const dispatch = requests.find(
      ({ method, url }) =>
        method === "POST" && url?.endsWith("/sandcastle.yml/dispatches"),
    );
    assert.deepEqual(dispatch.body, {
      inputs: {
        batch_id: batchId,
        expected_head: published,
        operation: "continue",
        predecessor_run_id: "9100",
      },
      ref: "main",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
