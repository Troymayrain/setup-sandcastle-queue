import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeProcessingRun } from "../dist/processing-run.js";

const baseHead = "1".repeat(40);
const agentCommit = "a".repeat(40);
const completionCommit = "2".repeat(40);

function options(root) {
  const promptFile = join(root, "ticket.md");
  writeFileSync(promptFile, "# Ticket\n\nImplement the selected Ticket.\n");
  return {
    baseBranch: "main",
    commands: {
      bootstrap: [{ argv: ["fixture", "bootstrap"] }],
      test: [{ argv: ["fixture", "test"] }],
      verification: [{ argv: ["fixture", "verify"] }],
    },
    environment: {
      ANTHROPIC_AUTH_TOKEN: "provider-secret",
      ANTHROPIC_BASE_URL: "https://provider.example",
      GITHUB_RUN_ID: "9001",
      GITHUB_TOKEN: "github-secret",
    },
    integrationBranch: "sandcastle/integration",
    model: "ticket-model",
    promptFile,
    repository: root,
    ticket: {
      body: "## What to build\n\nOne result.\n",
      number: 58,
    },
  };
}

function successfulBoundary(events, overrides = {}, initialIntegrationHead = null) {
  let integrationHead = initialIntegrationHead;
  let localHead = agentCommit;
  return {
    async annotateCompletionCommit(metadata) {
      events.push(["annotate", metadata]);
      localHead = completionCommit;
      return completionCommit;
    },
    async checkoutIntegration(branch, head) {
      events.push(["checkout", branch, head]);
    },
    async closeIssue(issue) {
      events.push(["close", issue]);
    },
    async commitParents(commit) {
      events.push(["parents", commit]);
      return [baseHead];
    },
    async createDraftPullRequest(input) {
      events.push(["createDraftPr", input]);
      return { draft: true, number: 17, url: "https://example.invalid/pr/17" };
    },
    async createIntegrationBranch(branch, head) {
      events.push(["createBranch", branch, head]);
      assert.equal(integrationHead, null);
      integrationHead = head;
    },
    async createPublicationMarker(issue, marker) {
      events.push(["marker", issue, marker]);
      return { id: 501 };
    },
    async isClean() {
      events.push(["clean"]);
      return true;
    },
    async listIntegrationPullRequests(input) {
      events.push(["listPr", input]);
      return [];
    },
    async localHead() {
      events.push(["localHead"]);
      return localHead;
    },
    async pushIntegration(branch, before, after) {
      events.push(["push", branch, before, after]);
      integrationHead = after;
    },
    async remoteHead(branch) {
      events.push(["remoteHead", branch]);
      if (branch === "main") return baseHead;
      return integrationHead;
    },
    async runCommand(argv, environment) {
      events.push(["command", argv, environment]);
    },
    ...overrides,
  };
}

function successfulWorkUnit(events, overrides = {}) {
  return async (input) => {
    events.push(["sandcastle", input]);
    return {
      branch: "sandcastle/integration",
      commits: [agentCommit],
      role: "ticket",
      sessionId: "fresh-session-58",
      status: "complete",
      streamSummary: { jsonLines: 1, lineCount: 1, textLines: 0 },
      ...overrides,
    };
  };
}

