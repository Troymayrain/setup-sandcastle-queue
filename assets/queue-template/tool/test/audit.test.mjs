import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createQueueAuditRecord,
  writeQueueAuditEvidence,
} from "../dist/audit.js";

const secret = "secret-must-never-be-evidence";
const head = "a".repeat(40);

test("audit artifact and Job Summary contain only allowlisted redacted fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-audit-"));
  const artifact = join(root, "audit.json");
  const summary = join(root, "summary.md");
  const record = createQueueAuditRecord({
    durationMs: 123.9,
    expectedHead: head,
    operation: "continue",
    result: {
      commandOutput: secret,
      completionCommit: head,
      environment: { GITHUB_TOKEN: secret },
      prompt: secret,
      providerBody: secret,
      response: secret,
      sessionId: "session-58",
      status: "continued",
      ticket: 58,
      token: secret,
    },
    runId: "9001",
  });

  await writeQueueAuditEvidence(record, {
    ANTHROPIC_AUTH_TOKEN: secret,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_TOKEN: secret,
    SANDCASTLE_AUDIT_PATH: artifact,
  });

  assert.deepEqual(record, {
    completionCommit: head,
    durationMs: 123,
    expectedHead: head,
    operation: "continue",
    runId: "9001",
    schemaVersion: 1,
    sessionId: "session-58",
    status: "continued",
    ticket: 58,
  });
  const artifactSource = readFileSync(artifact, "utf8");
  const summarySource = readFileSync(summary, "utf8");
  assert.equal(artifactSource.includes(secret), false);
  assert.equal(summarySource.includes(secret), false);
  assert.equal(statSync(artifact).mode & 0o777, 0o600);
  assert.equal(
    [
      "commandOutput",
      "environment",
      "prompt",
      "providerBody",
      "response",
      "token",
    ].some((field) => artifactSource.includes(field)),
    false,
  );
});

test("failure evidence never retains an exception or arbitrary result fields", () => {
  const record = createQueueAuditRecord({
    durationMs: Number.NaN,
    operation: "start",
    result: {
      error: new Error(secret),
      reason: secret,
      status: secret,
    },
    runId: secret,
  });

  assert.deepEqual(record, {
    durationMs: 0,
    operation: "start",
    runId: "unknown",
    schemaVersion: 1,
    status: "failure",
  });
  assert.equal(JSON.stringify(record).includes(secret), false);
});
