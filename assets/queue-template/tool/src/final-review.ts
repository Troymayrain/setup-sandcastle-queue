import { withoutExecutionCredentials } from "./credential-environment.js";
import type { FrontierResult } from "./frontier.js";
import {
  parseFinalReviewMarker,
  renderFinalReviewMarker,
  type FinalReviewMarker,
} from "./final-review-facts.js";
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

interface FinalReviewComment {
  body: string;
  id: number;
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
  listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]>;
  listIssueComments(issue: number): Promise<FinalReviewComment[]>;
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
      status: "needs-fix" | "ready-for-human-review";
      verdict: "needs-fix" | "pass";
    };

type WorkUnitExecutor = (options: WorkUnitOptions) => Promise<WorkUnitResult>;

function conflict(reason: string): FirstFinalReviewResult {
  return { reason, status: "conflict" };
}

async function leaveFinalizationForFrontier(
  frontier: FrontierResult,
  options: FirstFinalReviewOptions,
  boundary: FinalReviewBoundary,
): Promise<FirstFinalReviewResult | null> {
  if (frontier.status === "conflict") return frontier;
  if (frontier.status === "ready") {
    await boundary.dispatchContinuation({
      inputs: {
        expected_head: options.expectedHead,
        operation: "continue",
        predecessor_run_id: options.environment.GITHUB_RUN_ID!,
      },
      ref: options.baseBranch,
    });
    return { status: "processing", ticket: frontier.ticket };
  }
  return frontier.reason === "empty"
    ? null
    : { reason: frontier.reason, status: "waiting" };
}

function inspectFinalReviewMarker(
  comments: FinalReviewComment[],
  expected: FinalReviewMarker,
):
  | { status: "conflict" }
  | { status: "none" }
  | { id: number; status: "exact" } {
  if (
    comments.some(
      ({ body, id }) =>
        typeof body !== "string" || !Number.isSafeInteger(id) || id <= 0,
    ) ||
    new Set(comments.map(({ id }) => id)).size !== comments.length
  ) {
    return { status: "conflict" };
  }
  let markers: Array<{ id: number; marker: FinalReviewMarker }>;
  try {
    markers = comments
      .map(({ body, id }) => ({ id, marker: parseFinalReviewMarker(body) }))
      .filter(
        (value): value is { id: number; marker: FinalReviewMarker } =>
          value.marker !== null,
      );
  } catch {
    return { status: "conflict" };
  }
  if (markers.length === 0) return { status: "none" };
  return markers.length === 1 &&
    renderFinalReviewMarker(markers[0]!.marker) ===
      renderFinalReviewMarker(expected)
    ? { id: markers[0]!.id, status: "exact" }
    : { status: "conflict" };
}

async function runCommands(
  groups: CommandSpec[][],
  path: string,
  boundary: FinalReviewBoundary,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  for (const commands of groups) {
    for (const { argv } of commands) {
      await boundary.runCommand(path, [...argv], environment);
    }
  }
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
  const stopped = await leaveFinalizationForFrontier(
    await select(),
    options,
    boundary,
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
    await runCommands(
      [
        options.commands.bootstrap,
        options.commands.test,
        options.commands.verification,
      ],
      temporary.path,
      boundary,
      withoutExecutionCredentials(options.environment),
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
  const finalBoundary = await leaveFinalizationForFrontier(
    await select(),
    options,
    boundary,
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
    integrationHead: options.expectedHead,
    runId: runId!,
    schemaVersion: 1,
    type: "sandcastle-final-review",
    verdict: review.verdict,
  };
  let visibleMarker = inspectFinalReviewMarker(
    await boundary.listIssueComments(pullRequest.number),
    marker,
  );
  if (visibleMarker.status === "none") {
    await boundary.createFinalReviewMarker(pullRequest.number, marker);
    visibleMarker = inspectFinalReviewMarker(
      await boundary.listIssueComments(pullRequest.number),
      marker,
    );
  }
  if (visibleMarker.status !== "exact") {
    return conflict("final-review-marker-not-unique-or-visible");
  }
  if (review.verdict === "pass") {
    await boundary.markPullRequestReady(pullRequest.nodeId);
  }
  return {
    baseHead: temporary.baseHead,
    integrationHead: options.expectedHead,
    markerCommentId: visibleMarker.id,
    pullRequest: pullRequest.number,
    sessionId: review.sessionId,
    status:
      review.verdict === "pass" ? "ready-for-human-review" : "needs-fix",
    verdict: review.verdict,
  };
}
