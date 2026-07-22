import { execFile } from "node:child_process";

import { InfrastructureError } from "../config.js";
import { createHostGitEnvironment } from "../git/environment.js";
import { isGitObjectId } from "../git/object-id.js";
import { hasExactShape, isRecord } from "../json.js";
import { checkProtectedPaths } from "../sandbox/policy.js";
import type { FinalReviewDispatchInput } from "./run.js";

const batchIdPattern = /^p[1-9][0-9]*-[a-f0-9]{12}-r[1-9][0-9]*$/u;
const gitRefPattern = /^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type FinalReviewBasePhase =
  | "base-moving"
  | "needs-base-resolution"
  | "needs-reconcile"
  | "replacement-review"
  | "review"
  | "review-only"
  | "verification-failed";

export type FinalReviewBaseFailure =
  | "force-push"
  | "merge-conflict"
  | "non-linear-history"
  | "unexpected-merge"
  | "unknown-commit"
  | "verification-failed";

export type FinalReviewBaseHistoryEvent =
  | {
      kind: "target-refresh";
      previousTargetBase: string;
      targetBase: string;
    }
  | {
      kind: "target-refresh-limit";
      previousTargetBase: string;
      targetBase: string;
    }
  | {
      expectedBatchHead: string;
      kind: "batch-divergence";
      observedBatchHead: string;
      reason: Exclude<
        FinalReviewBaseFailure,
        "merge-conflict" | "verification-failed"
      >;
    }
  | {
      auditEventId: string;
      beforeHead: string;
      head: string;
      kind: "human-base-merge";
      targetBase: string;
    }
  | {
      kind: "review-failure";
      reason: "merge-conflict" | "verification-failed";
    };

export interface FinalReviewBaseProgress extends FinalReviewDispatchInput {
  baseRefreshes: 0 | 1;
  branch: string;
  failure: FinalReviewBaseFailure | null;
  history: FinalReviewBaseHistoryEvent[];
  phase: FinalReviewBasePhase;
  schemaVersion: 1;
}

export interface FinalReviewRefOptions {
  batchRef: string;
  targetRef: string;
}

export interface ReplacementFinalReviewInput extends FinalReviewDispatchInput {
  previousTargetBase: string;
}

export interface FinalReviewBaseRuntime {
  dispatchReplacementReview: (
    input: ReplacementFinalReviewInput,
  ) => Promise<void> | void;
}

export interface HumanBaseMergeInput {
  auditEventId: string;
  head: string;
}

interface GitResult {
  exitCode: number;
  stdout: string;
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function validDispatchInput(input: FinalReviewDispatchInput): boolean {
  return (
    isRecord(input) &&
    batchIdPattern.test(input.batchId) &&
    isGitObjectId(input.batchHead) &&
    isGitObjectId(input.targetBase) &&
    Number.isSafeInteger(input.pullRequest) &&
    input.pullRequest > 0
  );
}

function validateProgress(progress: FinalReviewBaseProgress): void {
  const phases = new Set<FinalReviewBasePhase>([
    "base-moving",
    "needs-base-resolution",
    "needs-reconcile",
    "replacement-review",
    "review",
    "review-only",
    "verification-failed",
  ]);
  if (
    !hasExactShape(progress, [
      "baseRefreshes",
      "batchHead",
      "batchId",
      "branch",
      "failure",
      "history",
      "phase",
      "pullRequest",
      "schemaVersion",
      "targetBase",
    ]) ||
    progress.schemaVersion !== 1 ||
    !validDispatchInput(progress) ||
    progress.branch !== `sandcastle/${progress.batchId}` ||
    (progress.baseRefreshes !== 0 && progress.baseRefreshes !== 1) ||
    !phases.has(progress.phase) ||
    !Array.isArray(progress.history)
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_BASE_STATE_INVALID",
      "Final review base progress is invalid.",
    );
  }
}

function git(
  repositoryPath: string,
  arguments_: string[],
  allowFailure = false,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      arguments_,
      {
        cwd: repositoryPath,
        encoding: "utf8",
        env: createHostGitEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        if (error && !allowFailure) {
          reject(
            infrastructureError(
              "FINAL_REVIEW_GIT_FAILED",
              "Unable to inspect fixed final review refs.",
            ),
          );
          return;
        }
        resolve({ exitCode, stdout });
      },
    );
  });
}

