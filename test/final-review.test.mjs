import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

function reviewState(
  ticketStates = ["closed", "closed"],
  batchHead = "b".repeat(40),
  targetBase = "c".repeat(40),
) {
  return {
    batchHead,
    batchId: "p1-aaaaaaaaaaaa-r9001",
    parent: 1,
    pullRequest: { draft: true, number: 44 },
    targetBase,
    tickets: ticketStates.map((state, index) => ({
      number: index + 2,
      state,
    })),
  };
}

function createReviewRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-final-review-"));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, "base.txt"), "base\n");
  execFileSync("git", ["-C", repository, "add", "base.txt"]);
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
    "base",
  ]);
  const targetBase = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  writeFileSync(join(repository, "batch.txt"), "batch\n");
  execFileSync("git", ["-C", repository, "add", "batch.txt"]);
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
    "batch",
  ]);
  const batchHead = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { batchHead, repository, targetBase };
}

function reviewConfig() {
  const requiredFileCheck =
    'if (!require("node:fs").existsSync("batch.txt")) process.exit(7)';
  return {
    audit: { retentionDays: 30 },
    commands: {
      tests: [{ argv: [process.execPath, "-e", requiredFileCheck] }],
      verification: [{ argv: [process.execPath, "-e", requiredFileCheck] }],
    },
    execution: {
      jobTimeoutMinutes: 350,
      maxTicketsPerRun: 3,
      minimumRemainingMinutes: 140,
      processingBudgetMinutes: 300,
      ticketTimeoutMinutes: 120,
    },
    provider: { kind: "anthropic-compatible", models: { ticket: "ticket" } },
    queue: { ownershipLabel: "sandcastle", readyLabel: "ready-for-agent" },
    runtime: { adapter: "node-npm", version: "22.22.2" },
    schemaVersion: 1,
  };
}

function cumulativeSpecification() {
  const content = "Parent #1 with completed Tickets #2 and #3.";
  return {
    content,
    marker: "sandcastle-final-review-spec",
    parent: 1,
    schemaVersion: 1,
    specHash: createHash("sha256").update(content).digest("hex"),
    tickets: [2, 3],
  };
}

function finalReviewFixture() {
  const { batchHead, repository, targetBase } = createReviewRepository();
  const configPath = join(mkdtempSync(join(tmpdir(), "sandcastle-final-config-")), "config.json");
  writeFileSync(configPath, `${JSON.stringify(reviewConfig())}\n`);
  const state = reviewState(["closed", "closed"], batchHead, targetBase);
  return {
    options: {
      batchHead,
      batchId: state.batchId,
      configPath,
      pullRequest: 44,
      specification: cumulativeSpecification(),
      targetBase,
    },
    repository,
    state,
  };
}

function createIdentityCheckingGitPath() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-git-wrapper-"));
  const executable = join(directory, "git");
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  writeFileSync(
    executable,
    `#!/bin/sh
if [ "\${1:-}" = "merge" ]; then
  test -n "\${GIT_AUTHOR_NAME:-}" || exit 91
  test -n "\${GIT_AUTHOR_EMAIL:-}" || exit 91
  test -n "\${GIT_COMMITTER_NAME:-}" || exit 91
  test -n "\${GIT_COMMITTER_EMAIL:-}" || exit 91
fi
exec ${JSON.stringify(realGit)} "$@"
`,
  );
  chmodSync(executable, 0o755);
  return `${directory}${delimiter}${process.env.PATH ?? ""}`;
}

function validAxisResult(input, findings = []) {
  return {
    axis: input.axis,
    findings,
    marker: "sandcastle-final-review-result",
    reviewedHead: input.reviewedHead,
    schemaVersion: 1,
    sessionId:
      input.axis === "Standards"
        ? "123e4567-e89b-42d3-a456-426614174000"
        : "223e4567-e89b-42d3-a456-426614174001",
    skill: {
      ok: true,
      receiptId: `code-review-${input.axis.toLowerCase()}`,
    },
    specificationHash: input.specification.specHash,
    verificationHash: input.verificationHash,
  };
}

