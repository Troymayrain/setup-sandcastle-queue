import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  executeWorkUnit,
  parseRawAgentStream,
} from "../dist/work-unit.js";

test("each role uses a fresh Sandcastle run and deletes its 0600 raw stream", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "queue-tool-work-unit-"));
  const promptFile = join(cwd, "prompt.md");
  writeFileSync(promptFile, "work\n");
  const observed = [];
  const results = [];
  const rawPaths = [];
  let finalFixPrompt = "";
  let nextSession = 1;
  const boundary = {
    claudeCode(model, options) {
      return { model, options };
    },
    docker(options) {
      return { options };
    },
    async run(options) {
      observed.push(options);
      rawPaths.push(options.logging.path);
      assert.equal(statSync(options.logging.path).mode & 0o777, 0o600);
      writeFileSync(options.logging.path, "temporary raw stream\n");
      const review =
        options.name === "queue-final-review" ||
        options.name === "queue-final-rereview";
      if (options.name === "queue-final-fix") {
        finalFixPrompt = readFileSync(options.promptFile, "utf8");
      }
      return {
        branch: "sandcastle/integration",
        commits: review ? [] : [{ sha: `${nextSession}`.padStart(40, "a") }],
        iterations: [{ sessionId: `session-${nextSession++}` }],
        preservedWorktreePath: review ? undefined : "/worktree/preserved",
        stdout: review
          ? '{"schemaVersion":1,"verdict":"pass","findings":[]}'
          : "complete",
      };
    },
  };
  const environment = {
    ANTHROPIC_AUTH_TOKEN: "provider-secret",
    ANTHROPIC_BASE_URL: "https://provider.example",
    GITHUB_TOKEN: "must-not-reach-agent",
  };

  for (const role of ["ticket", "final-review", "final-fix", "final-rereview"]) {
    results.push(await executeWorkUnit(
      {
        cwd,
        environment,
        ...(role === "final-fix"
          ? {
              findings: [{
                line: 41,
                path: "docs/runbook.md",
                problem: "The recovery step skips the required backup check.",
                requiredFix: "Add the backup check before the restore command.",
              }],
            }
          : {}),
        model: `${role}-model`,
        promptFile,
        role,
      },
      boundary,
    ));
  }

  assert.equal(observed.length, 4);
  assert.equal(
    new Set(observed.map(({ agent }) => agent)).size,
    4,
  );
  for (const options of observed) {
    assert.deepEqual(options.branchStrategy, { type: "merge-to-head" });
    assert.equal(options.maxIterations, 1);
    assert.equal("resumeSession" in options, false);
    assert.deepEqual(options.agent.options.env, {
      ANTHROPIC_AUTH_TOKEN: "provider-secret",
      ANTHROPIC_BASE_URL: "https://provider.example",
    });
    assert.equal(options.agent.options.env.GITHUB_TOKEN, undefined);
    assert.deepEqual(options.sandbox.options.env, {});
    assert.equal("containerUid" in options.sandbox.options, false);
    assert.equal("containerGid" in options.sandbox.options, false);
  }
  assert.equal(observed[1].agent.options.permissionMode, "plan");
  assert.equal(observed[3].agent.options.permissionMode, "plan");
  assert.equal(results[0].preservedWorktreePath, "/worktree/preserved");
  assert.equal("preservedWorktreePath" in results[1], false);
  assert.equal(rawPaths.every((path) => !existsSync(path)), true);
  assert.match(finalFixPrompt, /docs\/runbook\.md/u);
  assert.match(finalFixPrompt, /required backup check/u);
  assert.deepEqual(parseRawAgentStream('{"type":"result"}\ntext\n'), {
    jsonLines: 1,
    lineCount: 2,
    textLines: 1,
  });
});

