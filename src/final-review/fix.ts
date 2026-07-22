import { execFile } from "node:child_process";

import { InfrastructureError } from "../config.js";
import { checkProtectedPaths } from "../sandbox/policy.js";
import type {
  FinalReviewDispatchInput,
  FinalReviewFinding,
} from "./run.js";

const batchIdPattern = /^p[1-9][0-9]*-[a-f0-9]{12}-r[1-9][0-9]*$/u;
const gitShaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export type FinalReviewPhase =
  | "fix-1"
  | "fix-2"
  | "needs-base-resolution"
  | "needs-human-fix"
  | "passed"
  | "review-0"
  | "review-1"
  | "review-2"
  | "review-only";

export interface FinalReviewAxisExecution {
  receiptId: string;
  sessionId: string;
}

export interface FinalReviewCycleReviewResult {
  auditEventId: string;
  axes: {
    Spec: FinalReviewAxisExecution;
    Standards: FinalReviewAxisExecution;
  };
  batchHead: string;
  findings: FinalReviewFinding[];
  reviewedHead: string;
  status: "findings" | "passed";
  verificationHash: string;
}

export interface AutomaticFinalFixResult {
  auditEventId: string;
  beforeHead: string;
  head: string;
  marker: "sandcastle-final-fix-result";
  schemaVersion: 1;
  sessionId: string;
  skill: {
    ok: true;
    receiptId: string;
  };
  status: "fixed";
}

export type FinalReviewHistoryEvent =
  | {
      auditEventId: string;
      axes: FinalReviewCycleReviewResult["axes"];
      batchHead: string;
      findingCodes: string[];
      kind: "review";
      outcome: "findings" | "passed";
      phase: "review-0" | "review-1" | "review-2" | "review-only";
      reviewedHead: string;
      verificationHash: string;
    }
  | {
      auditEventId: string;
      beforeHead: string;
      head: string;
      kind: "automatic-fix";
      phase: "fix-1" | "fix-2";
      receiptId: string;
      sessionId: string;
    }
  | {
      auditEventId: string;
      beforeHead: string;
      head: string;
      kind: "human-fix";
    };

export interface FinalReviewProgress extends FinalReviewDispatchInput {
  automaticFixesUsed: 0 | 1 | 2;
  branch: string;
  history: FinalReviewHistoryEvent[];
  pendingFindings: FinalReviewFinding[];
  phase: FinalReviewPhase;
  schemaVersion: 1;
}

export interface FinalReviewCycleReviewInput
  extends FinalReviewDispatchInput {
  mode: "automatic" | "review-only";
  phase: "review-0" | "review-1" | "review-2" | "review-only";
}

export interface AutomaticFinalFixInput extends FinalReviewDispatchInput {
  findings: FinalReviewFinding[];
  fixNumber: 1 | 2;
  phase: "fix-1" | "fix-2";
}

export interface FinalReviewCycleRuntime {
  runAutomaticFix: (
    input: AutomaticFinalFixInput,
  ) => Promise<AutomaticFinalFixResult>;
  runFullReview: (
    input: FinalReviewCycleReviewInput,
  ) => Promise<FinalReviewCycleReviewResult>;
}

