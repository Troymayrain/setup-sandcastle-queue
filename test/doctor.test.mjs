import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-doctor-repository-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, ".nvmrc"), "22.22.2\n");
  writeFileSync(join(repository, "README.md"), "# doctor fixture\n");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        engines: { node: "22.22.2" },
        name: "doctor-fixture",
        private: true,
        scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, "package-lock.json"),
    '{"name":"doctor-fixture","lockfileVersion":3,"packages":{}}\n',
  );
  execFileSync("git", ["-C", repository, "add", "."]);
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
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-doctor-config-"));
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
        commands: {
          tests: [{ argv: ["npm", "test"] }],
          verification: [{ argv: ["npm", "run", "typecheck"] }],
        },
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

function install(repository, configPath) {
  const planned = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", configPath],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout).result;
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-doctor-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const installed = spawnSync(
    process.execPath,
    [
      cliPath.pathname,
      "install",
      "--plan",
      planPath,
      "--confirm",
      plan.planHash,
    ],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
}

async function startGitHubServer({
  labels = ["Ready-For-Agent", "sandcastle"],
  secrets = ["ANTHROPIC_AUTH_TOKEN"],
  variables = ["ANTHROPIC_BASE_URL"],
} = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ body, method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.url === "/repos/acme/widget") {
      response.end('{"default_branch":"main","id":42}');
      return;
    }
    if (request.url === "/repos/acme/widget/labels?per_page=100&page=1") {
      response.end(JSON.stringify(labels.map((name) => ({ name }))));
      return;
    }
    if (request.url === "/repos/acme/widget/environments/sandcastle") {
      response.end('{"name":"sandcastle","protection_rules":[]}');
      return;
    }
    if (
      request.url ===
      "/repos/acme/widget/environments/sandcastle/variables?per_page=100&page=1"
    ) {
      response.end(
        JSON.stringify({
          total_count: variables.length,
          variables: variables.map((name) => ({ name })),
        }),
      );
      return;
    }
    if (
      request.url ===
      "/repos/acme/widget/environments/sandcastle/secrets?per_page=100&page=1"
    ) {
      response.end(
        JSON.stringify({
          secrets: secrets.map((name) => ({ name })),
          total_count: secrets.length,
        }),
      );
      return;
    }
    if (request.url === "/repos/acme/widget/rulesets") {
      response.end('[{"id":1}]');
      return;
    }
    if (request.url === "/repos/acme/widget/actions/permissions") {
      response.end('{"allowed_actions":"selected","enabled":true}');
      return;
    }
    if (request.url === "/repos/acme/widget/branches/main/protection") {
      response.end('{"required_status_checks":{}}');
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

function runDoctor(repository, environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath.pathname, "doctor"], {
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

function treeHash(repository) {
  const hash = createHash("sha256");
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === repository && name === ".git") {
        continue;
      }
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        hash.update(relative(repository, path));
        hash.update(readFileSync(path));
      }
    }
  };
  visit(repository);
  return hash.digest("hex");
}

