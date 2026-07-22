import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function requestBody(request) {
  let source = "";
  for await (const chunk of request) source += chunk;
  return source ? JSON.parse(source) : null;
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-audit-repository-"));
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
  return repository;
}

function config(retentionDays = 30) {
  return {
    audit: { retentionDays },
    commands: { tests: [{ argv: ["npm", "test"] }], verification: [] },
    execution: {
      jobTimeoutMinutes: 350,
      maxTicketsPerRun: 3,
      minimumRemainingMinutes: 140,
      processingBudgetMinutes: 300,
      ticketTimeoutMinutes: 120,
    },
    provider: { kind: "anthropic-compatible", models: { ticket: "ticket" } },
    queue: { ownershipLabel: "sandcastle", readyLabel: "ready-for-agent" },
    runtime: { adapter: "node-npm", version: "22.22.2" },
    schemaVersion: 1,
  };
}

function auditInput() {
  return {
    batch: {
      branch: "sandcastle/p1-aaaaaaaaaaaa-r9001",
      id: "p1-aaaaaaaaaaaa-r9001",
      parent: 1,
    },
    dependencies: {
      lockfile: "1".repeat(64),
      runtimeSkills: "2".repeat(64),
    },
    heads: {
      end: "b".repeat(40),
      reviewed: "b".repeat(40),
      start: "a".repeat(40),
      targetBase: "c".repeat(40),
    },
    outcome: "checkpointed",
    predecessorRunId: "9100",
    runId: "9101",
    runtimeImage: `ghcr.io/acme/control@sha256:${"d".repeat(64)}`,
    schemaVersion: 1,
    tickets: [
      {
        commit: "e".repeat(40),
        reviewHead: "e".repeat(40),
        sessionId: "123e4567-e89b-42d3-a456-426614174000",
        skills: {
          codeReview: { ok: true, receiptId: "review-receipt-2" },
          implement: { ok: true, receiptId: "implement-receipt-2" },
          tdd: { ok: true, receiptId: "tdd-receipt-2" },
        },
        ticket: 2,
        verificationHash: "f".repeat(64),
      },
      {
        commit: null,
        reviewHead: null,
        sessionId: "223e4567-e89b-42d3-a456-426614174001",
        skills: {
          codeReview: null,
          implement: { ok: true, receiptId: "implement-receipt-3" },
          tdd: { ok: true, receiptId: "tdd-receipt-3" },
        },
        ticket: 3,
        verificationHash: null,
      },
    ],
    timing: {
      finishedAt: "2026-07-22T12:30:00.000Z",
      startedAt: "2026-07-22T10:00:00.000Z",
    },
  };
}

