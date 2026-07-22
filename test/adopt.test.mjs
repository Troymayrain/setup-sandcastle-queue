import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const codeReviewSnapshot = new URL(
  "../vendor/runtime-skills/code-review/",
  import.meta.url,
);

function createLegacyRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-adopt-repository-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, ".nvmrc"), "22.22.2\n");
  writeFileSync(join(repository, "README.md"), "# legacy fixture\n");
  writeFileSync(
    join(repository, "package.json"),
    `${JSON.stringify(
      {
        engines: { node: "22.22.2" },
        name: "legacy-fixture",
        private: true,
        scripts: { test: "node --test", typecheck: "tsc --noEmit" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repository, "package-lock.json"),
    '{"name":"legacy-fixture","lockfileVersion":3,"packages":{}}\n',
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
  const skillDirectory = join(
    repository,
    ".agents",
    "skills",
    "code-review",
  );
  cpSync(codeReviewSnapshot, skillDirectory, { recursive: true });
  const skillPath = join(skillDirectory, "SKILL.md");
  writeFileSync(
    skillPath,
    `${readFileSync(skillPath, "utf8")}\n## Sandcastle legacy extension\n\nReturn the reviewed HEAD and machine-readable findings to the Sandcastle host.\n`,
  );
  const workflowPath = join(
    repository,
    ".github",
    "workflows",
    "sandcastle.yml",
  );
  mkdirSync(join(repository, ".github", "workflows"), { recursive: true });
  writeFileSync(
    workflowPath,
    "name: Legacy Sandcastle\non:\n  workflow_dispatch:\n",
  );
  return repository;
}

function writeConfig() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-adopt-config-"));
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