export interface HumanFinalFixInput {
  auditEventId: string;
  beforeHead: string;
  head: string;
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function git(
  repositoryPath: string,
  arguments_: string[],
  allowFailure = false,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      arguments_,
      {
        cwd: repositoryPath,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        if (error && !allowFailure) {
          reject(
            infrastructureError(
              "HUMAN_FIX_GIT_FAILED",
              "Unable to verify the appended human final fix.",
            ),
          );
          return;
        }
        resolve({ exitCode, stdout });
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactShape(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validFinding(value: unknown): value is FinalReviewFinding {
  return (
    hasExactShape(value, ["actionable", "code", "message"], ["path"]) &&
    typeof value.actionable === "boolean" &&
    typeof value.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,127}$/u.test(value.code) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 4_000 &&
    (value.path === undefined ||
      (typeof value.path === "string" && value.path.length <= 1_024))
  );
}

function validAxisExecution(value: unknown): value is FinalReviewAxisExecution {
  return (
    hasExactShape(value, ["receiptId", "sessionId"]) &&
    typeof value.receiptId === "string" &&
    opaqueIdPattern.test(value.receiptId) &&
    typeof value.sessionId === "string" &&
    uuidPattern.test(value.sessionId)
  );
}

function validDispatchInput(input: FinalReviewDispatchInput): boolean {
  return (
    batchIdPattern.test(input.batchId) &&
    gitShaPattern.test(input.batchHead) &&
    gitShaPattern.test(input.targetBase) &&
    Number.isSafeInteger(input.pullRequest) &&
    input.pullRequest > 0
  );
}

function expectedAutomaticFixes(phase: FinalReviewPhase): 0 | 1 | 2 | null {
  if (phase === "review-0" || phase === "fix-1") return 0;
  if (phase === "review-1" || phase === "fix-2") return 1;
  if (phase === "review-2") return 2;
  return null;
}

function validateProgress(progress: FinalReviewProgress): void {
  const expected = expectedAutomaticFixes(progress.phase);
  if (
    !hasExactShape(progress, [
      "automaticFixesUsed",
      "batchHead",
      "batchId",
      "branch",
      "history",
      "pendingFindings",
      "phase",
      "pullRequest",
      "schemaVersion",
      "targetBase",
    ]) ||
    progress.schemaVersion !== 1 ||
    !validDispatchInput(progress) ||
    progress.branch !== `sandcastle/${progress.batchId}` ||
    ![0, 1, 2].includes(progress.automaticFixesUsed) ||
    (expected !== null && progress.automaticFixesUsed !== expected) ||
    !Array.isArray(progress.history) ||
    !Array.isArray(progress.pendingFindings) ||
    !progress.pendingFindings.every(validFinding) ||
    ((progress.phase === "fix-1" ||
      progress.phase === "fix-2" ||
      progress.phase === "needs-human-fix") &&
      !progress.pendingFindings.some(({ actionable }) => actionable))
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_PROGRESS_INVALID",
      "Final review progress does not match the bounded phase machine.",
    );
  }
  const eventIds = progress.history.map(({ auditEventId }) => auditEventId);
  if (
    eventIds.some((eventId) => !uuidPattern.test(eventId)) ||
    new Set(eventIds).size !== eventIds.length
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_HISTORY_INVALID",
      "Final review history must contain unique audit event identities.",
    );
  }
}

function usedExecutionIds(progress: FinalReviewProgress): {
  receipts: Set<string>;
  sessions: Set<string>;
} {
  const receipts = new Set<string>();
  const sessions = new Set<string>();
  for (const event of progress.history) {
    if (event.kind === "review") {
      receipts.add(event.axes.Spec.receiptId);
      receipts.add(event.axes.Standards.receiptId);
      sessions.add(event.axes.Spec.sessionId);
      sessions.add(event.axes.Standards.sessionId);
    } else if (event.kind === "automatic-fix") {
      receipts.add(event.receiptId);
      sessions.add(event.sessionId);
    }
  }
  return { receipts, sessions };
}

function validateReviewResult(
  result: FinalReviewCycleReviewResult,
  progress: FinalReviewProgress,
): void {
  const used = usedExecutionIds(progress);
  if (
    !hasExactShape(result, [
      "auditEventId",
      "axes",
      "batchHead",
      "findings",
      "reviewedHead",
      "status",
      "verificationHash",
    ]) ||
    !uuidPattern.test(result.auditEventId) ||
    progress.history.some(({ auditEventId }) => auditEventId === result.auditEventId) ||
    result.batchHead !== progress.batchHead ||
    !gitShaPattern.test(result.reviewedHead) ||
    !hashPattern.test(result.verificationHash) ||
    !hasExactShape(result.axes, ["Spec", "Standards"]) ||
    !validAxisExecution(result.axes.Spec) ||
    !validAxisExecution(result.axes.Standards) ||
    result.axes.Spec.sessionId === result.axes.Standards.sessionId ||
    result.axes.Spec.receiptId === result.axes.Standards.receiptId ||
    used.sessions.has(result.axes.Spec.sessionId) ||
    used.sessions.has(result.axes.Standards.sessionId) ||
    used.receipts.has(result.axes.Spec.receiptId) ||
    used.receipts.has(result.axes.Standards.receiptId) ||
    !Array.isArray(result.findings) ||
    !result.findings.every(validFinding) ||
    (result.status !== "findings" && result.status !== "passed") ||
    (result.status === "findings" &&
      !result.findings.some(({ actionable }) => actionable)) ||
    (result.status === "passed" &&
      result.findings.some(({ actionable }) => actionable))
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_CYCLE_RESULT_INVALID",
      "A full final review returned invalid or mismatched evidence.",
    );
  }
}

