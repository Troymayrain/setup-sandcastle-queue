import { withoutExecutionCredentials } from "./credential-environment.js";
import {
  parseFinalFixMarker,
  parseFinalRereviewMarker,
  renderFinalRereviewMarker,
  type FinalFixMarker,
  type FinalRereviewMarker,
} from "./final-review-facts.js";
import type { FrontierResult } from "./frontier.js";
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

interface FinalizationComment {
  body: string;
  id: number;
}

export interface FinalRereviewBoundary {
  createFinalRereviewMarker(
    pullRequest: number,
    marker: FinalRereviewMarker,
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
  listIssueComments(issue: number): Promise<FinalizationComment[]>;
  markPullRequestReady(nodeId: string): Promise<void>;
  remoteHead(branch: string): Promise<string | null>;
  runCommand(
    path: string,
    argv: string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<void>;
}

export interface FinalRereviewOptions {
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

export type FinalRereviewResult =
  | {
      actualHead: string | null;
      expectedHead: string;
      status: "stale-final-rereview";
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
      status: "needs-human-review" | "ready-for-human-review";
      verdict: "needs-fix" | "pass";
    };

type WorkUnitExecutor = (options: WorkUnitOptions) => Promise<WorkUnitResult>;

function conflict(reason: string): FinalRereviewResult {
  return { reason, status: "conflict" };
}

function markersFrom(comments: FinalizationComment[]): {
  fixes: Array<{ id: number; marker: FinalFixMarker }>;
  rereviews: Array<{ id: number; marker: FinalRereviewMarker }>;
} | null {
  if (
    comments.some(
      ({ body, id }) =>
        typeof body !== "string" || !Number.isSafeInteger(id) || id <= 0,
    ) ||
    new Set(comments.map(({ id }) => id)).size !== comments.length
  ) {
    return null;
  }
  try {
    return {
      fixes: comments
        .map(({ body, id }) => ({ id, marker: parseFinalFixMarker(body) }))
        .filter(
          (value): value is { id: number; marker: FinalFixMarker } =>
            value.marker !== null,
        ),
      rereviews: comments
        .map(({ body, id }) => ({
          id,
          marker: parseFinalRereviewMarker(body),
        }))
        .filter(
          (value): value is { id: number; marker: FinalRereviewMarker } =>
            value.marker !== null,
        ),
    };
  } catch {
    return null;
  }
}

async function leaveFinalization(
  frontier: FrontierResult,
  options: FinalRereviewOptions,
  boundary: FinalRereviewBoundary,
): Promise<FinalRereviewResult | null> {
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

async function runCommands(
  groups: CommandSpec[][],
  path: string,
  boundary: FinalRereviewBoundary,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  for (const commands of groups) {
    for (const { argv } of commands) {
      await boundary.runCommand(path, [...argv], environment);
    }
  }
}

export async function orchestrateFinalRereview(
  options: FinalRereviewOptions,
  boundary: FinalRereviewBoundary,
  select: () => Promise<FrontierResult>,
  runWorkUnit: WorkUnitExecutor = executeWorkUnit,
): Promise<FinalRereviewResult> {
  const runId = options.environment.GITHUB_RUN_ID;
  if (
    !objectIdPattern.test(options.expectedHead) ||
    !runIdPattern.test(runId ?? "") ||
    !runIdPattern.test(options.predecessorRunId)
  ) {
    return conflict("invalid-final-rereview-binding");
  }
  const actualHead = await boundary.remoteHead(options.integrationBranch);
  if (actualHead !== options.expectedHead) {
    return {
      actualHead,
      expectedHead: options.expectedHead,
      status: "stale-final-rereview",
    };
  }
  const stopped = await leaveFinalization(
    await select(),
    options,
    boundary,
  );
  if (stopped) return stopped;

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
  const existing = markersFrom(
    await boundary.listIssueComments(pullRequest.number),
  );
  const authorization = existing?.fixes.filter(
    ({ marker }) =>
      marker.afterHead === options.expectedHead &&
      marker.runId === options.predecessorRunId,
  );
  if (!existing || existing.rereviews.length > 0 || authorization?.length !== 1) {
    return conflict("final-rereview-authorization-unprovable-or-consumed");
  }
  const fixMarker = authorization[0]!.marker;

  const temporary = await boundary.createTemporaryMerge({
    baseBranch: options.baseBranch,
    expectedIntegrationHead: options.expectedHead,
    integrationBranch: options.integrationBranch,
  });
  let workUnit: WorkUnitResult;
  let unchanged = false;
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
    workUnit = await runWorkUnit({
      cwd: temporary.path,
      environment: options.environment,
      model: options.model,
      promptFile: options.promptFile,
      role: "final-rereview",
    });
    unchanged = await temporary.unchanged();
  } finally {
    await temporary.remove();
  }
  if (
    temporary.integrationHead !== options.expectedHead ||
    !objectIdPattern.test(temporary.baseHead) ||
    workUnit.role !== "final-rereview" ||
    workUnit.sessionId === fixMarker.sessionId ||
    workUnit.commits.length !== 0 ||
    !unchanged ||
    (workUnit.verdict !== "pass" && workUnit.verdict !== "needs-fix")
  ) {
    throw new Error(
      "Final Rereview must be an independent read-only exact verdict.",
    );
  }

  const [visibleIntegrationHead, visibleBaseHead] = await Promise.all([
    boundary.remoteHead(options.integrationBranch),
    boundary.remoteHead(options.baseBranch),
  ]);
  if (
    visibleIntegrationHead !== options.expectedHead ||
    visibleBaseHead !== temporary.baseHead
  ) {
    return conflict("final-rereview-head-changed");
  }
  const finalBoundary = await leaveFinalization(
    await select(),
    options,
    boundary,
  );
  if (finalBoundary) return finalBoundary;

  const marker: FinalRereviewMarker = {
    baseHead: temporary.baseHead,
    fixRunId: options.predecessorRunId,
    integrationHead: options.expectedHead,
    runId: runId!,
    schemaVersion: 1,
    type: "sandcastle-final-rereview",
    verdict: workUnit.verdict,
  };
  await boundary.createFinalRereviewMarker(pullRequest.number, marker);
  const visibleMarkers = markersFrom(
    await boundary.listIssueComments(pullRequest.number),
  );
  const visible = visibleMarkers?.rereviews.filter(
    ({ marker: candidate }) =>
      renderFinalRereviewMarker(candidate) ===
      renderFinalRereviewMarker(marker),
  );
  if (!visibleMarkers || visible?.length !== 1) {
    return conflict("final-rereview-marker-not-unique-or-visible");
  }
  if (workUnit.verdict === "pass") {
    await boundary.markPullRequestReady(pullRequest.nodeId);
  }
  return {
    baseHead: temporary.baseHead,
    integrationHead: options.expectedHead,
    markerCommentId: visible![0]!.id,
    pullRequest: pullRequest.number,
    sessionId: workUnit.sessionId,
    status:
      workUnit.verdict === "pass"
        ? "ready-for-human-review"
        : "needs-human-review",
    verdict: workUnit.verdict,
  };
}