async function startGitHubServer({
  inProgress = [],
  invalidWorkflowResponse = false,
  pullRequests = [],
  queued = [],
} = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader("content-type", "application/json");
    if (
      request.url ===
      "/repos/acme/widget/actions/workflows/sandcastle.yml/runs?status=queued&per_page=100&page=1"
    ) {
      response.end(
        invalidWorkflowResponse
          ? '{"total_count":1}'
          : JSON.stringify({
              total_count: queued.length,
              workflow_runs: queued,
            }),
      );
      return;
    }
    if (
      request.url ===
      "/repos/acme/widget/actions/workflows/sandcastle.yml/runs?status=in_progress&per_page=100&page=1"
    ) {
      response.end(
        JSON.stringify({
          total_count: inProgress.length,
          workflow_runs: inProgress,
        }),
      );
      return;
    }
    if (request.url === "/repos/acme/widget/pulls?state=open&per_page=100&page=1") {
      response.end(JSON.stringify(pullRequests));
      return;
    }
    if (request.url === "/repos/acme/widget") {
      response.end('{"default_branch":"main","id":42}');
      return;
    }
    if (request.url === "/repos/acme/widget/labels?per_page=100&page=1") {
      response.end('[{"name":"Ready-For-Agent"},{"name":"sandcastle"}]');
      return;
    }
    if (request.url === "/repos/acme/widget/environments/sandcastle") {
      response.end('{"name":"sandcastle"}');
      return;
    }
    if (
      request.url ===
      "/repos/acme/widget/environments/sandcastle/variables?per_page=100&page=1"
    ) {
      response.end(
        '{"total_count":1,"variables":[{"name":"ANTHROPIC_BASE_URL"}]}',
      );
      return;
    }
    if (
      request.url ===
      "/repos/acme/widget/environments/sandcastle/secrets?per_page=100&page=1"
    ) {
      response.end(
        '{"total_count":1,"secrets":[{"name":"ANTHROPIC_AUTH_TOKEN"}]}',
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

function directoryHash(root) {
  const hash = createHash("sha256");
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        visit(path);
      } else {
        files.push(path);
      }
    }
  };
  visit(root);
  for (const path of files.sort((left, right) =>
    relative(root, left).localeCompare(relative(root, right)),
  )) {
    hash.update(relative(root, path).split("\\").join("/"));
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

test("adopt previews a quiescent legacy migration and moves patched skill instructions", async () => {
  const repository = createLegacyRepository();
  const github = await startGitHubServer();
  const before = treeHash(repository);
  const githubToken = "github-token-must-not-leak";
  try {
    const result = await runCli(
      ["adopt", "--config", writeConfig()],
      repository,
      {
        ...process.env,
        GITHUB_API_URL: github.apiUrl,
        GITHUB_TOKEN: githubToken,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(githubToken), false);
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "adopt");
    assert.equal(output.ok, true);
    assert.equal(output.result.mode, "preview");
    assert.deepEqual(output.result.quiescence, {
      activeWorkflowRuns: [],
      integrationPullRequests: [],
      optedOutPullRequests: [],
    });
    assert.deepEqual(
      output.result.migrations.map(({ action, skill }) => ({ action, skill })),
      [{ action: "move-to-wrapper", skill: "code-review" }],
    );
    assert.equal(output.result.plan.installationState, "unmanaged");
    assert.match(output.result.plan.patch, /-## Sandcastle legacy extension/u);
    assert.match(
      output.result.plan.patch,
      /\+## Adopted legacy Sandcastle extensions/u,
    );
    assert.equal(treeHash(repository), before);
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});

test("adopt rejects queued or running legacy workflow runs", async () => {
  const repository = createLegacyRepository();
  const github = await startGitHubServer({ inProgress: [{ id: 9001 }] });
  const before = treeHash(repository);
  try {
    const result = await runCli(
      ["adopt", "--config", writeConfig()],
      repository,
      {
        ...process.env,
        GITHUB_API_URL: github.apiUrl,
        GITHUB_TOKEN: "github-token-must-not-leak",
      },
    );

    assert.equal(result.status, 2, result.stderr);
    assert.equal(
      JSON.parse(result.stdout).diagnostics[0].code,
      "LEGACY_WORKFLOW_ACTIVE",
    );
    assert.equal(treeHash(repository), before);
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});

test("adopt fails closed when GitHub omits workflow run details", async () => {
  const repository = createLegacyRepository();
  const github = await startGitHubServer({ invalidWorkflowResponse: true });
  try {
    const result = await runCli(
      ["adopt", "--config", writeConfig()],
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

test("adopt requires explicit opt-out for an unfinished legacy integration PR", async () => {
  const repository = createLegacyRepository();
  const github = await startGitHubServer({
    pullRequests: [
      {
        body: "<!-- sandcastle:legacy -->",
        head: { ref: "sandcastle/legacy-batch" },
        number: 17,
        title: "Legacy Sandcastle integration",
      },
    ],
  });
  try {
    const blocked = await runCli(
      ["adopt", "--config", writeConfig()],
      repository,
      {
        ...process.env,
        GITHUB_API_URL: github.apiUrl,
        GITHUB_TOKEN: "github-token-must-not-leak",
      },
    );
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.equal(
      JSON.parse(blocked.stdout).diagnostics[0].code,
      "LEGACY_INTEGRATION_PR_OPEN",
    );

    const optedOut = await runCli(
      [
        "adopt",
        "--config",
        writeConfig(),
        "--confirm-pr-opt-out",
        "17",
      ],
      repository,
      {
        ...process.env,
        GITHUB_API_URL: github.apiUrl,
        GITHUB_TOKEN: "github-token-must-not-leak",
      },
    );
    assert.equal(optedOut.status, 0, optedOut.stderr);
    assert.deepEqual(
      JSON.parse(optedOut.stdout).result.quiescence.optedOutPullRequests,
      [17],
    );
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});

test("adopt atomically applies the confirmed migration and passes doctor", async () => {
  const repository = createLegacyRepository();
  const github = await startGitHubServer();
  const environment = {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: "provider-token-must-not-leak",
    ANTHROPIC_BASE_URL: "https://private-provider.example.invalid",
    GITHUB_API_URL: github.apiUrl,
    GITHUB_TOKEN: "github-token-must-not-leak",
  };
  try {
    const previewed = await runCli(
      ["adopt", "--config", writeConfig()],
      repository,
      environment,
    );
    assert.equal(previewed.status, 0, previewed.stderr);
    const plan = JSON.parse(previewed.stdout).result.plan;
    const planPath = join(
      mkdtempSync(join(tmpdir(), "sandcastle-adopt-plan-")),
      "plan.json",
    );
    writeFileSync(planPath, `${JSON.stringify(plan)}\n`);

    const adopted = await runCli(
      ["adopt", "--plan", planPath, "--confirm", plan.planHash],
      repository,
      environment,
    );

    assert.equal(adopted.status, 0, adopted.stderr);
    assert.equal(JSON.parse(adopted.stdout).result.changed, true);
    assert.equal(
      directoryHash(join(repository, ".agents", "skills", "code-review")),
      "31d149a480eaa68c11e32f5ee77f0fd0b98a906834d531d881d502352edd0b8e",
    );
    assert.doesNotMatch(
      readFileSync(
        join(repository, ".agents", "skills", "code-review", "SKILL.md"),
        "utf8",
      ),
      /Sandcastle legacy extension/u,
    );
    const wrapper = readFileSync(
      join(repository, ".agents", "skills", "sandcastle-runtime", "SKILL.md"),
      "utf8",
    );
    assert.match(wrapper, /## Adopted legacy Sandcastle extensions/u);
    assert.match(wrapper, /Return the reviewed HEAD and machine-readable findings/u);

    const checked = await runCli(["doctor"], repository, environment);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).ok, true);
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});

test("ordinary install fails closed on legacy assets and directs the user to adopt", async () => {
  const repository = createLegacyRepository();
  const before = treeHash(repository);
  const planned = await runCli(
    ["plan", "--config", writeConfig()],
    repository,
    process.env,
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout).result;
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-legacy-install-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);

  const installed = await runCli(
    ["install", "--plan", planPath, "--confirm", plan.planHash],
    repository,
    process.env,
  );

  assert.equal(installed.status, 2, installed.stderr);
  assert.deepEqual(JSON.parse(installed.stdout).diagnostics, [
    {
      code: "UNMANAGED_INSTALLATION",
      message: "Unmanaged Sandcastle assets require the adopt lifecycle.",
      path: "",
    },
  ]);
  assert.equal(treeHash(repository), before);
});

test("adopt rolls back every migrated asset after a mid-apply failure", async () => {
  const repository = createLegacyRepository();
  const github = await startGitHubServer();
  const environment = {
    ...process.env,
    GITHUB_API_URL: github.apiUrl,
    GITHUB_TOKEN: "github-token-must-not-leak",
  };
  const previewed = await runCli(
    ["adopt", "--config", writeConfig()],
    repository,
    environment,
  );
  assert.equal(previewed.status, 0, previewed.stderr);
  const plan = JSON.parse(previewed.stdout).result.plan;
  const planPath = join(
    mkdtempSync(join(tmpdir(), "sandcastle-adopt-failure-plan-")),
    "plan.json",
  );
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const protectedDirectory = join(repository, ".sandcastle");
  mkdirSync(protectedDirectory);
  writeFileSync(join(protectedDirectory, "keep.txt"), "legacy user data\n");
  const before = treeHash(repository);
  chmodSync(protectedDirectory, 0o500);

  let adopted;
  try {
    adopted = await runCli(
      ["adopt", "--plan", planPath, "--confirm", plan.planHash],
      repository,
      environment,
    );
  } finally {
    chmodSync(protectedDirectory, 0o700);
    await github.close();
  }

  assert.equal(adopted.status, 3, adopted.stderr);
  assert.equal(JSON.parse(adopted.stdout).diagnostics[0].code, "APPLY_FAILED");
  assert.equal(treeHash(repository), before);
  assert.equal(
    existsSync(join(repository, ".sandcastle", "installation.json")),
    false,
  );
  assert.equal(
    existsSync(
      join(repository, ".agents", "skills", "sandcastle-runtime", "SKILL.md"),
    ),
    false,
  );
  assert.match(
    readFileSync(
      join(repository, ".agents", "skills", "code-review", "SKILL.md"),
      "utf8",
    ),
    /Sandcastle legacy extension/u,
  );
  assert.equal(
    readFileSync(join(protectedDirectory, "keep.txt"), "utf8"),
    "legacy user data\n",
  );
});

test("adopt replaces an explicitly reviewed legacy config while preserving project docs", async () => {
  const repository = createLegacyRepository();
  mkdirSync(join(repository, ".sandcastle"), { recursive: true });
  const legacyConfigPath = join(repository, ".sandcastle", "config.json");
  writeFileSync(
    legacyConfigPath,
    '{"legacy":"configuration reviewed in the adoption diff"}\n',
  );
  const projectDocPath = join(repository, "docs", "agents", "sandcastle-queue.md");
  mkdirSync(join(repository, "docs", "agents"), { recursive: true });
  writeFileSync(projectDocPath, "# Keep this project-owned legacy guidance\n");
  const github = await startGitHubServer();
  const environment = {
    ...process.env,
    GITHUB_API_URL: github.apiUrl,
    GITHUB_TOKEN: "github-token-must-not-leak",
  };
  try {
    const previewed = await runCli(
      ["adopt", "--config", writeConfig()],
      repository,
      environment,
    );
    assert.equal(previewed.status, 0, previewed.stderr);
    const plan = JSON.parse(previewed.stdout).result.plan;
    assert.match(plan.patch, /-\{"legacy":"configuration reviewed/u);
    assert.match(plan.patch, /\+\s+"schemaVersion": 1/u);
    const planPath = join(
      mkdtempSync(join(tmpdir(), "sandcastle-adopt-config-plan-")),
      "plan.json",
    );
    writeFileSync(planPath, `${JSON.stringify(plan)}\n`);

    const adopted = await runCli(
      ["adopt", "--plan", planPath, "--confirm", plan.planHash],
      repository,
      environment,
    );

    assert.equal(adopted.status, 0, adopted.stderr);
    assert.equal(JSON.parse(readFileSync(legacyConfigPath, "utf8")).schemaVersion, 1);
    assert.equal(
      readFileSync(projectDocPath, "utf8"),
      "# Keep this project-owned legacy guidance\n",
    );
  } finally {
    await github.close();
  }
});
