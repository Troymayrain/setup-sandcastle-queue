import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

function git(repository, ...arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
  }).trim();
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-publish-"));
  const remote = join(root, "remote.git");
  const repository = join(root, "work");
  execFileSync("git", ["init", "--bare", "--quiet", remote]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  git(repository, "add", "README.md");
  git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "base",
  );
  const base = git(repository, "rev-parse", "HEAD");
  const batchId = `p1-${base.slice(0, 12)}-r9001`;
  const branch = `sandcastle/${batchId}`;
  git(repository, "remote", "add", "origin", remote);
  git(repository, "checkout", "--quiet", "-b", branch);
  git(
    repository,
    "push",
    "--quiet",
    "origin",
    `${base}:refs/heads/${branch}`,
    `${base}:refs/heads/sandcastle/active`,
  );

  mkdirSync(join(repository, "src"));
  writeFileSync(join(repository, "src", "feature.js"), "export const value = 1;\n");
  git(repository, "add", "src/feature.js");
  git(
    repository,
    "-c",
    "user.name=Agent",
    "-c",
    "user.email=agent@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "agent step one",
  );
  writeFileSync(join(repository, "README.md"), "# fixture\n\nImplemented.\n");
  git(repository, "add", "README.md");
  git(
    repository,
    "-c",
    "user.name=Agent",
    "-c",
    "user.email=agent@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "agent step two",
  );
  writeFileSync(join(repository, "result.txt"), "verified output\n");

  const hookSentinel = join(root, "hook-ran");
  const hook = join(repository, ".git", "hooks", "commit-msg");
  writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(hookSentinel)}\nexit 91\n`);
  execFileSync("chmod", ["+x", hook]);
  return { base, batchId, branch, hookSentinel, remote, repository, root };
}

function writeInputs(fixture) {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-publish-input-"));
  const batchPath = join(directory, "batch.json");
  const resultPath = join(directory, "result.json");
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const batch = {
    branch: fixture.branch,
    id: fixture.batchId,
    initialRunId: "9001",
    originalBaseSha: fixture.base,
    parent: 1,
    schemaVersion: 1,
    state: "processing",
    verifiedTickets: [2],
  };
  const processing = {
    beforeHead: fixture.base,
    findings: [],
    head: git(fixture.repository, "rev-parse", "HEAD"),
    sessionId,
    status: "reviewed",
    ticket: 2,
    toolCalls: {
      codeReview: "review-call",
      implement: "implement-call",
      tdd: "tdd-call",
    },
    verificationHash: "b".repeat(64),
  };
  writeFileSync(
    batchPath,
    `${JSON.stringify(batch)}\n`,
  );
  writeFileSync(
    resultPath,
    `${JSON.stringify(processing)}\n`,
  );
  return { batch, batchPath, processing, resultPath, sessionId };
}

async function requestBody(request) {
  let source = "";
  for await (const chunk of request) source += chunk;
  return source ? JSON.parse(source) : null;
}

function remoteHead(remote, branch) {
  try {
    return execFileSync(
      "git",
      ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

function remoteCommits(remote, branch) {
  const head = remoteHead(remote, branch);
  if (!head) return [];
  return execFileSync(
    "git",
    ["--git-dir", remote, "rev-list", "--max-count=100", head],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((sha) => {
      const [self, ...parents] = execFileSync(
        "git",
        ["--git-dir", remote, "rev-list", "--parents", "-n", "1", sha],
        { encoding: "utf8" },
      )
        .trim()
        .split(" ");
      assert.equal(self, sha);
      return {
        commit: {
          message: execFileSync(
            "git",
            ["--git-dir", remote, "show", "-s", "--format=%B", sha],
            { encoding: "utf8" },
          ).trimEnd(),
        },
        parents: parents.map((parent) => ({ sha: parent })),
        sha,
      };
    });
}

async function startGitHubServer(fixture, options = {}) {
  const requests = [];
  let pullRequest = options.existingPullRequest ?? null;
  let issueState = options.issueState ?? "open";
  const comments = [...(options.comments ?? [])];
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
      request.url === `/repos/acme/widget/git/ref/heads/${encodeURIComponent(fixture.branch)}`
    ) {
      response.end(
        JSON.stringify({
          object: {
            sha: options.mismatchedRemoteHead
              ? "f".repeat(40)
              : remoteHead(fixture.remote, fixture.branch),
          },
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/repos/acme/widget/issues/2") {
      response.end(JSON.stringify({ number: 2, state: issueState, title: "Ship a widget" }));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === `/repos/acme/widget/commits?sha=${encodeURIComponent(fixture.branch)}&per_page=100&page=1`
    ) {
      response.end(JSON.stringify(remoteCommits(fixture.remote, fixture.branch)));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/issues/2/comments?per_page=100&page=1"
    ) {
      response.end(JSON.stringify(comments));
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/pulls?state=open&per_page=100&page=1"
    ) {
      response.end(JSON.stringify(pullRequest ? [pullRequest] : []));
      return;
    }
    if (request.method === "POST" && request.url === "/repos/acme/widget/pulls") {
      pullRequest = {
        ...body,
        html_url: "https://github.com/acme/widget/pull/44",
        number: 44,
      };
      response.statusCode = 201;
      response.end(JSON.stringify(pullRequest));
      return;
    }
    if (request.method === "PATCH" && request.url === "/repos/acme/widget/pulls/44") {
      pullRequest = { ...pullRequest, ...body };
      response.end(JSON.stringify(pullRequest));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/repos/acme/widget/issues/2/comments"
    ) {
      comments.push({ body: body.body, id: 9901 + comments.length });
      response.statusCode = 201;
      response.end(JSON.stringify(comments.at(-1)));
      return;
    }
    if (request.method === "PATCH" && request.url === "/repos/acme/widget/issues/2") {
      issueState = body.state;
      response.end(JSON.stringify({ number: 2, state: issueState }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found", url: request.url }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    comments,
    environment: {
      ...process.env,
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "github-test-token",
    },
    issueState: () => issueState,
    pullRequest: () => pullRequest,
    requests,
    setIssueState(value) {
      issueState = value;
    },
  };
}

function runPublish(fixture, inputs, github) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        cliPath.pathname,
        "publish-ticket",
        "--batch",
        inputs.batchPath,
        "--result",
        inputs.resultPath,
      ],
      {
        cwd: fixture.repository,
        env: {
          ...process.env,
          GITHUB_API_URL: github.apiUrl,
          GITHUB_REPOSITORY: "acme/widget",
          GITHUB_TOKEN: "github-test-token",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr, stdout }));
  });
}

test("publish squashes a verified Ticket, atomically pushes it, then opens a draft PR and closes the Ticket", async () => {
  const fixture = createRepository();
  const inputs = writeInputs(fixture);
  const github = await startGitHubServer(fixture);
  try {
    const executed = await runPublish(fixture, inputs, github);
    assert.equal(executed.status, 0, executed.stderr);
    const result = JSON.parse(executed.stdout).result;
    assert.equal(result.status, "published");
    assert.equal(result.ticket, 2);
    assert.equal(result.pullRequest.number, 44);
    assert.equal(result.pullRequest.draft, true);

    const published = result.commit;
    assert.equal(git(fixture.repository, "rev-parse", "HEAD"), published);
    assert.equal(remoteHead(fixture.remote, fixture.branch), published);
    assert.equal(remoteHead(fixture.remote, "sandcastle/active"), published);
    assert.equal(
      git(fixture.repository, "rev-list", "--count", `${fixture.base}..${published}`),
      "1",
    );
    const commit = git(fixture.repository, "cat-file", "-p", published);
    assert.deepEqual(
      commit
        .split("\n")
        .filter((line) => line.startsWith("parent ")),
      [`parent ${fixture.base}`],
    );
    assert.match(commit, new RegExp(`Sandcastle-Batch: ${fixture.batchId}`, "u"));
    assert.match(commit, /Sandcastle-Ticket: 2/u);
    assert.match(commit, new RegExp(`Sandcastle-Session: ${inputs.sessionId}`, "u"));
    assert.equal(existsSync(fixture.hookSentinel), false);
    assert.deepEqual(
      git(fixture.repository, "diff-tree", "--no-commit-id", "--name-only", "-r", published)
        .split("\n")
        .sort(),
      ["README.md", "result.txt", "src/feature.js"],
    );

    const pullRequest = github.pullRequest();
    assert.equal(pullRequest.base, "main");
    assert.equal(pullRequest.head, fixture.branch);
    assert.equal(pullRequest.draft, true);
    assert.match(pullRequest.body, /Closes #1/u);
    assert.match(pullRequest.body, /<!-- sandcastle-batch-state/u);
    assert.match(pullRequest.body, /"publishedTickets": \[\s*2\s*\]/u);

    const remoteRead = github.requests.findIndex(({ url }) =>
      url.startsWith("/repos/acme/widget/git/ref/heads/"),
    );
    const comment = github.requests.findIndex(
      ({ method, url }) => method === "POST" && url.endsWith("/issues/2/comments"),
    );
    const close = github.requests.findIndex(
      ({ method, url }) => method === "PATCH" && url.endsWith("/issues/2"),
    );
    assert.equal(remoteRead >= 0 && comment > remoteRead && close > comment, true);
    assert.equal(
      github.requests.some(
        ({ method, url }) => method === "PATCH" && url.endsWith("/issues/1"),
      ),
      false,
    );
  } finally {
    await github.close();
  }
});

test("publish updates only the hidden state of an existing draft PR", async () => {
  const fixture = createRepository();
  const inputs = writeInputs(fixture);
  const existingBody = `Human introduction.\n\n<!-- sandcastle-batch-state\n{"batchId":"${fixture.batchId}","parent":1,"publishedTickets":[],"schemaVersion":1}\n-->\n\nHuman review notes.\n`;
  const github = await startGitHubServer(fixture, {
    existingPullRequest: {
      base: { ref: "main" },
      body: existingBody,
      draft: true,
      head: { ref: fixture.branch },
      html_url: "https://github.com/acme/widget/pull/44",
      number: 44,
      title: "Human-adjusted title",
    },
  });
  try {
    const executed = await runPublish(fixture, inputs, github);
    assert.equal(executed.status, 0, executed.stderr);
    const body = github.pullRequest().body;
    assert.match(body, /Human introduction\./u);
    assert.match(body, /Human review notes\./u);
    assert.match(body, /"publishedTickets": \[\s*2\s*\]/u);
    assert.equal(
      github.requests.some(
        ({ method, url }) => method === "POST" && url === "/repos/acme/widget/pulls",
      ),
      false,
    );
  } finally {
    await github.close();
  }
});

test("publish does not comment or close when the GitHub remote HEAD cannot be reconciled", async () => {
  const fixture = createRepository();
  const inputs = writeInputs(fixture);
  const github = await startGitHubServer(fixture, { mismatchedRemoteHead: true });
  try {
    const executed = await runPublish(fixture, inputs, github);
    assert.equal(executed.status, 2, executed.stderr);
    assert.equal(
      JSON.parse(executed.stdout).diagnostics[0].code,
      "PUBLISHED_HEAD_MISMATCH",
    );
    assert.equal(
      github.requests.some(({ url }) => url.includes("/issues/2/comments")),
      false,
    );
    assert.equal(
      github.requests.some(
        ({ method, url }) => method === "PATCH" && url.endsWith("/issues/2"),
      ),
      false,
    );
  } finally {
    await github.close();
  }
});

function forcedCommit(fixture, parent, message) {
  const tree = git(fixture.repository, "rev-parse", `${parent}^{tree}`);
  return execFileSync(
    "git",
    ["-C", fixture.repository, "commit-tree", tree, "-p", parent],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_AUTHOR_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
      },
      input: message,
    },
  ).trim();
}

function forceRemote(fixture, commit) {
  git(
    fixture.repository,
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "--force",
    "--quiet",
    "origin",
    `${commit}:refs/heads/${fixture.branch}`,
    `${commit}:refs/heads/sandcastle/active`,
  );
}

test("reconciliation recovers the before-push, after-push, and after-close crash boundaries idempotently", async () => {
  const { publishTicket, reconcileTicketPublication } = await import(
    "../dist/index.js"
  );

  const beforePush = createRepository();
  const beforeInputs = writeInputs(beforePush);
  const beforeGitHub = await startGitHubServer(beforePush);
  try {
    await assert.rejects(
      publishTicket(
        beforePush.repository,
        { batch: beforeInputs.batch, processing: beforeInputs.processing },
        beforeGitHub.environment,
        {
          checkpoint(point) {
            if (point === "before-push") throw new Error("crash before push");
          },
        },
      ),
      /crash before push/u,
    );
    assert.equal(remoteHead(beforePush.remote, beforePush.branch), beforePush.base);
    const pending = await reconcileTicketPublication(
      beforePush.repository,
      { batch: beforeInputs.batch, processing: beforeInputs.processing },
      beforeGitHub.environment,
    );
    assert.equal(pending.status, "publication-required");
    const published = await publishTicket(
      beforePush.repository,
      { batch: beforeInputs.batch, processing: beforeInputs.processing },
      beforeGitHub.environment,
    );
    assert.equal(published.status, "published");
  } finally {
    await beforeGitHub.close();
  }

  const afterPush = createRepository();
  const afterInputs = writeInputs(afterPush);
  const afterGitHub = await startGitHubServer(afterPush);
  try {
    await assert.rejects(
      publishTicket(
        afterPush.repository,
        { batch: afterInputs.batch, processing: afterInputs.processing },
        afterGitHub.environment,
        {
          checkpoint(point) {
            if (point === "after-push") throw new Error("crash after push");
          },
        },
      ),
      /crash after push/u,
    );
    const recovered = await reconcileTicketPublication(
      afterPush.repository,
      { batch: afterInputs.batch, processing: afterInputs.processing },
      afterGitHub.environment,
    );
    assert.equal(recovered.status, "reconciled");
    assert.equal(recovered.expectedHead, remoteHead(afterPush.remote, afterPush.branch));
    assert.equal(afterGitHub.issueState(), "closed");
    assert.equal(afterGitHub.comments.length, 1);
    const writes = afterGitHub.requests.filter(({ method }) => method !== "GET").length;
    const repeated = await reconcileTicketPublication(
      afterPush.repository,
      {
        batch: afterInputs.batch,
        expectedHead: recovered.expectedHead,
        processing: afterInputs.processing,
      },
      afterGitHub.environment,
    );
    assert.deepEqual(repeated, recovered);
    assert.equal(
      afterGitHub.requests.filter(({ method }) => method !== "GET").length,
      writes,
    );
  } finally {
    await afterGitHub.close();
  }

  const afterClose = createRepository();
  const closeInputs = writeInputs(afterClose);
  const closeGitHub = await startGitHubServer(afterClose);
  try {
    await assert.rejects(
      publishTicket(
        afterClose.repository,
        { batch: closeInputs.batch, processing: closeInputs.processing },
        closeGitHub.environment,
        {
          checkpoint(point) {
            if (point === "after-close") throw new Error("crash after close");
          },
        },
      ),
      /crash after close/u,
    );
    const writes = closeGitHub.requests.filter(({ method }) => method !== "GET").length;
    const recovered = await reconcileTicketPublication(
      afterClose.repository,
      { batch: closeInputs.batch, processing: closeInputs.processing },
      closeGitHub.environment,
    );
    assert.equal(recovered.status, "reconciled");
    assert.equal(closeGitHub.issueState(), "closed");
    assert.equal(closeGitHub.comments.length, 1);
    assert.equal(
      closeGitHub.requests.filter(({ method }) => method !== "GET").length,
      writes,
    );
  } finally {
    await closeGitHub.close();
  }
});

test("reconciliation fails closed for invalid closure, duplicate commits, unexpected HEAD, and mismatched Batch metadata", async () => {
  const { publishTicket, reconcileTicketPublication } = await import(
    "../dist/index.js"
  );

  async function pushedFixture() {
    const fixture = createRepository();
    const inputs = writeInputs(fixture);
    const github = await startGitHubServer(fixture);
    await assert.rejects(
      publishTicket(
        fixture.repository,
        { batch: inputs.batch, processing: inputs.processing },
        github.environment,
        {
          checkpoint(point) {
            if (point === "after-push") throw new Error("injected crash");
          },
        },
      ),
      /injected crash/u,
    );
    return { fixture, github, inputs };
  }

  const closed = await pushedFixture();
  try {
    closed.github.setIssueState("closed");
    await assert.rejects(
      reconcileTicketPublication(
        closed.fixture.repository,
        { batch: closed.inputs.batch, processing: closed.inputs.processing },
        closed.github.environment,
      ),
      (error) => error.diagnostics?.[0]?.code === "TICKET_CLOSED_WITHOUT_RECORD",
    );
  } finally {
    await closed.github.close();
  }

  const duplicate = await pushedFixture();
  try {
    const first = remoteHead(duplicate.fixture.remote, duplicate.fixture.branch);
    const message = git(duplicate.fixture.repository, "show", "-s", "--format=%B", first);
    forceRemote(duplicate.fixture, forcedCommit(duplicate.fixture, first, message));
    await assert.rejects(
      reconcileTicketPublication(
        duplicate.fixture.repository,
        { batch: duplicate.inputs.batch, processing: duplicate.inputs.processing },
        duplicate.github.environment,
      ),
      (error) => error.diagnostics?.[0]?.code === "DUPLICATE_PUBLISHED_COMMITS",
    );
  } finally {
    await duplicate.github.close();
  }

  const unexpected = await pushedFixture();
  try {
    const first = remoteHead(unexpected.fixture.remote, unexpected.fixture.branch);
    forceRemote(
      unexpected.fixture,
      forcedCommit(unexpected.fixture, first, "Unrelated remote commit\n"),
    );
    await assert.rejects(
      reconcileTicketPublication(
        unexpected.fixture.repository,
        { batch: unexpected.inputs.batch, processing: unexpected.inputs.processing },
        unexpected.github.environment,
      ),
      (error) => error.diagnostics?.[0]?.code === "REMOTE_HEAD_UNEXPECTED",
    );
  } finally {
    await unexpected.github.close();
  }

  const mismatch = await pushedFixture();
  try {
    const message = [
      "Ticket #2: Ship a widget",
      "",
      "Sandcastle-Batch: p99-aaaaaaaaaaaa-r9001",
      "Sandcastle-Ticket: 2",
      `Sandcastle-Session: ${mismatch.inputs.sessionId}`,
      "",
    ].join("\n");
    forceRemote(
      mismatch.fixture,
      forcedCommit(mismatch.fixture, mismatch.fixture.base, message),
    );
    await assert.rejects(
      reconcileTicketPublication(
        mismatch.fixture.repository,
        { batch: mismatch.inputs.batch, processing: mismatch.inputs.processing },
        mismatch.github.environment,
      ),
      (error) =>
        error.diagnostics?.[0]?.code === "PUBLISHED_COMMIT_METADATA_MISMATCH",
    );
  } finally {
    await mismatch.github.close();
  }
});