test("one bounded Processing Run creates the Integration Branch and publishes in the safe order", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-ticket-run-"));
  const events = [];

  const result = await executeProcessingRun(
    options(root),
    successfulBoundary(events),
    successfulWorkUnit(events),
  );

  assert.equal(result.status, "published");
  assert.equal(result.beforeHead, baseHead);
  assert.equal(result.completionCommit, completionCommit);
  assert.equal(result.pullRequest.draft, true);

  const names = events.map(([name]) => name);
  assert.ok(names.indexOf("createBranch") < names.indexOf("checkout"));
  assert.deepEqual(
    events.filter(([name]) => name === "command").map(([, argv]) => argv),
    [
      ["fixture", "bootstrap"],
      ["fixture", "test"],
      ["fixture", "verify"],
    ],
  );
  assert.ok(names.indexOf("command") < names.indexOf("sandcastle"));
  assert.ok(names.lastIndexOf("command") < names.indexOf("parents"));
  assert.ok(names.indexOf("parents") < names.indexOf("annotate"));
  assert.ok(names.indexOf("annotate") < names.indexOf("push"));
  assert.ok(names.indexOf("push") < names.lastIndexOf("remoteHead"));
  assert.ok(names.lastIndexOf("remoteHead") < names.indexOf("marker"));
  assert.ok(names.lastIndexOf("remoteHead") < names.indexOf("createDraftPr"));
  assert.ok(names.indexOf("createDraftPr") < names.indexOf("marker"));
  assert.ok(names.indexOf("marker") < names.indexOf("close"));

  const sandcastle = events.find(([name]) => name === "sandcastle")[1];
  assert.equal(sandcastle.role, "ticket");
  assert.equal(sandcastle.environment.GITHUB_TOKEN, "github-secret");

  const commandEnvironments = events
    .filter(([name]) => name === "command")
    .map(([, , environment]) => environment);
  assert.equal(
    commandEnvironments.every(
      (environment) =>
        environment.GITHUB_TOKEN === undefined &&
        environment.ANTHROPIC_AUTH_TOKEN === undefined &&
        environment.ANTHROPIC_BASE_URL === undefined,
    ),
    true,
  );

  const marker = events.find(([name]) => name === "marker")[2];
  assert.deepEqual(marker, {
    afterHead: completionCommit,
    beforeHead: baseHead,
    integrationBranch: "sandcastle/integration",
    issue: 58,
    runId: "9001",
    schemaVersion: 1,
    sessionId: "fresh-session-58",
    type: "sandcastle-ticket-publication",
  });
  assert.deepEqual(events.find(([name]) => name === "annotate")[1], {
    beforeHead: baseHead,
    issue: 58,
    runId: "9001",
    sessionId: "fresh-session-58",
  });
});

test("invalid completion proof or project-command failure never reaches publication", async () => {
  const cases = [
    {
      name: "zero commits",
      workUnit: successfulWorkUnit([], { commits: [] }),
    },
    {
      name: "multiple commits",
      workUnit: successfulWorkUnit([], {
        commits: [agentCommit, "3".repeat(40)],
      }),
    },
    {
      boundary: {
        commitParents: async () => ["4".repeat(40)],
      },
      name: "wrong parent",
      workUnit: successfulWorkUnit([]),
    },
    {
      boundary: {
        runCommand: async (argv) => {
          if (argv[1] === "test") throw new Error("project test failed");
        },
      },
      name: "failed project command",
      workUnit: successfulWorkUnit([]),
    },
  ];

  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), "queue-ticket-reject-"));
    const events = [];
    const boundary = successfulBoundary(events, scenario.boundary);
    await assert.rejects(
      executeProcessingRun(options(root), boundary, scenario.workUnit),
      undefined,
      scenario.name,
    );
    assert.equal(
      events.some(([name]) =>
        ["annotate", "push", "marker", "close", "createDraftPr"].includes(name),
      ),
      false,
      scenario.name,
    );
  }
});

test("an existing unique open draft Integration PR is reused", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-ticket-existing-pr-"));
  const events = [];
  const existing = {
    draft: true,
    number: 23,
    state: "open",
    url: "https://example.invalid/pr/23",
  };
  const boundary = successfulBoundary(
    events,
    {
      async createDraftPullRequest() {
        throw new Error("must not create a second Integration PR");
      },
      async listIntegrationPullRequests(input) {
        events.push(["listPr", input]);
        return [existing];
      },
    },
    baseHead,
  );

  const result = await executeProcessingRun(
    options(root),
    boundary,
    successfulWorkUnit(events),
  );

  assert.deepEqual(result.pullRequest, existing);
  assert.equal(events.some(([name]) => name === "createBranch"), false);
  assert.equal(events.some(([name]) => name === "createDraftPr"), false);
});

test("a draft PR failure leaves a pushed commit for reconciliation without closing the Ticket", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-ticket-pr-failure-"));
  const events = [];
  const boundary = successfulBoundary(events, {
    async createDraftPullRequest(input) {
      events.push(["createDraftPr", input]);
      throw new Error("pull request unavailable");
    },
  });

  await assert.rejects(
    executeProcessingRun(options(root), boundary, successfulWorkUnit(events)),
    /pull request unavailable/u,
  );

  assert.equal(events.some(([name]) => name === "push"), true);
  assert.equal(events.some(([name]) => name === "marker"), false);
  assert.equal(events.some(([name]) => name === "close"), false);
});