function validateFixResult(
  result: AutomaticFinalFixResult,
  progress: FinalReviewProgress,
): void {
  const used = usedExecutionIds(progress);
  if (
    !hasExactShape(result, [
      "auditEventId",
      "beforeHead",
      "head",
      "marker",
      "schemaVersion",
      "sessionId",
      "skill",
      "status",
    ]) ||
    result.schemaVersion !== 1 ||
    result.marker !== "sandcastle-final-fix-result" ||
    result.status !== "fixed" ||
    !uuidPattern.test(result.auditEventId) ||
    progress.history.some(({ auditEventId }) => auditEventId === result.auditEventId) ||
    result.beforeHead !== progress.batchHead ||
    !gitShaPattern.test(result.head) ||
    result.head === result.beforeHead ||
    !uuidPattern.test(result.sessionId) ||
    used.sessions.has(result.sessionId) ||
    !hasExactShape(result.skill, ["ok", "receiptId"]) ||
    result.skill.ok !== true ||
    typeof result.skill.receiptId !== "string" ||
    !opaqueIdPattern.test(result.skill.receiptId) ||
    used.receipts.has(result.skill.receiptId)
  ) {
    throw infrastructureError(
      "FINAL_FIX_RESULT_INVALID",
      "An automatic final fix returned invalid or mismatched evidence.",
    );
  }
}

export function createFinalReviewProgress(
  input: FinalReviewDispatchInput,
): FinalReviewProgress {
  if (!validDispatchInput(input)) {
    throw infrastructureError(
      "FINAL_REVIEW_INPUT_INVALID",
      "Final review progress requires fixed Batch, base, and PR identities.",
    );
  }
  return {
    ...input,
    automaticFixesUsed: 0,
    branch: `sandcastle/${input.batchId}`,
    history: [],
    pendingFindings: [],
    phase: "review-0",
    schemaVersion: 1,
  };
}

function reviewInput(
  progress: FinalReviewProgress,
): FinalReviewCycleReviewInput {
  const phase = progress.phase as FinalReviewCycleReviewInput["phase"];
  return {
    batchHead: progress.batchHead,
    batchId: progress.batchId,
    mode: phase === "review-only" ? "review-only" : "automatic",
    phase,
    pullRequest: progress.pullRequest,
    targetBase: progress.targetBase,
  };
}

async function executeReview(
  progress: FinalReviewProgress,
  runtime: FinalReviewCycleRuntime,
): Promise<FinalReviewProgress> {
  const input = reviewInput(progress);
  const result = await runtime.runFullReview(input);
  validateReviewResult(result, progress);
  const history: FinalReviewHistoryEvent[] = [
    ...progress.history,
    {
      auditEventId: result.auditEventId,
      axes: result.axes,
      batchHead: result.batchHead,
      findingCodes: result.findings
        .filter(({ actionable }) => actionable)
        .map(({ code }) => code),
      kind: "review",
      outcome: result.status,
      phase: input.phase,
      reviewedHead: result.reviewedHead,
      verificationHash: result.verificationHash,
    },
  ];
  if (result.status === "passed") {
    return {
      ...progress,
      history,
      pendingFindings: [],
      phase: "passed",
    };
  }
  const nextPhase =
    input.phase === "review-0"
      ? "fix-1"
      : input.phase === "review-1"
        ? "fix-2"
        : "needs-human-fix";
  return {
    ...progress,
    history,
    pendingFindings: result.findings.filter(({ actionable }) => actionable),
    phase: nextPhase,
  };
}