async function resolveCommit(repositoryPath: string, ref: string): Promise<string> {
  const head = (
    await git(repositoryPath, ["rev-parse", "--verify", `${ref}^{commit}`])
  ).stdout.trim();
  if (!isGitObjectId(head)) {
    throw infrastructureError(
      "FINAL_REVIEW_REF_INVALID",
      "A final review ref does not resolve to a complete commit.",
    );
  }
  return head;
}

async function classifyBatchDivergence(
  repositoryPath: string,
  expected: string,
  observed: string,
): Promise<Exclude<FinalReviewBaseFailure, "merge-conflict" | "verification-failed">> {
  const observedDescendsFromExpected = await git(
    repositoryPath,
    ["merge-base", "--is-ancestor", expected, observed],
    true,
  );
  if (observedDescendsFromExpected.exitCode === 0) {
    const commits = await git(repositoryPath, [
      "rev-list",
      "--parents",
      `${expected}..${observed}`,
    ]);
    return commits.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .some((line) => line.trim().split(/\s+/u).length > 2)
      ? "unexpected-merge"
      : "unknown-commit";
  }
  if (observedDescendsFromExpected.exitCode !== 1) {
    throw infrastructureError(
      "FINAL_REVIEW_GIT_FAILED",
      "Unable to classify divergent Batch history.",
    );
  }
  const expectedDescendsFromObserved = await git(
    repositoryPath,
    ["merge-base", "--is-ancestor", observed, expected],
    true,
  );
  if (expectedDescendsFromObserved.exitCode === 0) return "force-push";
  if (expectedDescendsFromObserved.exitCode === 1) return "non-linear-history";
  throw infrastructureError(
    "FINAL_REVIEW_GIT_FAILED",
    "Unable to classify divergent Batch history.",
  );
}

export function createFinalReviewBaseProgress(
  input: FinalReviewDispatchInput,
): FinalReviewBaseProgress {
  if (!validDispatchInput(input)) {
    throw infrastructureError(
      "FINAL_REVIEW_INPUT_INVALID",
      "Final review base tracking requires fixed Batch, base, and PR identities.",
    );
  }
  return {
    baseRefreshes: 0,
    batchHead: input.batchHead,
    batchId: input.batchId,
    branch: `sandcastle/${input.batchId}`,
    failure: null,
    history: [],
    phase: "review",
    pullRequest: input.pullRequest,
    schemaVersion: 1,
    targetBase: input.targetBase,
  };
}

export async function reconcileFinalReviewBase(
  repositoryPath: string,
  progress: FinalReviewBaseProgress,
  refs: FinalReviewRefOptions,
  runtime: FinalReviewBaseRuntime,
): Promise<FinalReviewBaseProgress> {
  validateProgress(progress);
  if (
    !hasExactShape(refs, ["batchRef", "targetRef"]) ||
    !gitRefPattern.test(refs.batchRef) ||
    !gitRefPattern.test(refs.targetRef)
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_REF_INVALID",
      "Final review refs must be explicit local or remote Git refs.",
    );
  }
  if (
    progress.phase !== "review" &&
    progress.phase !== "replacement-review" &&
    progress.phase !== "review-only"
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_BASE_PHASE_INVALID",
      "The current final review phase cannot refresh its target base.",
    );
  }

  const [batchHead, targetBase] = await Promise.all([
    resolveCommit(repositoryPath, refs.batchRef),
    resolveCommit(repositoryPath, refs.targetRef),
  ]);
  if (batchHead !== progress.batchHead) {
    const reason = await classifyBatchDivergence(
      repositoryPath,
      progress.batchHead,
      batchHead,
    );
    return {
      ...progress,
      failure: reason,
      history: [
        ...progress.history,
        {
          expectedBatchHead: progress.batchHead,
          kind: "batch-divergence",
          observedBatchHead: batchHead,
          reason,
        },
      ],
      phase: "needs-reconcile",
    };
  }
  if (targetBase === progress.targetBase) return progress;

  const event = {
    previousTargetBase: progress.targetBase,
    targetBase,
  };
  if (progress.baseRefreshes === 0) {
    const dispatch: ReplacementFinalReviewInput = {
      batchHead,
      batchId: progress.batchId,
      previousTargetBase: progress.targetBase,
      pullRequest: progress.pullRequest,
      targetBase,
    };
    await runtime.dispatchReplacementReview(dispatch);
    return {
      ...progress,
      baseRefreshes: 1,
      history: [...progress.history, { ...event, kind: "target-refresh" }],
      phase: "replacement-review",
      targetBase,
    };
  }
  return {
    ...progress,
    history: [...progress.history, { ...event, kind: "target-refresh-limit" }],
    phase: "base-moving",
    targetBase,
  };
}

