import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
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
  const rawPaths = [];
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
      return {
        branch: "sandcastle/integration",
        commits: [{ sha: `${nextSession}`.padStart(40, "a") }],
        iterations: [{ sessionId: `session-${nextSession++}` }],
        stdout: "complete",
      };
    },
  };
  const environment = {
    ANTHROPIC_AUTH_TOKEN: "provider-secret",
    ANTHROPIC_BASE_URL: "https://provider.example",
    GITHUB_TOKEN: "must-not-reach-agent",
  };

  for (const role of ["ticket", "final-review", "final-fix", "final-rereview"]) {
    await executeWorkUnit(
      { cwd, environment, model: `${role}-model`, promptFile, role },
      boundary,
    );
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
  }
  assert.equal(rawPaths.every((path) => !existsSync(path)), true);
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
