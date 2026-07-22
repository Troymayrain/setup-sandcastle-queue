import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-frontier-repository-"));
  execFileSync("git", ["init", "--quiet", repository]);
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
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-frontier-config-"));
  const path = join(directory, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
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
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

function issue(
  number,
  {
    assignees = [],
    blockedBy = 0,
    body = `## Parent\n\n#1\n\n## Work\n\nTicket ${number}.`,
    labels = ["ready-for-agent", "sandcastle"],
    state = "open",
    title = `Ticket ${number}`,
  } = {},
) {
  return {
    assignees,
    body,
    html_url: `https://github.com/acme/widget/issues/${number}`,
    id: 1000 + number,
    issue_dependencies_summary: { blocked_by: blockedBy },
    labels: labels.map((name) => ({ name })),
    number,
    state,
    title,
    updated_at: `2026-07-${String(number).padStart(2, "0")}T00:00:00Z`,
  };
}

async function startGitHubServer({ oversizedList = false } = {}) {
  const requests = [];
  const parent = issue(1, {
    body: "# Parent PRD\n\nTrusted parent specification.",
    labels: [],
    title: "Parent PRD",
  });
  const latestIssues = new Map([
    [2, issue(2)],
    [3, issue(3, { labels: ["ready-for-agent"] })],
    [4, issue(4, { assignees: [{ login: "human" }] })],
    [5, issue(5, { state: "closed" })],
    [
      6,
      issue(6, {
        body: "## Parent\n\n#1\n\n## Parent\n\n#99\n",
      }),
    ],
    [7, issue(7, { blockedBy: 1 })],
    [
      8,
      issue(8, { labels: ["Ready-For-Agent", "SandCastle"] }),
    ],
    [9, issue(9, { body: "No Parent section here.\n" })],
    [10, issue(10, { body: "## Parent\n\nParent issue #1.\n" })],
  ]);
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (
      request.url ===
      "/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=1"
    ) {
      if (oversizedList) {
        response.end(
          JSON.stringify([
            {
              number: 2,
              padding: "x".repeat(16 * 1024 * 1024),
            },
          ]),
        );
        return;
      }
      response.setHeader(
        "link",
        '</repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=2>; rel="next"',
      );
      response.end(
        JSON.stringify([
          parent,
          issue(2, { labels: ["ready-for-agent"] }),
          issue(3, { labels: [] }),
        ]),
      );
      return;
    }
    if (
      request.url ===
      "/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=2"
    ) {
      response.end(JSON.stringify([...latestIssues.values()].slice(2)));
      return;
    }
    const issueMatch = request.url?.match(/^\/repos\/acme\/widget\/issues\/(\d+)$/u);
    if (issueMatch) {
      const number = Number(issueMatch[1]);
      const value = number === 1 ? parent : latestIssues.get(number);
      if (value) {
        response.end(JSON.stringify(value));
        return;
      }
    }
    const commentsMatch = request.url?.match(
      /^\/repos\/acme\/widget\/issues\/(\d+)\/comments\?per_page=100&page=1$/u,
    );
    if (commentsMatch) {
      const number = Number(commentsMatch[1]);
      if (number === 1) {
        response.end(
          JSON.stringify([
            {
              author_association: "OWNER",
              body: "Trusted parent clarification.",
              html_url: "https://github.com/acme/widget/issues/1#issuecomment-101",
              id: 101,
              updated_at: "2026-07-20T00:00:00Z",
            },
            {
              author_association: "CONTRIBUTOR",
              body: "Untrusted outsider text.",
              html_url: "https://github.com/acme/widget/issues/1#issuecomment-102",
              id: 102,
              updated_at: "2026-07-20T00:01:00Z",
            },
            {
              author_association: "MEMBER",
              body: "<!-- sandcastle:audit --> internal audit record",
              html_url: "https://github.com/acme/widget/issues/1#issuecomment-103",
              id: 103,
              updated_at: "2026-07-20T00:02:00Z",
            },
          ]),
        );
        return;
      }
      if (number === 2) {
        response.end(
          JSON.stringify([
            {
              author_association: "COLLABORATOR",
              body: "Trusted ticket clarification.",
              html_url: "https://github.com/acme/widget/issues/2#issuecomment-201",
              id: 201,
              updated_at: "2026-07-21T00:00:00Z",
            },
          ]),
        );
        return;
      }
      response.end("[]");
      return;
    }
    response.statusCode = 404;
    response.end('{"message":"Not Found"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    changeTicketBody(number, body) {
      const current = latestIssues.get(number);
      latestIssues.set(number, {
        ...current,
        body,
        updated_at: "2026-07-22T00:00:00Z",
      });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
    requests,
  };
}

function runCli(args, repository, environment) {
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

test("status computes a trusted paginated frontier from latest per-issue facts", async () => {
  const repository = createRepository();
  const github = await startGitHubServer();
  const token = "github-token-must-not-leak";
  try {
    const result = await runCli(
      ["status", "--parent", "1", "--config", writeConfig()],
      repository,
      {
        ...process.env,
        GITHUB_API_URL: github.apiUrl,
        GITHUB_TOKEN: token,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(token), false);
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "status");
    assert.equal(output.ok, true);
    assert.equal(output.result.repository, "acme/widget");
    assert.deepEqual(output.result.frontier, [2, 8]);
    assert.deepEqual(
      output.result.tickets.map(({ number, status }) => ({ number, status })),
      [
        { number: 2, status: "executable" },
        { number: 3, status: "awaiting-enrollment" },
        { number: 4, status: "blocked" },
        { number: 5, status: "complete" },
        { number: 6, status: "excluded" },
        { number: 7, status: "blocked" },
        { number: 8, status: "executable" },
        { number: 9, status: "excluded" },
        { number: 10, status: "excluded" },
      ],
    );
    const ticketTwo = output.result.tickets.find(({ number }) => number === 2);
    assert.deepEqual(
      ticketTwo.snapshot.parent.comments.map(({ id }) => id),
      [101],
    );
    assert.deepEqual(
      ticketTwo.snapshot.ticket.comments.map(({ id }) => id),
      [201],
    );
    assert.equal(ticketTwo.snapshot.parent.title, "Parent PRD");
    assert.match(ticketTwo.snapshot.parent.body, /Trusted parent specification/u);
    assert.equal(ticketTwo.snapshot.ticket.title, "Ticket 2");
    assert.match(ticketTwo.snapshot.ticket.body, /Ticket 2\./u);
    assert.match(ticketTwo.snapshot.parent.bodySha256, /^[a-f0-9]{64}$/u);
    assert.match(ticketTwo.snapshot.ticket.bodySha256, /^[a-f0-9]{64}$/u);
    assert.match(ticketTwo.snapshot.specHash, /^[a-f0-9]{64}$/u);
    assert.equal(
      github.requests.some(
        ({ url }) =>
          url ===
          "/repos/acme/widget/issues?state=all&sort=created&direction=asc&per_page=100&page=2",
      ),
      true,
    );
    assert.equal(
      github.requests.every(({ method }) => method === "GET"),
      true,
    );
  } finally {
    await github.close();
  }
});

test("status rejects an oversized GitHub response through the CLI boundary", async () => {
  const repository = createRepository();
  const github = await startGitHubServer({ oversizedList: true });
  try {
    const result = await runCli(
      ["status", "--parent", "1", "--config", writeConfig()],
      repository,
      {
        ...process.env,
        GITHUB_API_URL: github.apiUrl,
        GITHUB_TOKEN: "github-token-must-not-leak",
      },
    );

    assert.equal(result.status, 3, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).diagnostics[0].code,
      "GITHUB_API_INVALID_RESPONSE",
    );
  } finally {
    await github.close();
  }
});

test("verify-spec rejects a snapshot after trusted Ticket facts change", async () => {
  const repository = createRepository();
  const github = await startGitHubServer();
  const environment = {
    ...process.env,
    GITHUB_API_URL: github.apiUrl,
    GITHUB_TOKEN: "github-token-must-not-leak",
  };
  try {
    const status = await runCli(
      ["status", "--parent", "1", "--config", writeConfig()],
      repository,
      environment,
    );
    assert.equal(status.status, 0, status.stderr);
    const snapshot = JSON.parse(status.stdout).result.tickets.find(
      ({ number }) => number === 2,
    ).snapshot;
    const snapshotPath = join(
      mkdtempSync(join(tmpdir(), "sandcastle-spec-snapshot-")),
      "snapshot.json",
    );
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);

    const unchanged = await runCli(
      ["verify-spec", "--snapshot", snapshotPath],
      repository,
      environment,
    );
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(JSON.parse(unchanged.stdout).result.unchanged, true);

    github.changeTicketBody(
      2,
      "## Parent\n\n#1\n\n## Work\n\nTicket 2 changed after implementation.",
    );
    const changed = await runCli(
      ["verify-spec", "--snapshot", snapshotPath],
      repository,
      environment,
    );

    assert.equal(changed.status, 2, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).diagnostics[0].code, "SPEC_CHANGED");
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});

test("verify-spec rejects a snapshot whose recorded hash was tampered with", async () => {
  const repository = createRepository();
  const github = await startGitHubServer();
  const environment = {
    ...process.env,
    GITHUB_API_URL: github.apiUrl,
    GITHUB_TOKEN: "github-token-must-not-leak",
  };
  try {
    const status = await runCli(
      ["status", "--parent", "1", "--config", writeConfig()],
      repository,
      environment,
    );
    assert.equal(status.status, 0, status.stderr);
    const snapshot = JSON.parse(status.stdout).result.tickets.find(
      ({ number }) => number === 2,
    ).snapshot;
    snapshot.specHash = "0".repeat(64);
    const snapshotPath = join(
      mkdtempSync(join(tmpdir(), "sandcastle-tampered-snapshot-")),
      "snapshot.json",
    );
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`);

    const result = await runCli(
      ["verify-spec", "--snapshot", snapshotPath],
      repository,
      environment,
    );

    assert.equal(result.status, 2, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).diagnostics[0].code,
      "SPEC_SNAPSHOT_INVALID",
    );
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});
