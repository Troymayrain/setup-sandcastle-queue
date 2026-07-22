import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-github-repository-"));
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
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-github-config-"));
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

async function startGitHubServer() {
  const requests = [];
  const publicKey = Buffer.from(
    Array.from({ length: 32 }, (_, index) => index + 1),
  ).toString("base64");
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ body, method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/repos/acme/widget") {
      response.end('{"default_branch":"main","id":42}');
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/labels?per_page=100&page=1"
    ) {
      response.end('[{"name":"Ready-For-Agent"}]');
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/environments/sandcastle"
    ) {
      response.statusCode = 404;
      response.end('{"message":"Not Found"}');
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/branches/main/protection"
    ) {
      response.statusCode = 404;
      response.end('{"message":"Not Found"}');
      return;
    }
    if (request.method === "GET" && request.url === "/repos/acme/widget/rulesets") {
      response.end("[]");
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/actions/permissions"
    ) {
      response.end('{"allowed_actions":"all","enabled":true}');
      return;
    }
    if (request.method === "POST" && request.url === "/repos/acme/widget/labels") {
      response.statusCode = 201;
      response.end('{"name":"sandcastle"}');
      return;
    }
    if (
      request.method === "PUT" &&
      request.url === "/repos/acme/widget/environments/sandcastle"
    ) {
      response.statusCode = 200;
      response.end('{"name":"sandcastle"}');
      return;
    }
    if (
      request.method === "GET" &&
      request.url ===
        "/repos/acme/widget/environments/sandcastle/variables?per_page=100&page=1"
    ) {
      response.end('{"total_count":0,"variables":[]}');
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/repos/acme/widget/environments/sandcastle/variables"
    ) {
      response.statusCode = 201;
      response.end('{"name":"ANTHROPIC_BASE_URL"}');
      return;
    }
    if (
      request.method === "GET" &&
      request.url === "/repos/acme/widget/environments/sandcastle/secrets/public-key"
    ) {
      response.end(JSON.stringify({ key: publicKey, key_id: "key-1" }));
      return;
    }
    if (
      request.method === "PUT" &&
      request.url ===
        "/repos/acme/widget/environments/sandcastle/secrets/ANTHROPIC_AUTH_TOKEN"
    ) {
      response.statusCode = 201;
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end('{"message":"Not Found"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    requests,
  };
}

function repositoryText(repository) {
  const contents = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        contents.push(readFileSync(path, "utf8"));
      }
    }
  };
  visit(repository);
  return contents.join("\n");
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

