import { withoutExecutionCredentials } from "./credential-environment.js";
import type { FrontierResult } from "./frontier.js";
import {
  renderFinalReviewMarker,
  type FinalReviewMarker,
} from "./final-review-facts.js";
import {
  leaveFinalization,
  runCommandGroups,
  scanFinalizationMarkers,
  type FinalizationComment,
} from "./finalization.js";
import type { IntegrationPullRequest } from "./integration-pull-request.js";
import type { CommandSpec } from "./processing-run.js";
import {
  executeWorkUnit,
  type WorkUnitOptions,
  type WorkUnitResult,
} from "./work-unit.js";

const objectIdPattern = /^[0-9a-f]{40}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;

interface TemporaryMerge {
  baseHead: string;
  integrationHead: string;
  path: string;
  remove(): Promise<void>;
  unchanged(): Promise<boolean>;
}

export interface FinalReviewBoundary {
  createFinalReviewMarker(
    pullRequest: number,
    marker: FinalReviewMarker,
  ): Promise<{ id: number }>;
  createTemporaryMerge(input: {
    baseBranch: string;
    expectedIntegrationHead: string;
    integrationBranch: string;
  }): Promise<TemporaryMerge>;
  dispatchContinuation(payload: {
    inputs: {
      expected_head: string;
      operation: "continue";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void>;
  dispatchFinalFix(payload: {
    inputs: {
      expected_head: string;
      operation: "final-fix";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void>;
  listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]>;
  listIssueComments(issue: number): Promise<FinalizationComment[]>;
  markPullRequestReady(nodeId: string): Promise<void>;
  remoteHead(branch: string): Promise<string | null>;
  runCommand(
    path: string,
    argv: string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<void>;
}

export interface FirstFinalReviewOptions {
  baseBranch: string;
  commands: {
    bootstrap: CommandSpec[];
    test: CommandSpec[];
    verification: CommandSpec[];
  };
  environment: NodeJS.ProcessEnv;
  expectedHead: string;
  integrationBranch: string;
  model: string;
  predecessorRunId: string;
  promptFile: string;
}

export type FirstFinalReviewResult =
  | {
      actualHead: string | null;
      expectedHead: string;
      status: "stale-final-review";
    }
  | { reason: string; status: "conflict" }
  | { reason: "assigned" | "blocked"; status: "waiting" }
  | { status: "processing"; ticket: number }
  | {
      baseHead: string;
      integrationHead: string;
      markerCommentId: number;
      pullRequest: number;
      sessionId: string;
      status:
        | "final-fix-dispatched"
        | "needs-human-review"
        | "ready-for-human-review";
      verdict: "needs-fix" | "pass";
    };

type WorkUnitExecutor = (options: WorkUnitOptions) => Promise<WorkUnitResult>;

function conflict(reason: string): FirstFinalReviewResult {
  return { reason, status: "conflict" };
}

function inspectFinalReviewMarker(
  comments: FinalizationComment[],
  expected: FinalReviewMarker,
):
  | { status: "conflict" }
  | { status: "none" }
  | { id: number; status: "exact" } {
  const scanned = scanFinalizationMarkers(comments);
  if (!scanned) return { status: "conflict" };
  const markers = scanned.reviews;
  if (markers.length === 0) return { status: "none" };
  const exact = markers.filter(
    ({ marker }) =>
      renderFinalReviewMarker(marker) === renderFinalReviewMarker(expected),
  );
  if (exact.length === 1) {
    return { id: exact[0]!.id, status: "exact" };
  }
  if (exact.length > 1) return { status: "conflict" };
  return markers.some(
    ({ marker }) =>
      marker.integrationHead === expected.integrationHead ||
      marker.runId === expected.runId,
  )
    ? { status: "conflict" }
    : { status: "none" };
}

export async function orchestrateFirstFinalReview(
  options: FirstFinalReviewOptions,
  boundary: FinalReviewBoundary,
  select: () => Promise<FrontierResult>,
  runWorkUnit: WorkUnitExecutor = executeWorkUnit,
): Promise<FirstFinalReviewResult> {
  const runId = options.environment.GITHUB_RUN_ID;
  if (
    !objectIdPattern.test(options.expectedHead) ||
    !runIdPattern.test(runId ?? "") ||
    !runIdPattern.test(options.predecessorRunId)
  ) {
    return conflict("invalid-final-review-binding");
  }

  const actualHead = await boundary.remoteHead(options.integrationBranch);
  if (actualHead !== options.expectedHead) {
    return {
      actualHead,
      expectedHead: options.expectedHead,
      status: "stale-final-review",
    };
  }
  const stopped = await leaveFinalization(
    await select(),
    {
      baseBranch: options.baseBranch,
      expectedHead: options.expectedHead,
      runId: runId!,
    },
    (payload) => boundary.dispatchContinuation(payload),
  );
  if (stopped) return stopped;

  const temporary = await boundary.createTemporaryMerge({
    baseBranch: options.baseBranch,
    expectedIntegrationHead: options.expectedHead,
    integrationBranch: options.integrationBranch,
  });
  let review: WorkUnitResult;
  let temporaryUnchanged = false;
  try {
    const commandEnvironment = withoutExecutionCredentials(options.environment);
    await runCommandGroups(
      [
        options.commands.bootstrap,
        options.commands.test,
        options.commands.verification,
      ],
      (argv) =>
        boundary.runCommand(temporary.path, argv, commandEnvironment),
    );
    review = await runWorkUnit({
      cwd: temporary.path,
      environment: options.environment,
      model: options.model,
      promptFile: options.promptFile,
      role: "final-review",
    });
    temporaryUnchanged = await temporary.unchanged();
  } finally {
    await temporary.remove();
  }
  if (
    temporary.integrationHead !== options.expectedHead ||
    !objectIdPattern.test(temporary.baseHead) ||
    review.role !== "final-review" ||
    review.commits.length !== 0 ||
    !Array.isArray(review.findings) ||
    !temporaryUnchanged ||
    (review.verdict !== "pass" && review.verdict !== "needs-fix")
  ) {
    throw new Error("Final Review did not produce a read-only exact verdict.");
  }

  const [visibleIntegrationHead, visibleBaseHead] = await Promise.all([
    boundary.remoteHead(options.integrationBranch),
    boundary.remoteHead(options.baseBranch),
  ]);
  if (
    visibleIntegrationHead !== options.expectedHead ||
    visibleBaseHead !== temporary.baseHead
  ) {
    return conflict("final-review-head-changed");
  }
  const finalBoundary = await leaveFinalization(
    await select(),
    {
      baseBranch: options.baseBranch,
      expectedHead: options.expectedHead,
      runId: runId!,
    },
    (payload) => boundary.dispatchContinuation(payload),
  );
  if (finalBoundary) return finalBoundary;

  const pullRequests = await boundary.listIntegrationPullRequests({
    base: options.baseBranch,
    head: options.integrationBranch,
  });
  const pullRequest = pullRequests[0];
  if (
    pullRequests.length !== 1 ||
    !pullRequest ||
    pullRequest.draft !== true ||
    pullRequest.state === "closed" ||
    typeof pullRequest.nodeId !== "string" ||
    pullRequest.nodeId.length === 0
  ) {
    return conflict("unique-draft-integration-pull-request-required");
  }
  const marker: FinalReviewMarker = {
    baseHead: temporary.baseHead,
    findings: review.findings,
    integrationHead: options.expectedHead,
    runId: runId!,
    schemaVersion: 2,
    type: "sandcastle-final-review",
    verdict: review.verdict,
  };
  renderFinalReviewMarker(marker);
  let visibleComments = await boundary.listIssueComments(pullRequest.number);
  let visibleMarker = inspectFinalReviewMarker(visibleComments, marker);
  if (visibleMarker.status === "none") {
    await boundary.createFinalReviewMarker(pullRequest.number, marker);
    visibleComments = await boundary.listIssueComments(pullRequest.number);
    visibleMarker = inspectFinalReviewMarker(visibleComments, marker);
  }
  if (visibleMarker.status !== "exact") {
    return conflict("final-review-marker-not-unique-or-visible");
  }
  let priorFix = false;
  if (review.verdict === "pass") {
    await boundary.markPullRequestReady(pullRequest.nodeId);
  } else {
    const history = scanFinalizationMarkers(visibleComments);
    if (!history) {
      return conflict("final-fix-history-unprovable");
    }
    priorFix = history.fixes.length > 0;
    if (!priorFix) {
      await boundary.dispatchFinalFix({
        inputs: {
          expected_head: options.expectedHead,
          operation: "final-fix",
          predecessor_run_id: runId!,
        },
        ref: options.baseBranch,
      });
    }
  }
  return {
    baseHead: temporary.baseHead,
    integrationHead: options.expectedHead,
    markerCommentId: visibleMarker.id,
    pullRequest: pullRequest.number,
    sessionId: review.sessionId,
    status:
      review.verdict === "pass"
        ? "ready-for-human-review"
        : priorFix
          ? "needs-human-review"
          : "final-fix-dispatched",
    verdict: review.verdict,
  };
}
