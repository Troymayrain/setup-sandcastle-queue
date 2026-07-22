import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

const expectedPermissions = {
  "accept-no-change": {
    actions: "read",
    contents: "read",
    issues: "write",
    pullRequests: "none",
  },
  abort: {
    actions: "read",
    contents: "write",
    issues: "write",
    pullRequests: "write",
  },
  "complete-no-change": {
    actions: "read",
    contents: "write",
    issues: "write",
    pullRequests: "none",
  },
  "finalize-batch": {
    actions: "none",
    contents: "write",
    issues: "none",
    pullRequests: "read",
  },
  "final-fix": {
    actions: "write",
    contents: "write",
    issues: "write",
    pullRequests: "write",
  },
  process: {
    actions: "write",
    contents: "write",
    issues: "write",
    pullRequests: "write",
  },
  "remote-doctor": {
    actions: "write",
    contents: "read",
    issues: "none",
    pullRequests: "none",
  },
  "review-only": {
    actions: "write",
    contents: "write",
    issues: "write",
    pullRequests: "write",
  },
};

function config() {
  return {
    audit: { retentionDays: 30 },
    commands: { tests: [{ argv: ["npm", "test"] }], verification: [] },
    execution: {
      jobTimeoutMinutes: 350,
      maxTicketsPerRun: 3,
      minimumRemainingMinutes: 140,
      processingBudgetMinutes: 300,
      ticketTimeoutMinutes: 120,
    },
    provider: {
      kind: "anthropic-compatible",
      models: { ticket: "ticket-model" },
    },
    queue: { ownershipLabel: "sandcastle", readyLabel: "ready-for-agent" },
    runtime: { adapter: "node-npm", version: "22.22.2" },
    schemaVersion: 1,
  };
}

function installedWorkflow() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-workflow-contract-"));
  const configPath = join(repository, "config.json");
  writeFileSync(configPath, `${JSON.stringify(config())}\n`);
  spawnSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  spawnSync("git", ["-C", repository, "add", "README.md"]);
  spawnSync(
    "git",
    [
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
    ],
  );
  const planned = spawnSync(
    process.execPath,
    [cliPath.pathname, "plan", "--config", configPath],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout).result;
  const planPath = join(repository, "plan.json");
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const installed = spawnSync(
    process.execPath,
    [cliPath.pathname, "install", "--plan", planPath, "--confirm", plan.planHash],
    { cwd: repository, encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
  return readFileSync(
    join(repository, ".github", "workflows", "sandcastle.yml"),
    "utf8",
  );
}

function jobBlock(workflow, job) {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  assert.notEqual(start, -1, `missing ${job} job`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/u);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function jobPermissions(block) {
  const match = block.match(/\n    permissions:\n((?:      [a-z-]+: (?:none|read|write)\n)+)/u);
  assert.ok(match, "job must declare an explicit permission block");
  return Object.fromEntries(
    match[1]
      .trim()
      .split("\n")
      .map((line) => {
        const [name, level] = line.trim().split(": ");
        return [name === "pull-requests" ? "pullRequests" : name, level];
      }),
  );
}

test("workflow capability guard allows only host operations and never retries with broader authority", async () => {
  const {
    WORKFLOW_OPERATION_CONTRACTS,
    executeWorkflowCapability,
  } = await import("../dist/index.js");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(WORKFLOW_OPERATION_CONTRACTS).map(([operation, contract]) => [
        operation,
        contract.permissions,
      ]),
    ),
    expectedPermissions,
  );

  const calls = [];
  const value = await executeWorkflowCapability(
    { boundary: "host", capability: "push", operation: "process" },
    async () => {
      calls.push("process:push");
      return "published";
    },
  );
  assert.equal(value, "published");
  assert.deepEqual(calls, ["process:push"]);

  for (const request of [
    { boundary: "host", capability: "push", operation: "review-only" },
    {
      boundary: "host",
      capability: "dispatch-continuation",
      operation: "abort",
    },
    {
      boundary: "host",
      capability: "read-issue",
      operation: "remote-doctor",
    },
    {
      boundary: "host",
      capability: "release-batch",
      operation: "review-only",
    },
    {
      boundary: "host",
      capability: "advance-batch",
      operation: "abort",
    },
    { boundary: "sandbox", capability: "push", operation: "process" },
    {
      boundary: "sandbox",
      capability: "update-pull-request",
      operation: "final-fix",
    },
  ]) {
    await assert.rejects(
      executeWorkflowCapability(request, async () => {
        calls.push("unauthorized");
      }),
      (error) =>
        error.diagnostics?.[0]?.code ===
        (request.boundary === "sandbox"
          ? "SANDBOX_GITHUB_CAPABILITY_FORBIDDEN"
          : "WORKFLOW_CAPABILITY_FORBIDDEN"),
    );
  }
  assert.deepEqual(calls, ["process:push"]);
});