test("configure-github previews canonical resources and diagnoses privileged settings read-only", async () => {
  const repository = createRepository();
  const configPath = writeConfig();
  const github = await startGitHubServer();
  const secrets = {
    github: "github-token-must-not-leak",
    provider: "provider-token-must-not-leak",
    url: "https://private-provider.example.invalid",
  };
  try {
    const result = await runCli(
      ["configure-github", "--config", configPath],
      repository,
      {
        ...process.env,
        ANTHROPIC_AUTH_TOKEN: secrets.provider,
        ANTHROPIC_BASE_URL: secrets.url,
        GITHUB_API_URL: github.apiUrl,
        GITHUB_TOKEN: secrets.github,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    for (const secret of Object.values(secrets)) {
      assert.equal(result.stdout.includes(secret), false);
    }
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "configure-github");
    assert.equal(output.ok, true);
    assert.equal(output.result.mode, "preview");
    assert.equal(output.result.repository, "acme/widget");
    assert.deepEqual(output.result.confirmationsRequired, [
      "labels",
      "environment",
      "provider-variable",
      "provider-secret",
    ]);
    assert.deepEqual(output.result.resources, [
      {
        action: "reuse",
        category: "labels",
        kind: "label",
        name: "Ready-For-Agent",
      },
      {
        action: "create",
        category: "labels",
        kind: "label",
        name: "sandcastle",
      },
      {
        action: "create",
        category: "environment",
        kind: "environment",
        name: "sandcastle",
      },
      {
        action: "upsert",
        available: true,
        category: "provider-variable",
        kind: "environment-variable",
        name: "ANTHROPIC_BASE_URL",
        value: "[redacted]",
      },
      {
        action: "upsert",
        available: true,
        category: "provider-secret",
        kind: "environment-secret",
        name: "ANTHROPIC_AUTH_TOKEN",
        value: "[redacted]",
      },
    ]);
    assert.deepEqual(
      output.result.diagnostics.map(({ kind, status }) => ({ kind, status })),
      [
        { kind: "branch-protection", status: "missing" },
        { kind: "repository-rulesets", status: "missing" },
        { kind: "actions-permissions", status: "review-required" },
        { kind: "organization-policy", status: "manual" },
        { kind: "pat-or-github-app", status: "manual" },
        { kind: "environment-reviewers", status: "manual" },
      ],
    );
    assert.equal(
      github.requests.every(({ method }) => method === "GET"),
      true,
    );
  } finally {
    await github.close();
  }
});

test("configure-github rejects incomplete resource confirmation before remote writes", async () => {
  const repository = createRepository();
  const configPath = writeConfig();
  const github = await startGitHubServer();
  try {
    const result = await runCli(
      [
        "configure-github",
        "--config",
        configPath,
        "--confirm-resources",
        "labels,environment,provider-variable",
      ],
      repository,
      {
        ...process.env,
        ANTHROPIC_AUTH_TOKEN: "provider-token-must-not-leak",
        ANTHROPIC_BASE_URL: "https://private-provider.example.invalid",
        GITHUB_API_URL: github.apiUrl,
        GITHUB_TOKEN: "github-token-must-not-leak",
      },
    );

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.category, "configuration");
    assert.equal(output.diagnostics[0].code, "GITHUB_CONFIRMATION_INCOMPLETE");
    assert.equal(
      github.requests.every(({ method }) => method === "GET"),
      true,
    );
  } finally {
    await github.close();
  }
});

test("configure-github applies only confirmed resources and seals the provider token", async () => {
  const repository = createRepository();
  const configPath = writeConfig();
  const github = await startGitHubServer();
  const secrets = {
    github: "github-token-must-not-leak",
    provider: "provider-token-must-not-leak",
    url: "https://private-provider.example.invalid",
  };
  try {
    const result = await runCli(
      [
        "configure-github",
        "--config",
        configPath,
        "--confirm-resources",
        "labels,environment,provider-variable,provider-secret",
      ],
      repository,
      {
        ...process.env,
        ANTHROPIC_AUTH_TOKEN: secrets.provider,
        ANTHROPIC_BASE_URL: secrets.url,
        GITHUB_API_URL: github.apiUrl,
        GITHUB_TOKEN: secrets.github,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    for (const secret of Object.values(secrets)) {
      assert.equal(result.stdout.includes(secret), false);
      assert.equal(repositoryText(repository).includes(secret), false);
    }
    const output = JSON.parse(result.stdout);
    assert.equal(output.result.mode, "applied");

    const writes = github.requests.filter(({ method }) => method !== "GET");
    assert.deepEqual(
      writes.map(({ method, url }) => ({ method, url })),
      [
        { method: "POST", url: "/repos/acme/widget/labels" },
        { method: "PUT", url: "/repos/acme/widget/environments/sandcastle" },
        {
          method: "POST",
          url: "/repos/acme/widget/environments/sandcastle/variables",
        },
        {
          method: "PUT",
          url: "/repos/acme/widget/environments/sandcastle/secrets/ANTHROPIC_AUTH_TOKEN",
        },
      ],
    );
    assert.equal(JSON.parse(writes[0].body).name, "sandcastle");
    assert.deepEqual(JSON.parse(writes[2].body), {
      name: "ANTHROPIC_BASE_URL",
      value: secrets.url,
    });
    const secretBody = JSON.parse(writes[3].body);
    assert.equal(secretBody.key_id, "key-1");
    assert.equal(secretBody.encrypted_value.includes(secrets.provider), false);
    assert.equal(writes[3].body.includes(secrets.provider), false);
    assert.equal(
      writes.some(({ url }) =>
        ["/protection", "/rulesets", "/actions/permissions"].some((part) =>
          url.includes(part),
        ),
      ),
      false,
    );
  } finally {
    await github.close();
  }
});
