import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const batchId = "p1-aaaaaaaaaaaa-r9001";

function finding() {
  return {
    actionable: true,
    code: "SPEC_MISMATCH",
    message: "The cumulative result still misses required behavior.",
  };
}

function reviewResult(input, index) {
  return {
    auditEventId: `00000000-0000-4000-8000-00000000000${index}`,
    axes: {
      Spec: {
        receiptId: `spec-review-${index}`,
        sessionId: `10000000-0000-4000-8000-00000000000${index}`,
      },
      Standards: {
        receiptId: `standards-review-${index}`,
        sessionId: `20000000-0000-4000-8000-00000000000${index}`,
      },
    },
    batchHead: input.batchHead,
    findings: [finding()],
    reviewedHead: `${index}`.repeat(40),
    status: "findings",
    verificationHash: `${index}`.repeat(64),
  };
}

function createHumanRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-human-final-fix-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "app.txt"), "before\n");
  execFileSync("git", ["-C", repository, "add", "app.txt"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "before human fix",
  ]);
  const head = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["-C", repository, "checkout", "--quiet", "-b", `sandcastle/${batchId}`]);
  return { head, repository };
}

function commitHumanChange(repository, path, content) {
  const target = join(repository, path);
  if (path.includes("/")) mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
  execFileSync("git", ["-C", repository, "add", path]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Human",
    "-c",
    "user.email=human@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "human final fix",
  ]);
  return execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

test("automatic final fix has exactly two rounds and then preserves a needs-human-fix state", async () => {
  const { createFinalReviewProgress, executeFinalReviewStep } = await import(
    "../dist/index.js"
  );
  let progress = createFinalReviewProgress({
    batchHead: "b".repeat(40),
    batchId,
    pullRequest: 44,
    targetBase: "c".repeat(40),
  });
  const phases = [];
  const reviewCalls = [];
  const fixCalls = [];
  const fixedHeads = ["d".repeat(40), "e".repeat(40)];
  const runtime = {
    async runAutomaticFix(input) {
      fixCalls.push(input);
      const fixNumber = fixCalls.length;
      return {
        auditEventId: `30000000-0000-4000-8000-00000000000${fixNumber}`,
        beforeHead: input.batchHead,
        head: fixedHeads[fixNumber - 1],
        marker: "sandcastle-final-fix-result",
        schemaVersion: 1,
        sessionId: `40000000-0000-4000-8000-00000000000${fixNumber}`,
        skill: { ok: true, receiptId: `final-fix-${fixNumber}` },
        status: "fixed",
      };
    },
    async runFullReview(input) {
      reviewCalls.push(input);
      return reviewResult(input, reviewCalls.length);
    },
  };

  for (let step = 0; step < 5; step += 1) {
    phases.push(progress.phase);
    progress = await executeFinalReviewStep(progress, runtime);
  }

  assert.deepEqual(phases, [
    "review-0",
    "fix-1",
    "review-1",
    "fix-2",
    "review-2",
  ]);
  assert.equal(reviewCalls.length, 3);
  assert.equal(fixCalls.length, 2);
  assert.equal(progress.phase, "needs-human-fix");
  assert.equal(progress.automaticFixesUsed, 2);
  assert.equal(progress.batchHead, "e".repeat(40));
  assert.equal(progress.branch, `sandcastle/${batchId}`);
  assert.equal(progress.pullRequest, 44);
  assert.equal(progress.history.length, 5);
  await assert.rejects(
    executeFinalReviewStep(progress, runtime),
    (error) => error.diagnostics?.[0]?.code === "FINAL_REVIEW_PHASE_TERMINAL",
  );
  assert.equal(fixCalls.length, 2);
});

test("an authorized human fix transitions only to review-only without resetting fix quota", async () => {
  const {
    acceptHumanFinalFix,
    createFinalReviewProgress,
    executeFinalReviewStep,
  } = await import("../dist/index.js");
  const { head: beforeHead, repository } = createHumanRepository();
  const initial = createFinalReviewProgress({
    batchHead: beforeHead,
    batchId,
    pullRequest: 44,
    targetBase: "c".repeat(40),
  });
  const waitingForHuman = {
    ...initial,
    automaticFixesUsed: 2,
    pendingFindings: [finding()],
    phase: "needs-human-fix",
  };
  const head = commitHumanChange(repository, "app.txt", "after\n");
  let progress = await acceptHumanFinalFix(repository, waitingForHuman, {
    auditEventId: "50000000-0000-4000-8000-000000000005",
    beforeHead,
    head,
  });

  assert.equal(progress.phase, "review-only");
  assert.equal(progress.automaticFixesUsed, 2);
  assert.equal(progress.batchHead, head);
  assert.equal(progress.branch, `sandcastle/${batchId}`);
  assert.equal(progress.pullRequest, 44);

  progress = await executeFinalReviewStep(progress, {
    async runAutomaticFix() {
      assert.fail("review-only must never dispatch another automatic fix");
    },
    async runFullReview(input) {
      assert.equal(input.mode, "review-only");
      return reviewResult(input, 6);
    },
  });
  assert.equal(progress.phase, "needs-human-fix");
  assert.equal(progress.automaticFixesUsed, 2);
});

test("human final fixes are rejected outside recovery states and on protected paths", async () => {
  const { acceptHumanFinalFix, createFinalReviewProgress } = await import(
    "../dist/index.js"
  );
  const { head: beforeHead, repository } = createHumanRepository();
  const initial = createFinalReviewProgress({
    batchHead: beforeHead,
    batchId,
    pullRequest: 44,
    targetBase: "c".repeat(40),
  });
  const protectedHead = commitHumanChange(
    repository,
    ".github/workflows/sandcastle.yml",
    "name: tampered\n",
  );
  const input = {
    auditEventId: "50000000-0000-4000-8000-000000000005",
    beforeHead,
    head: protectedHead,
  };

  await assert.rejects(
    acceptHumanFinalFix(repository, initial, input),
    (error) => error.diagnostics?.[0]?.code === "HUMAN_FIX_NOT_ALLOWED",
  );
  await assert.rejects(
    acceptHumanFinalFix(
      repository,
      {
        ...initial,
        automaticFixesUsed: 2,
        pendingFindings: [finding()],
        phase: "needs-human-fix",
      },
      input,
    ),
    (error) => error.diagnostics?.[0]?.code === "PROTECTED_PATH_MODIFIED",
  );
});