test("doctor reports a complete installation through read-only local and GitHub checks", async () => {
  const repository = createRepository();
  install(repository, writeConfig());
  const github = await startGitHubServer();
  const secrets = {
    github: "github-token-must-not-leak",
    provider: "provider-token-must-not-leak",
    url: "https://private-provider.example.invalid",
  };
  const before = treeHash(repository);
  try {
    const result = await runDoctor(repository, {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: secrets.provider,
      ANTHROPIC_BASE_URL: secrets.url,
      GITHUB_API_URL: github.apiUrl,
      GITHUB_TOKEN: secrets.github,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    for (const secret of Object.values(secrets)) {
      assert.equal(result.stdout.includes(secret), false);
    }
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "doctor");
    assert.equal(output.ok, true);
    assert.deepEqual(
      output.result.checks.map(({ id, status }) => ({ id, status })),
      [
        { id: "config-schema", status: "pass" },
        { id: "managed-files", status: "pass" },
        { id: "runtime-skills", status: "pass" },
        { id: "runtime", status: "pass" },
        { id: "commands", status: "pass" },
        { id: "workflow", status: "pass" },
        { id: "github-labels", status: "pass" },
        { id: "github-settings", status: "pass" },
      ],
    );
    assert.deepEqual(output.result.diagnostics, []);
    assert.equal(treeHash(repository), before);
    assert.equal(
      github.requests.every(({ method }) => method === "GET"),
      true,
    );
  } finally {
    await github.close();
  }
});

test("doctor fails clearly when a managed file drifts", async () => {
  const repository = createRepository();
  install(repository, writeConfig());
  const workflowPath = join(
    repository,
    ".github",
    "workflows",
    "sandcastle.yml",
  );
  writeFileSync(workflowPath, `${readFileSync(workflowPath, "utf8")}# drift\n`);
  const github = await startGitHubServer();
  const before = treeHash(repository);
  try {
    const result = await runDoctor(repository, {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "provider-token-must-not-leak",
      ANTHROPIC_BASE_URL: "https://private-provider.example.invalid",
      GITHUB_API_URL: github.apiUrl,
      GITHUB_TOKEN: "github-token-must-not-leak",
    });

    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(
      output.result.diagnostics.some(
        ({ check, code, path }) =>
          check === "managed-files" &&
          code === "MANAGED_FILE_DRIFT" &&
          path === ".github/workflows/sandcastle.yml",
      ),
      true,
    );
    assert.equal(treeHash(repository), before);
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});

test("doctor fails clearly when a pinned runtime skill is missing", async () => {
  const repository = createRepository();
  install(repository, writeConfig());
  rmSync(join(repository, ".agents", "skills", "tdd"), {
    force: true,
    recursive: true,
  });
  const github = await startGitHubServer();
  try {
    const result = await runDoctor(repository, {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "provider-token-must-not-leak",
      ANTHROPIC_BASE_URL: "https://private-provider.example.invalid",
      GITHUB_API_URL: github.apiUrl,
      GITHUB_TOKEN: "github-token-must-not-leak",
    });

    assert.equal(result.status, 2, result.stderr);
    const diagnostics = JSON.parse(result.stdout).result.diagnostics;
    assert.equal(
      diagnostics.some(
        ({ check, code, path }) =>
          check === "runtime-skills" &&
          code === "RUNTIME_SKILL_MISSING" &&
          path === ".agents/skills/tdd",
      ),
      true,
    );
  } finally {
    await github.close();
  }
});

test("doctor fails clearly when the detected runtime no longer matches configuration", async () => {
  const repository = createRepository();
  install(repository, writeConfig());
  writeFileSync(join(repository, ".nvmrc"), "20.19.4\n");
  const packagePath = join(repository, "package.json");
  const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
  packageMetadata.engines.node = "20.19.4";
  writeFileSync(packagePath, `${JSON.stringify(packageMetadata, null, 2)}\n`);
  const github = await startGitHubServer();
  try {
    const result = await runDoctor(repository, {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "provider-token-must-not-leak",
      ANTHROPIC_BASE_URL: "https://private-provider.example.invalid",
      GITHUB_API_URL: github.apiUrl,
      GITHUB_TOKEN: "github-token-must-not-leak",
    });

    assert.equal(result.status, 2, result.stderr);
    const diagnostics = JSON.parse(result.stdout).result.diagnostics;
    assert.equal(
      diagnostics.some(
        ({ check, code }) =>
          check === "runtime" && code === "RUNTIME_MISMATCH",
      ),
      true,
    );
  } finally {
    await github.close();
  }
});

test("doctor rejects unsafe commands and unknown schemas through its config boundary", async () => {
  for (const scenario of [
    {
      code: "UNSAFE_COMMAND",
      mutate(config) {
        config.commands.tests = [{ argv: ["bash", "-lc", "npm test"] }];
      },
    },
    {
      code: "UNSUPPORTED_SCHEMA",
      mutate(config) {
        config.schemaVersion = 2;
      },
    },
  ]) {
    const repository = createRepository();
    install(repository, writeConfig());
    const configPath = join(repository, ".sandcastle", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    scenario.mutate(config);
    writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const result = await runDoctor(repository, {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "provider-token-must-not-leak",
      ANTHROPIC_BASE_URL: "https://private-provider.example.invalid",
      GITHUB_TOKEN: "github-token-must-not-leak",
    });

    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].code, scenario.code);
  }
});

test("doctor fails clearly when a configured queue label is absent", async () => {
  const repository = createRepository();
  install(repository, writeConfig());
  const github = await startGitHubServer({ labels: ["Ready-For-Agent"] });
  try {
    const result = await runDoctor(repository, {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "provider-token-must-not-leak",
      ANTHROPIC_BASE_URL: "https://private-provider.example.invalid",
      GITHUB_API_URL: github.apiUrl,
      GITHUB_TOKEN: "github-token-must-not-leak",
    });

    assert.equal(result.status, 2, result.stderr);
    const diagnostics = JSON.parse(result.stdout).result.diagnostics;
    assert.equal(
      diagnostics.some(
        ({ check, code, path }) =>
          check === "github-labels" &&
          code === "GITHUB_LABEL_MISSING" &&
          path === "sandcastle",
      ),
      true,
    );
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});

test("doctor fails when the provider Environment secret is absent remotely", async () => {
  const repository = createRepository();
  install(repository, writeConfig());
  const github = await startGitHubServer({ secrets: [] });
  try {
    const result = await runDoctor(repository, {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: "provider-token-must-not-leak",
      ANTHROPIC_BASE_URL: "https://private-provider.example.invalid",
      GITHUB_API_URL: github.apiUrl,
      GITHUB_TOKEN: "github-token-must-not-leak",
    });

    assert.equal(result.status, 2, result.stderr);
    const diagnostics = JSON.parse(result.stdout).result.diagnostics;
    assert.equal(
      diagnostics.some(
        ({ check, code }) =>
          check === "github-settings" &&
          code === "GITHUB_PROVIDER_SECRET_MISSING",
      ),
      true,
    );
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});