async function executeFix(
  progress: FinalReviewProgress,
  runtime: FinalReviewCycleRuntime,
): Promise<FinalReviewProgress> {
  const fixNumber = progress.phase === "fix-1" ? 1 : 2;
  const input: AutomaticFinalFixInput = {
    batchHead: progress.batchHead,
    batchId: progress.batchId,
    findings: progress.pendingFindings,
    fixNumber,
    phase: progress.phase as "fix-1" | "fix-2",
    pullRequest: progress.pullRequest,
    targetBase: progress.targetBase,
  };
  const result = await runtime.runAutomaticFix(input);
  validateFixResult(result, progress);
  return {
    ...progress,
    automaticFixesUsed: fixNumber,
    batchHead: result.head,
    history: [
      ...progress.history,
      {
        auditEventId: result.auditEventId,
        beforeHead: result.beforeHead,
        head: result.head,
        kind: "automatic-fix",
        phase: input.phase,
        receiptId: result.skill.receiptId,
        sessionId: result.sessionId,
      },
    ],
    pendingFindings: [],
    phase: fixNumber === 1 ? "review-1" : "review-2",
  };
}

export async function executeFinalReviewStep(
  progress: FinalReviewProgress,
  runtime: FinalReviewCycleRuntime,
): Promise<FinalReviewProgress> {
  validateProgress(progress);
  if (
    progress.phase === "review-0" ||
    progress.phase === "review-1" ||
    progress.phase === "review-2" ||
    progress.phase === "review-only"
  ) {
    return executeReview(progress, runtime);
  }
  if (progress.phase === "fix-1" || progress.phase === "fix-2") {
    return executeFix(progress, runtime);
  }
  throw infrastructureError(
    "FINAL_REVIEW_PHASE_TERMINAL",
    "This final review phase requires merge, base resolution, or human action.",
  );
}

export async function acceptHumanFinalFix(
  repositoryPath: string,
  progress: FinalReviewProgress,
  input: HumanFinalFixInput,
): Promise<FinalReviewProgress> {
  validateProgress(progress);
  if (
    progress.phase !== "needs-human-fix" &&
    progress.phase !== "needs-base-resolution"
  ) {
    throw infrastructureError(
      "HUMAN_FIX_NOT_ALLOWED",
      "Human final fixes are allowed only from an explicit recovery state.",
    );
  }
  if (
    !hasExactShape(input, ["auditEventId", "beforeHead", "head"]) ||
    !uuidPattern.test(input.auditEventId) ||
    progress.history.some(({ auditEventId }) => auditEventId === input.auditEventId) ||
    input.beforeHead !== progress.batchHead ||
    !gitShaPattern.test(input.head) ||
    input.head === input.beforeHead
  ) {
    throw infrastructureError(
      "HUMAN_FIX_INPUT_INVALID",
      "Human final fix evidence does not match the active Batch state.",
    );
  }

  const [head, branch, status, ancestor] = await Promise.all([
    git(repositoryPath, ["rev-parse", "HEAD"]),
    git(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(repositoryPath, ["status", "--porcelain", "--untracked-files=all"]),
    git(
      repositoryPath,
      ["merge-base", "--is-ancestor", input.beforeHead, input.head],
      true,
    ),
  ]);
  if (
    head.stdout.trim() !== input.head ||
    branch.stdout.trim() !== progress.branch ||
    status.stdout !== "" ||
    ancestor.exitCode !== 0
  ) {
    throw infrastructureError(
      "HUMAN_FIX_HISTORY_INVALID",
      "Human final fixes must be clean linear commits appended to the audited Batch HEAD.",
    );
  }
  await checkProtectedPaths(repositoryPath, input.beforeHead);

  return {
    ...progress,
    batchHead: input.head,
    history: [
      ...progress.history,
      {
        auditEventId: input.auditEventId,
        beforeHead: input.beforeHead,
        head: input.head,
        kind: "human-fix",
      },
    ],
    pendingFindings: [],
    phase: "review-only",
  };
}