test("installed workflow is manual-only and grants each host job only its contract", async () => {
  const {
    isWorkflowSecurityContractSatisfied,
    readWorkflowJobPermissions,
  } = await import("../dist/index.js");
  const workflow = installedWorkflow();
  const triggerBlock = workflow.slice(
    workflow.indexOf("\non:\n"),
    workflow.indexOf("\nrun-name:"),
  );
  assert.match(triggerBlock, /\n  workflow_dispatch:\n/u);
  assert.doesNotMatch(
    triggerBlock,
    /\n  (?:issues|issue_comment|pull_request|push|repository_dispatch|schedule|workflow_run):/u,
  );
  assert.match(workflow, /\npermissions: \{\}\n\njobs:\n/u);
  for (const operation of [
    "accept-no-change",
    "process",
    "review-only",
    "final-fix",
    "abort",
    "complete-no-change",
    "finalize-batch",
    "remote-doctor",
  ]) {
    const block = jobBlock(workflow, operation);
    assert.deepEqual(jobPermissions(block), expectedPermissions[operation]);
    assert.deepEqual(
      readWorkflowJobPermissions(workflow, operation),
      expectedPermissions[operation],
    );
    assert.match(block, /persist-credentials: false/u);
    assert.match(block, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
    assert.doesNotMatch(block, /env:\n(?:      .+\n)*      ANTHROPIC_AUTH_TOKEN:/u);
  }
  assert.match(
    workflow,
    /options:\n(?:          - (?:start|continue|resume|review-only|final-fix|abort|accept-no-change|complete-no-change|finalize-batch|remote-doctor)\n){10}/u,
  );
  const processJob = jobBlock(workflow, "process");
  assert.match(processJob, /SANDCASTLE_CONTROL_PLANE_IMAGE:/u);
  assert.match(processJob, /--mode "\$\{\{ inputs\.operation \}\}"/u);
  assert.match(processJob, /ref: sandcastle\/\$\{\{/u);
  const remoteDoctor = jobBlock(workflow, "remote-doctor");
  assert.match(remoteDoctor, /SANDCASTLE_CONTROL_PLANE_IMAGE:/u);
  assert.equal(isWorkflowSecurityContractSatisfied(workflow), true);
  assert.equal(
    isWorkflowSecurityContractSatisfied(
      workflow.replace(
        "on:\n  workflow_dispatch:\n",
        "on:\n  push:\n  workflow_dispatch:\n",
      ),
    ),
    false,
  );
  const reviewOnly = jobBlock(workflow, "review-only");
  assert.match(reviewOnly, /fetch-depth: 0/u);
  assert.match(reviewOnly, /ref: sandcastle\/\$\{\{ inputs\.batch_id \}\}/u);
  assert.match(reviewOnly, /SANDCASTLE_CONTROL_PLANE_IMAGE:/u);
  const finalFix = jobBlock(workflow, "final-fix");
  assert.match(finalFix, /fetch-depth: 0/u);
  assert.match(finalFix, /ref: sandcastle\/\$\{\{ inputs\.batch_id \}\}/u);
  assert.match(finalFix, /SANDCASTLE_CONTROL_PLANE_IMAGE:/u);
  const abort = jobBlock(workflow, "abort");
  assert.match(abort, /--config \.sandcastle\/config\.json/u);
  assert.match(abort, /SANDCASTLE_CONTROL_PLANE_IMAGE:/u);
  const acceptNoChange = jobBlock(workflow, "accept-no-change");
  assert.match(acceptNoChange, /--ticket "\$\{\{ inputs\.ticket \}\}"/u);
  assert.match(acceptNoChange, /--reason "\$\{\{ inputs\.reason \}\}"/u);
  const completeNoChange = jobBlock(workflow, "complete-no-change");
  assert.match(completeNoChange, /--reason "\$\{\{ inputs\.reason \}\}"/u);
  assert.doesNotMatch(completeNoChange, /--ticket/u);
  const finalizeBatch = jobBlock(workflow, "finalize-batch");
  assert.match(finalizeBatch, /--operation finalize-batch/u);
  assert.match(finalizeBatch, /--expected-head "\$\{\{ inputs\.expected_head \}\}"/u);
  assert.match(finalizeBatch, /--pull-request "\$\{\{ inputs\.pull_request \}\}"/u);
  assert.doesNotMatch(finalizeBatch, /--reason|ANTHROPIC_/u);
  assert.equal(
    isWorkflowSecurityContractSatisfied(
      workflow.replace(
        reviewOnly,
        reviewOnly.replace("      contents: write", "      contents: read"),
      ),
    ),
    false,
  );
  assert.equal(
    isWorkflowSecurityContractSatisfied(
      workflow.replace(
        reviewOnly,
        reviewOnly.replace(
          "      pull-requests: write\n",
          "      pull-requests: write\n      id-token: write\n",
        ),
      ),
    ),
    false,
  );
  assert.equal(
    isWorkflowSecurityContractSatisfied(
      `${workflow}\n  undeclared-host:\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: write\n    steps:\n      - run: git push\n`,
    ),
    false,
  );
});

test("workflow host is a real command and rejects execution outside its Actions job", () => {
  const dispatched = spawnSync(
    process.execPath,
    [cliPath.pathname, "workflow-host", "--operation", "process"],
    { encoding: "utf8" },
  );

  assert.equal(dispatched.status, 2, dispatched.stderr);
  const output = JSON.parse(dispatched.stdout);
  assert.deepEqual(output, {
    category: "configuration",
    code: "CONFIG_INVALID",
    command: "workflow-host",
    diagnostics: [
      {
        code: "WORKFLOW_HOST_CONTEXT_INVALID",
        message: "The workflow host runs only inside its matching manual GitHub Actions job.",
        path: "",
      },
    ],
    ok: false,
    version: "1.0.0",
  });
});