test("final review dispatches only after every child Ticket is closed", async () => {
  const { dispatchFinalReview } = await import("../dist/index.js");
  const dispatched = [];
  let state = reviewState(["closed", "open"]);
  const runtime = {
    async dispatch(input) {
      dispatched.push(input);
    },
    async readState() {
      return state;
    },
  };

  assert.deepEqual(
    await dispatchFinalReview("/repository", state.batchId, runtime),
    {
      batchId: state.batchId,
      openTickets: [3],
      status: "waiting-for-tickets",
    },
  );
  assert.deepEqual(dispatched, []);

  state = reviewState();
  assert.deepEqual(
    await dispatchFinalReview("/repository", state.batchId, runtime),
    {
      batchHead: state.batchHead,
      batchId: state.batchId,
      pullRequest: 44,
      status: "dispatched",
      targetBase: state.targetBase,
    },
  );
  assert.deepEqual(dispatched, [
    {
      batchHead: state.batchHead,
      batchId: state.batchId,
      pullRequest: 44,
      targetBase: state.targetBase,
    },
  ]);
});

test("cumulative final review verifies a temporary merge on independent Standards and Spec axes", async () => {
  const { runFinalReview } = await import("../dist/index.js");
  const { options, repository, state } = finalReviewFixture();
  const reviews = [];
  const ready = [];
  const result = await runFinalReview(
    repository,
    options,
    {
      async markPullRequestReady(input) {
        ready.push(input);
      },
      async readState() {
        return state;
      },
      async reviewAxis(input) {
        reviews.push(input);
        return validAxisResult(input);
      },
    },
  );

  assert.equal(result.status, "passed");
  assert.match(result.reviewedHead, /^[a-f0-9]{40}$/u);
  assert.notEqual(result.reviewedHead, options.batchHead);
  assert.deepEqual(
    reviews.map(({ axis }) => axis).sort(),
    ["Spec", "Standards"],
  );
  assert.equal(new Set(reviews.map(({ reviewedHead }) => reviewedHead)).size, 1);
  assert.equal(new Set(reviews.map(({ verificationHash }) => verificationHash)).size, 1);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].pullRequest, 44);
  assert.equal(ready[0].reviewedHead, result.reviewedHead);
});

test("cumulative final review supplies deterministic identity to Git merge", async () => {
  const { runFinalReview } = await import("../dist/index.js");
  const { options, repository, state } = finalReviewFixture();
  const previousPath = process.env.PATH;
  process.env.PATH = createIdentityCheckingGitPath();
  try {
    const result = await runFinalReview(repository, options, {
      async markPullRequestReady() {},
      async readState() {
        return state;
      },
      async reviewAxis(input) {
        return validAxisResult(input);
      },
    });
    assert.equal(result.status, "passed");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("an actionable finding blocks final review without marking the PR ready", async () => {
  const { runFinalReview } = await import("../dist/index.js");
  const { options, repository, state } = finalReviewFixture();
  const ready = [];
  const result = await runFinalReview(repository, options, {
    async markPullRequestReady(input) {
      ready.push(input);
    },
    async readState() {
      return state;
    },
    async reviewAxis(input) {
      return validAxisResult(
        input,
        input.axis === "Spec"
          ? [
              {
                actionable: true,
                code: "SPEC_MISMATCH",
                message: "The cumulative result misses one required behavior.",
              },
            ]
          : [],
      );
    },
  });

  assert.equal(result.status, "findings");
  assert.deepEqual(result.actionableFindings.map(({ code }) => code), [
    "SPEC_MISMATCH",
  ]);
  assert.deepEqual(ready, []);
});

test("a missing result marker or required execution receipt fails final review closed", async () => {
  const { runFinalReview } = await import("../dist/index.js");
  const { options, repository, state } = finalReviewFixture();
  await assert.rejects(
    runFinalReview(repository, options, {
      async markPullRequestReady() {
        assert.fail("invalid review evidence must not mark the PR ready");
      },
      async readState() {
        return state;
      },
      async reviewAxis(input) {
        const result = validAxisResult(input);
        if (input.axis === "Spec") delete result.skill;
        return result;
      },
    }),
    (error) => error.diagnostics?.[0]?.code === "FINAL_REVIEW_RESULT_INVALID",
  );
});

test("a new child Ticket observed after review exits the completion path", async () => {
  const { runFinalReview } = await import("../dist/index.js");
  const { options, repository, state } = finalReviewFixture();
  let reads = 0;
  const ready = [];
  const result = await runFinalReview(repository, options, {
    async markPullRequestReady(input) {
      ready.push(input);
    },
    async readState() {
      reads += 1;
      return reads === 1
        ? state
        : {
            ...state,
            tickets: [...state.tickets, { number: 4, state: "open" }],
          };
    },
    async reviewAxis(input) {
      return validAxisResult(input);
    },
  });

  assert.deepEqual(result, {
    batchId: state.batchId,
    openTickets: [4],
    status: "tickets-changed",
  });
  assert.deepEqual(ready, []);
});
