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
  writeFileSync(
    batchPath,
    `${JSON.stringify({
      branch: fixture.branch,
      id: fixture.batchId,
      initialRunId: "9001",
      originalBaseSha: fixture.base,
      parent: 1,
      schemaVersion: 1,
      state: "processing",
      verifiedTickets: [2],
    })}\n`,
  );
  writeFileSync(
    resultPath,
    `${JSON.stringify({
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
    })}\n`,
  );
  return { batchPath, resultPath, sessionId };
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

async function startGitHubServer(fixture, options = {}) {
  const requests = [];
  let pullRequest = options.existingPullRequest ?? null;
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
      response.end(JSON.stringify({ number: 2, state: "open", title: "Ship a widget" }));
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
      response.statusCode = 201;
      response.end('{"id":9901}');
      return;
    }
    if (request.method === "PATCH" && request.url === "/repos/acme/widget/issues/2") {
      response.end(JSON.stringify({ number: 2, state: body.state }));
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
    pullRequest: () => pullRequest,
    requests,
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