export function recordFinalReviewBaseFailure(
  progress: FinalReviewBaseProgress,
  code: "FINAL_REVIEW_MERGE_CONFLICT" | "FINAL_REVIEW_VERIFICATION_FAILED",
): FinalReviewBaseProgress {
  validateProgress(progress);
  if (
    progress.phase !== "review" &&
    progress.phase !== "replacement-review" &&
    progress.phase !== "review-only"
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_BASE_PHASE_INVALID",
      "The current final review phase cannot record a merge or verification failure.",
    );
  }
  if (code === "FINAL_REVIEW_MERGE_CONFLICT") {
    return {
      ...progress,
      failure: "merge-conflict",
      history: [
        ...progress.history,
        { kind: "review-failure", reason: "merge-conflict" },
      ],
      phase: "needs-base-resolution",
    };
  }
  if (code === "FINAL_REVIEW_VERIFICATION_FAILED") {
    return {
      ...progress,
      failure: "verification-failed",
      history: [
        ...progress.history,
        { kind: "review-failure", reason: "verification-failed" },
      ],
      phase: "verification-failed",
    };
  }
  throw infrastructureError(
    "FINAL_REVIEW_FAILURE_INVALID",
    "Unsupported final review failure evidence cannot change base state.",
  );
}

export async function acceptHumanBaseMerge(
  repositoryPath: string,
  progress: FinalReviewBaseProgress,
  input: HumanBaseMergeInput,
): Promise<FinalReviewBaseProgress> {
  validateProgress(progress);
  if (progress.phase !== "needs-base-resolution") {
    throw infrastructureError(
      "HUMAN_BASE_MERGE_NOT_ALLOWED",
      "Human base merges are allowed only after an audited merge conflict.",
    );
  }
  if (
    !hasExactShape(input, ["auditEventId", "head"]) ||
    !uuidPattern.test(input.auditEventId) ||
    !isGitObjectId(input.head) ||
    progress.history.some(
      (event) =>
        event.kind === "human-base-merge" &&
        event.auditEventId === input.auditEventId,
    )
  ) {
    throw infrastructureError(
      "HUMAN_BASE_MERGE_INVALID",
      "Human base merge evidence is invalid or already recorded.",
    );
  }

  const [head, branch, status, parents] = await Promise.all([
    git(repositoryPath, ["rev-parse", "HEAD"]),
    git(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(repositoryPath, ["status", "--porcelain", "--untracked-files=all"]),
    git(repositoryPath, ["show", "-s", "--format=%P", input.head]),
  ]);
  const expectedParents = `${progress.batchHead} ${progress.targetBase}`;
  if (
    head.stdout.trim() !== input.head ||
    branch.stdout.trim() !== progress.branch ||
    status.stdout !== "" ||
    parents.stdout.trim() !== expectedParents
  ) {
    throw infrastructureError(
      "HUMAN_BASE_MERGE_INVALID",
      "The only allowed base merge must have the exact audited Batch and target parents.",
    );
  }
  await checkProtectedPaths(repositoryPath, progress.batchHead);

  return {
    ...progress,
    batchHead: input.head,
    failure: null,
    history: [
      ...progress.history,
      {
        auditEventId: input.auditEventId,
        beforeHead: progress.batchHead,
        head: input.head,
        kind: "human-base-merge",
        targetBase: progress.targetBase,
      },
    ],
    phase: "review-only",
  };
}
