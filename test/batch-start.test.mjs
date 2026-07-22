import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const baseSha = "a".repeat(40);

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-start-repository-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Sandcastle Test",
    "-c",
    "user.email=sandcastle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  execFileSync("git", [
    "-C",
    repository,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/widget.git",
  ]);
  return repository;
}

function writeConfig() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-start-config-"));
  const path = join(directory, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      queue: {
        ownershipLabel: "sandcastle",
        readyLabel: "ready-for-agent",
      },
      runtime: { adapter: "node-npm", version: "22.22.2" },
      commands: { tests: [{ argv: ["npm", "test"] }], verification: [] },
      provider: {
        kind: "anthropic-compatible",
        models: { ticket: "ticket-model" },
      },
      execution: {
        jobTimeoutMinutes: 350,
        maxTicketsPerRun: 3,
        minimumRemainingMinutes: 140,
        processingBudgetMinutes: 300,
        ticketTimeoutMinutes: 120,
      },
      audit: { retentionDays: 30 },
    })}\n`,
  );
  return path;
}

function issue(
  number,
  {
    assignees = [],
    blockedBy = 0,
    body = `## Parent\n\n#1\n\n## Work\n\nTicket ${number}.`,
    labels = ["ready-for-agent"],
    state = "open",
  } = {},
) {
  return {
    assignees,
    body,
    html_url: `https://github.com/acme/widget/issues/${number}`,
    id: 2000 + number,
    issue_dependencies_summary: { blocked_by: blockedBy },
    labels: labels.map((name) => ({ name })),
    number,
    state,
    title: number === 1 ? "Parent PRD" : `Ticket ${number}`,
    updated_at: "2026-07-22T00:00:00Z",
  };
}

async function requestBody(request) {
  let source = "";
  for await (const chunk of request) {
    source += chunk;
  }
  return source ? JSON.parse(source) : null;
}