test("raw stream is deleted when Sandcastle fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "queue-tool-failure-"));
  const promptFile = join(cwd, "prompt.md");
  writeFileSync(promptFile, "work\n");
  let rawPath;
  const boundary = {
    claudeCode: () => ({}),
    docker: () => ({}),
    async run(options) {
      rawPath = options.logging.path;
      writeFileSync(rawPath, '{"type":"error"}\n');
      throw new Error("agent failed");
    },
  };

  await assert.rejects(
    executeWorkUnit(
      {
        cwd,
        environment: {
          ANTHROPIC_AUTH_TOKEN: "secret",
          ANTHROPIC_BASE_URL: "https://provider.example",
        },
        model: "ticket-model",
        promptFile,
        role: "ticket",
      },
      boundary,
    ),
    /agent failed/u,
  );
  assert.equal(existsSync(rawPath), false);
});

test("read-only review accepts only a bounded structured verdict", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "queue-tool-invalid-review-"));
  const promptFile = join(cwd, "prompt.md");
  writeFileSync(promptFile, "review\n");
  let stdout = JSON.stringify({
    findings: [{
      line: 41,
      path: "docs/runbook.md",
      problem: "The recovery step skips the required backup check.",
      requiredFix: "Add the backup check before the restore command.",
    }],
    schemaVersion: 1,
    verdict: "needs-fix",
  });
  const reviewSecret = "provider-secret-value";
  const baseUrl = "https://provider.example";
  const lowercaseApiKey = "lowercase-api-key-value";
  const boundary = {
    claudeCode: () => ({}),
    docker: () => ({}),
    async run(options) {
      writeFileSync(options.logging.path, "temporary raw stream\n");
      return {
        branch: "temporary",
        commits: [],
        iterations: [{ sessionId: "review-session" }],
        stdout,
      };
    },
  };

  const accepted = await executeWorkUnit(
    {
      cwd,
      environment: {
        ANTHROPIC_AUTH_TOKEN: reviewSecret,
        ANTHROPIC_BASE_URL: baseUrl,
        lowercase_api_key: lowercaseApiKey,
      },
      model: "review-model",
      promptFile,
      role: "final-review",
    },
    boundary,
  );
  assert.equal(accepted.verdict, "needs-fix");
  assert.deepEqual(accepted.findings, [{
    line: 41,
    path: "docs/runbook.md",
    problem: "The recovery step skips the required backup check.",
    requiredFix: "Add the backup check before the restore command.",
  }]);

  for (const invalid of [
    "PASS with explanation",
    '{"schemaVersion":1,"verdict":"needs-fix","findings":[]}',
    '{"schemaVersion":1,"verdict":"pass","findings":[{"path":"docs/runbook.md","line":1,"problem":"wrong","requiredFix":"fix it"}]}',
    '{"schemaVersion":1,"verdict":"needs-fix","findings":[{"path":"../secret","line":1,"problem":"wrong","requiredFix":"fix it"}]}',
    '{"schemaVersion":1,"verdict":"needs-fix","findings":[{"path":1,"line":1,"problem":2,"requiredFix":3}]}',
    '{"schemaVersion":1,"verdict":"needs-fix","findings":[{"path":"docs/runbook.md","line":1,"problem":"contains C1\u0085control","requiredFix":"remove it"}]}',
    '{"schemaVersion":1,"verdict":"needs-fix","findings":[{"path":"docs/runbook.md","line":1,"problem":"leaked provider-secret-value","requiredFix":"remove it"}]}',
    `{"schemaVersion":1,"verdict":"needs-fix","findings":[{"path":"docs/runbook.md","line":1,"problem":"leaked ${baseUrl}","requiredFix":"remove it"}]}`,
    `{"schemaVersion":1,"verdict":"needs-fix","findings":[{"path":"docs/runbook.md","line":1,"problem":"leaked ${lowercaseApiKey}","requiredFix":"remove it"}]}`,
  ]) {
    stdout = invalid;
    await assert.rejects(executeWorkUnit(
      {
        cwd,
        environment: {
          ANTHROPIC_AUTH_TOKEN: reviewSecret,
          ANTHROPIC_BASE_URL: baseUrl,
          lowercase_api_key: lowercaseApiKey,
        },
        model: "review-model",
        promptFile,
        role: "final-review",
      },
      boundary,
    ), /Review output/u);
  }
});
