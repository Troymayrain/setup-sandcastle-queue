import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const batchId = "p1-aaaaaaaaaaaa-r9001";
const batchBranch = `sandcastle/${batchId}`;

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  }).trim();
}

function commit(repository, path, content, message) {
  writeFileSync(join(repository, path), content);
  git(repository, ["add", path]);
  git(repository, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  return git(repository, ["rev-parse", "HEAD"]);
}

function createDivergedRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-base-drift-"));
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  const originalBase = commit(repository, "base.txt", "base\n", "base");
  git(repository, ["checkout", "--quiet", "-b", batchBranch]);
  const batchHead = commit(repository, "batch.txt", "batch\n", "batch");
  git(repository, ["checkout", "--quiet", "main"]);
  const targetBase = commit(repository, "target.txt", "target-1\n", "target 1");
  return { batchHead, originalBase, repository, targetBase };
}

test("target base drift dispatches one replacement review and then stops at base-moving", async () => {
  const { createFinalReviewBaseProgress, reconcileFinalReviewBase } = await import(
    "../dist/index.js"
  );
  const { batchHead, originalBase, repository, targetBase } =
    createDivergedRepository();
  let progress = createFinalReviewBaseProgress({
    batchHead,
    batchId,
    pullRequest: 44,
    targetBase: originalBase,
  });
  const dispatched = [];
  const runtime = {
    async dispatchReplacementReview(input) {
      dispatched.push(input);
    },
  };
  const refs = {
    batchRef: `refs/heads/${batchBranch}`,
    targetRef: "refs/heads/main",
  };

  progress = await reconcileFinalReviewBase(repository, progress, refs, runtime);
  assert.equal(progress.phase, "replacement-review");
  assert.equal(progress.baseRefreshes, 1);
  assert.equal(progress.targetBase, targetBase);
  assert.deepEqual(dispatched, [
    {
      batchHead,
      batchId,
      previousTargetBase: originalBase,
      pullRequest: 44,
      targetBase,
    },
  ]);

  const movedAgain = commit(repository, "target.txt", "target-2\n", "target 2");
  progress = await reconcileFinalReviewBase(repository, progress, refs, runtime);
  assert.equal(progress.phase, "base-moving");
  assert.equal(progress.baseRefreshes, 1);
  assert.equal(progress.targetBase, movedAgain);
  assert.equal(dispatched.length, 1);
});

test("unknown commits, unexpected merges, force-pushes, and non-linear history require reconciliation", async () => {
  const { createFinalReviewBaseProgress, reconcileFinalReviewBase } = await import(
    "../dist/index.js"
  );
  const cases = [
    {
      mutate({ repository }) {
        git(repository, ["checkout", "--quiet", batchBranch]);
        commit(repository, "unknown.txt", "unknown\n", "unknown");
      },
      reason: "unknown-commit",
    },
    {
      mutate({ repository }) {
        git(repository, ["checkout", "--quiet", batchBranch]);
        git(repository, ["checkout", "--quiet", "-b", "unexpected-side"]);
        commit(repository, "side.txt", "side\n", "side");
        git(repository, ["checkout", "--quiet", batchBranch]);
        git(repository, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "merge",
          "--quiet",
          "--no-ff",
          "unexpected-side",
          "-m",
          "unexpected merge",
        ]);
      },
      reason: "unexpected-merge",
    },
    {
      mutate({ originalBase, repository }) {
        git(repository, ["branch", "--force", batchBranch, originalBase]);
      },
      reason: "force-push",
    },
    {
      mutate({ repository, targetBase }) {
        git(repository, ["branch", "--force", batchBranch, targetBase]);
      },
      reason: "non-linear-history",
    },
  ];

  for (const scenario of cases) {
    const fixture = createDivergedRepository();
    scenario.mutate(fixture);
    const progress = createFinalReviewBaseProgress({
      batchHead: fixture.batchHead,
      batchId,
      pullRequest: 44,
      targetBase: fixture.targetBase,
    });
    const result = await reconcileFinalReviewBase(
      fixture.repository,
      progress,
      {
        batchRef: `refs/heads/${batchBranch}`,
        targetRef: "refs/heads/main",
      },
      {
        async dispatchReplacementReview() {
          assert.fail("diverged Batch history must not dispatch review");
        },
      },
    );
    assert.equal(result.phase, "needs-reconcile");
    assert.equal(result.failure, scenario.reason);
  }
});