test("run audit uploads a 30-day sanitized artifact and appends immutable summary/correction events", async () => {
  const { publishRunAudit } = await import("../dist/index.js");
  const repository = createRepository();
  const configPath = join(mkdtempSync(join(tmpdir(), "sandcastle-audit-config-")), "config.json");
  writeFileSync(configPath, `${JSON.stringify(config())}\n`);
  const artifactPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-audit-artifact-")),
    "run-audit.json",
  );
  const requests = [];
  const comments = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({ body, method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/pulls?state=all&per_page=100&page=1"
    ) {
      response.end(
        JSON.stringify([
          {
            head: { ref: "sandcastle/p1-aaaaaaaaaaaa-r9001" },
            number: 44,
          },
        ]),
      );
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/repos/acme/widget/issues/44/comments"
    ) {
      comments.push(body.body);
      response.statusCode = 201;
      response.end(JSON.stringify({ id: 5000 + comments.length }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ url: request.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const uploads = [];
  const environment = {
    ...process.env,
    GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    GITHUB_REPOSITORY: "acme/widget",
    GITHUB_TOKEN: "github-token-must-not-be-retained",
  };
  try {
    const published = await publishRunAudit(
      repository,
      configPath,
      auditInput(),
      artifactPath,
      {
        async uploadArtifact(request) {
          uploads.push({
            ...request,
            body: JSON.parse(readFileSync(request.path, "utf8")),
          });
          return { artifactId: "artifact-9101" };
        },
      },
      environment,
    );
    assert.equal(published.retentionDays, 30);
    assert.match(published.eventId, /^[0-9a-f-]{36}$/u);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].retentionDays, 30);
    assert.equal(uploads[0].name, "sandcastle-run-9101-audit");
    assert.equal(uploads[0].body.eventId, published.eventId);
    assert.equal(uploads[0].body.durationMs, 9_000_000);
    assert.deepEqual(uploads[0].body.tickets[0].skills, auditInput().tickets[0].skills);

    const retained = JSON.stringify({ comments, uploads });
    for (const forbidden of [
      "github-token-must-not-be-retained",
      "raw transcript",
      "prompt",
      "response",
      "environment",
      "full command output",
    ]) {
      assert.equal(retained.includes(forbidden), false);
    }
    assert.equal(comments.length, 1);
    assert.match(comments[0], /sandcastle-run-audit/u);
    assert.match(comments[0], new RegExp(published.eventId, "u"));
    assert.equal(
      requests.some(({ method }) => method === "PATCH" || method === "DELETE"),
      false,
    );

    const correctionPath = join(
      mkdtempSync(join(tmpdir(), "sandcastle-audit-correction-")),
      "correction.json",
    );
    const correctionInput = {
      ...auditInput(),
      correctionOf: published.eventId,
      outcome: "correction",
      runId: "9102",
      timing: {
        finishedAt: "2026-07-22T12:35:01.000Z",
        startedAt: "2026-07-22T12:35:00.000Z",
      },
    };
    await publishRunAudit(
      repository,
      configPath,
      correctionInput,
      correctionPath,
      {
        async uploadArtifact(request) {
          uploads.push(request);
          return { artifactId: "artifact-9102" };
        },
      },
      environment,
    );
    assert.equal(comments.length, 2);
    assert.match(comments[1], new RegExp(`correctionOf.*${published.eventId}`, "su"));
    assert.equal(comments[0].includes("correctionOf"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("untrusted text claims and reused sessions cannot impersonate host skill receipts", async () => {
  const { publishRunAudit } = await import("../dist/index.js");
  const repository = createRepository();
  const configPath = join(mkdtempSync(join(tmpdir(), "sandcastle-audit-config-")), "config.json");
  writeFileSync(configPath, `${JSON.stringify(config())}\n`);
  const runtime = {
    uploadArtifact: async () => assert.fail("invalid evidence must not upload"),
  };
  const environment = {
    ...process.env,
    GITHUB_REPOSITORY: "acme/widget",
    GITHUB_TOKEN: "test-token",
  };
  const claimed = auditInput();
  claimed.tickets[0].claims = "I called implement, tdd, and code-review successfully";
  await assert.rejects(
    publishRunAudit(
      repository,
      configPath,
      claimed,
      join(tmpdir(), "invalid-claims-audit.json"),
      runtime,
      environment,
    ),
    (error) => error.diagnostics?.[0]?.code === "AUDIT_EVIDENCE_INVALID",
  );

  const reused = auditInput();
  reused.tickets[1].sessionId = reused.tickets[0].sessionId;
  await assert.rejects(
    publishRunAudit(
      repository,
      configPath,
      reused,
      join(tmpdir(), "reused-session-audit.json"),
      runtime,
      environment,
    ),
    (error) => error.diagnostics?.[0]?.code === "AUDIT_SESSION_REUSED",
  );

  await assert.rejects(
    publishRunAudit(
      repository,
      configPath,
      auditInput(),
      join(repository, "audit.json"),
      runtime,
      environment,
    ),
    (error) => error.diagnostics?.[0]?.code === "AUDIT_PATH_FORBIDDEN",
  );
});

test("a partial run without a Batch PR falls back to an append-only parent audit", async () => {
  const { publishRunAudit } = await import("../dist/index.js");
  const repository = createRepository();
  const configPath = join(mkdtempSync(join(tmpdir(), "sandcastle-audit-config-")), "config.json");
  writeFileSync(configPath, `${JSON.stringify(config())}\n`);
  const artifactPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-audit-partial-")),
    "partial.json",
  );
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({ body, method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/pulls?state=all&per_page=100&page=1"
    ) {
      response.end("[]");
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/repos/acme/widget/issues/1/comments"
    ) {
      response.statusCode = 201;
      response.end(JSON.stringify({ id: 6001 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ url: request.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const uploads = [];
  try {
    const partial = {
      ...auditInput(),
      heads: {
        ...auditInput().heads,
        end: auditInput().heads.start,
        reviewed: null,
      },
      outcome: "partial",
      predecessorRunId: null,
      tickets: [],
      timing: {
        finishedAt: "2026-07-22T10:00:01.000Z",
        startedAt: "2026-07-22T10:00:00.000Z",
      },
    };
    const published = await publishRunAudit(
      repository,
      configPath,
      partial,
      artifactPath,
      {
        async uploadArtifact(request) {
          uploads.push(JSON.parse(readFileSync(request.path, "utf8")));
          return { artifactId: "artifact-partial-9101" };
        },
      },
      {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        GITHUB_REPOSITORY: "acme/widget",
        GITHUB_TOKEN: "partial-token-must-not-be-retained",
      },
    );
    assert.deepEqual(published.commentTarget, { kind: "issue", number: 1 });
    assert.equal(uploads[0].outcome, "partial");
    assert.equal(uploads[0].durationMs, 1_000);
    assert.equal(
      requests.some(
        ({ method, url }) =>
          method === "POST" && url === "/repos/acme/widget/issues/1/comments",
      ),
      true,
    );
    assert.equal(
      JSON.stringify({ requests, uploads }).includes("partial-token-must-not-be-retained"),
      false,
    );
    assert.equal(
      execFileSync("git", ["-C", repository, "status", "--porcelain"], {
        encoding: "utf8",
      }),
      "",
    );
    assert.equal(
      execFileSync("git", ["-C", repository, "tag", "--list"], {
        encoding: "utf8",
      }),
      "",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