async function startGitHubServer() {
  const parent = issue(1, {
    body: "# Parent PRD\n\nDeliver the queue.",
    labels: [],
  });
  const issues = new Map([
    [2, issue(2)],
    [3, issue(3, { labels: ["ready-for-agent", "sandcastle"] })],
    [4, issue(4, { labels: [] })],
    [5, issue(5, { assignees: [{ login: "human" }] })],
    [6, issue(6, { blockedBy: 1 })],
    [7, issue(7, { state: "closed" })],
    [8, issue(8, { body: "## Parent\n\n#99\n" })],
  ]);
  const requests = [];
  let activeRef = null;
  const batchRefs = new Map();
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({ body, method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");

    if (request.method === "GET" && request.url === "/repos/acme/widget") {
      response.end(JSON.stringify({ default_branch: "main" }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/git/ref/heads/main"
    ) {
      response.end(JSON.stringify({ object: { sha: baseSha } }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/git/ref/heads/sandcastle%2Factive"
    ) {
      if (activeRef) {
        response.end(JSON.stringify({ object: { sha: activeRef } }));
      } else {
        response.statusCode = 404;
        response.end('{"message":"Not Found"}');
      }
      return;
    }
    if (
      request.method === "GET" &&
      request.url ===
        "/repos/acme/widget/actions/workflows/sandcastle.yml/runs?per_page=100&page=1"
    ) {
      response.end('{"workflow_runs":[]}');
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/pulls?state=open&per_page=100&page=1"
    ) {
      response.end("[]");
      return;
    }
    if (
      request.method === "GET" &&
      request.url ===
        "/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=1"
    ) {
      response.end(JSON.stringify([parent, ...issues.values()]));
      return;
    }
    const issueMatch = request.url?.match(/^\/repos\/acme\/widget\/issues\/(\d+)$/u);
    if (request.method === "GET" && issueMatch) {
      const number = Number(issueMatch[1]);
      const value = number === 1 ? parent : issues.get(number);
      if (value) {
        response.end(JSON.stringify(value));
        return;
      }
    }
    if (
      request.method === "GET" &&
      /^\/repos\/acme\/widget\/issues\/\d+\/comments\?per_page=100&page=1$/u.test(
        request.url ?? "",
      )
    ) {
      response.end("[]");
      return;
    }
    const labelMatch = request.url?.match(
      /^\/repos\/acme\/widget\/issues\/(\d+)\/labels$/u,
    );
    if (request.method === "POST" && labelMatch) {
      const number = Number(labelMatch[1]);
      const current = issues.get(number);
      for (const name of body.labels) {
        if (!current.labels.some((label) => label.name === name)) {
          current.labels.push({ name });
        }
      }
      response.end(JSON.stringify(current.labels));
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
    if (
      request.method === "POST" &&
      request.url === "/repos/acme/widget/git/refs"
    ) {
      if (body.ref === "refs/heads/sandcastle/active") {
        if (activeRef) {
          response.statusCode = 422;
          response.end('{"message":"Reference already exists"}');
          return;
        }
        activeRef = body.sha;
      } else {
        batchRefs.set(body.ref, body.sha);
      }
      response.statusCode = 201;
      response.end(JSON.stringify({ object: { sha: body.sha }, ref: body.ref }));
      return;
    }
    if (
      request.method === "DELETE" &&
      request.url === "/repos/acme/widget/git/refs/heads/sandcastle%2Factive"
    ) {
      activeRef = null;
      response.statusCode = 204;
      response.end();
      return;
    }

    response.statusCode = 404;
    response.end('{"message":"Not Found"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    batchRefs,
    close: () => new Promise((resolve) => server.close(resolve)),
    requests,
  };
}

function runCli(args, repository, environment = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath.pathname, ...args], {
      cwd: repository,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });
}

test("start explicitly enrolls selected Tickets before dispatching one stable Batch", async () => {
  const repository = createRepository();
  const config = writeConfig();
  const github = await startGitHubServer();
  const environment = {
    ...process.env,
    GITHUB_API_URL: github.apiUrl,
    GITHUB_TOKEN: "github-token-must-not-leak",
  };
  try {
    const candidates = await runCli(
      ["start", "--parent", "1", "--config", config],
      repository,
      environment,
    );
    assert.equal(candidates.status, 0, candidates.stderr);
    const candidateOutput = JSON.parse(candidates.stdout);
    assert.equal(candidateOutput.result.mode, "preview");
    assert.deepEqual(candidateOutput.result.enrollmentCandidates, [2]);
    assert.deepEqual(candidateOutput.result.executableTickets, [3]);
    assert.deepEqual(candidateOutput.result.selectedTickets, []);
    assert.equal(candidateOutput.result.confirmationHash, null);
    assert.equal(
      github.requests.some(({ method }) => method !== "GET"),
      false,
    );

    const selected = await runCli(
      ["start", "--parent", "1", "--config", config, "--enroll", "2"],
      repository,
      environment,
    );
    assert.equal(selected.status, 0, selected.stderr);
    const selectedOutput = JSON.parse(selected.stdout);
    assert.deepEqual(selectedOutput.result.selectedTickets, [2]);
    assert.match(selectedOutput.result.confirmationHash, /^[a-f0-9]{64}$/u);

    const beforeRejectedConfirmation = github.requests.filter(
      ({ method }) => method !== "GET",
    ).length;
    const rejected = await runCli(
      [
        "start",
        "--parent",
        "1",
        "--config",
        config,
        "--enroll",
        "2",
        "--confirm",
        "0".repeat(64),
      ],
      repository,
      environment,
    );
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.equal(
      JSON.parse(rejected.stdout).diagnostics[0].code,
      "BATCH_START_NOT_CONFIRMED",
    );
    assert.equal(
      github.requests.filter(({ method }) => method !== "GET").length,
      beforeRejectedConfirmation,
    );

    const applied = await runCli(
      [
        "start",
        "--parent",
        "1",
        "--config",
        config,
        "--enroll",
        "2",
        "--confirm",
        selectedOutput.result.confirmationHash,
      ],
      repository,
      environment,
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedOutput = JSON.parse(applied.stdout);
    assert.equal(appliedOutput.result.mode, "dispatched");
    assert.deepEqual(appliedOutput.result.enrolledTickets, [2]);
    assert.equal(appliedOutput.result.baseSha, baseSha);
    const labelWrites = github.requests.filter(({ url }) => url?.endsWith("/labels"));
    assert.deepEqual(labelWrites.map(({ body }) => body), [
      { labels: ["sandcastle"] },
    ]);
    const dispatch = github.requests.find(({ url }) => url?.endsWith("/dispatches"));
    assert.deepEqual(dispatch.body, {
      inputs: { base_sha: baseSha, operation: "start", parent: "1" },
      ref: "main",
    });

    const beforeInitialization = github.requests.length;
    const initialized = await runCli(
      [
        "initialize-batch",
        "--parent",
        "1",
        "--base-sha",
        baseSha,
        "--run-id",
        "9001",
        "--config",
        config,
      ],
      repository,
      environment,
    );
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.deepEqual(JSON.parse(initialized.stdout).result, {
      branch: "sandcastle/p1-aaaaaaaaaaaa-r9001",
      id: "p1-aaaaaaaaaaaa-r9001",
      initialRunId: "9001",
      originalBaseSha: baseSha,
      parent: 1,
      schemaVersion: 1,
      state: "processing",
      verifiedTickets: [2, 3],
    });
    const initializationRequests = github.requests.slice(beforeInitialization);
    assert.equal(
      initializationRequests.some(({ url }) => url?.endsWith("/labels")),
      false,
    );
    assert.deepEqual([...github.batchRefs], [
      ["refs/heads/sandcastle/p1-aaaaaaaaaaaa-r9001", baseSha],
    ]);

    const duplicate = await runCli(
      [
        "initialize-batch",
        "--parent",
        "1",
        "--base-sha",
        baseSha,
        "--run-id",
        "9002",
        "--config",
        config,
      ],
      repository,
      environment,
    );
    assert.equal(duplicate.status, 2, duplicate.stderr);
    assert.equal(
      JSON.parse(duplicate.stdout).diagnostics[0].code,
      "BATCH_ALREADY_ACTIVE",
    );
  } finally {
    await github.close();
  }
});

test("installation preview generates repository concurrency without a branch input", async () => {
  const repository = createRepository();
  const planned = await runCli(
    ["plan", "--config", writeConfig()],
    repository,
  );

  assert.equal(planned.status, 0, planned.stderr);
  const patch = JSON.parse(planned.stdout).result.patch;
  assert.match(patch, /\+concurrency:\n\+  group: sandcastle-\$\{\{ github\.repository \}\}/u);
  assert.match(patch, /\+      - name: Initialize stable Batch/u);
  assert.match(patch, /initialize-batch/u);
  assert.doesNotMatch(patch, /integration[_-]branch/iu);
});