test("merge conflicts require base resolution while completion failures remain explicit", async () => {
  const { createFinalReviewBaseProgress, recordFinalReviewBaseFailure } =
    await import("../dist/index.js");
  const input = {
    batchHead: "b".repeat(40),
    batchId,
    pullRequest: 44,
    targetBase: "c".repeat(40),
  };

  const conflict = recordFinalReviewBaseFailure(
    createFinalReviewBaseProgress(input),
    "FINAL_REVIEW_MERGE_CONFLICT",
  );
  assert.equal(conflict.phase, "needs-base-resolution");
  assert.equal(conflict.failure, "merge-conflict");

  const verification = recordFinalReviewBaseFailure(
    createFinalReviewBaseProgress(input),
    "FINAL_REVIEW_VERIFICATION_FAILED",
  );
  assert.equal(verification.phase, "verification-failed");
  assert.equal(verification.failure, "verification-failed");
});

test("only an exact audited-parent human base merge can return to full review-only", async () => {
  const {
    acceptHumanBaseMerge,
    createFinalReviewBaseProgress,
    recordFinalReviewBaseFailure,
  } = await import("../dist/index.js");
  const fixture = createDivergedRepository();
  let progress = recordFinalReviewBaseFailure(
    createFinalReviewBaseProgress({
      batchHead: fixture.batchHead,
      batchId,
      pullRequest: 44,
      targetBase: fixture.targetBase,
    }),
    "FINAL_REVIEW_MERGE_CONFLICT",
  );
  git(fixture.repository, ["checkout", "--quiet", batchBranch]);
  git(fixture.repository, [
    "-c",
    "user.name=Human",
    "-c",
    "user.email=human@example.invalid",
    "merge",
    "--quiet",
    "--no-ff",
    "main",
    "-m",
    "authorized base merge",
  ]);
  const mergeHead = git(fixture.repository, ["rev-parse", "HEAD"]);
  assert.equal(
    git(fixture.repository, ["show", "-s", "--format=%P", mergeHead]),
    `${fixture.batchHead} ${fixture.targetBase}`,
  );

  progress = await acceptHumanBaseMerge(fixture.repository, progress, {
    auditEventId: "60000000-0000-4000-8000-000000000006",
    head: mergeHead,
  });
  assert.equal(progress.phase, "review-only");
  assert.equal(progress.batchHead, mergeHead);
  assert.equal(progress.targetBase, fixture.targetBase);
  assert.equal(progress.branch, batchBranch);
  assert.equal(progress.pullRequest, 44);
  assert.equal(progress.failure, null);
});

test("a merge with any unaudited parent is rejected as base resolution", async () => {
  const {
    acceptHumanBaseMerge,
    createFinalReviewBaseProgress,
    recordFinalReviewBaseFailure,
  } = await import("../dist/index.js");
  const fixture = createDivergedRepository();
  const progress = recordFinalReviewBaseFailure(
    createFinalReviewBaseProgress({
      batchHead: fixture.batchHead,
      batchId,
      pullRequest: 44,
      targetBase: fixture.targetBase,
    }),
    "FINAL_REVIEW_MERGE_CONFLICT",
  );
  git(fixture.repository, ["checkout", "--quiet", batchBranch]);
  git(fixture.repository, ["checkout", "--quiet", "-b", "wrong-parent"]);
  const wrongParent = commit(
    fixture.repository,
    "wrong.txt",
    "wrong\n",
    "wrong parent",
  );
  git(fixture.repository, ["checkout", "--quiet", batchBranch]);
  git(fixture.repository, [
    "-c",
    "user.name=Human",
    "-c",
    "user.email=human@example.invalid",
    "merge",
    "--quiet",
    "--no-ff",
    wrongParent,
    "-m",
    "wrong base merge",
  ]);
  const mergeHead = git(fixture.repository, ["rev-parse", "HEAD"]);

  await assert.rejects(
    acceptHumanBaseMerge(fixture.repository, progress, {
      auditEventId: "60000000-0000-4000-8000-000000000006",
      head: mergeHead,
    }),
    (error) => error.diagnostics?.[0]?.code === "HUMAN_BASE_MERGE_INVALID",
  );
});
