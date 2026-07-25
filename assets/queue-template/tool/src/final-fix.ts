import { withoutExecutionCredentials } from "./credential-environment.js";
import {
  parseFinalFixMarker,
  parseFinalReviewMarker,
  renderFinalFixMarker,
  type FinalFixMarker,
  type FinalReviewMarker,
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

interface FinalizationComment {
  body: string;
  id: number;
}

export interface FinalFixBoundary {
  checkoutIntegration(branch: string, head: string): Promise<void>;
  commitParents(commit: string): Promise<string[]>;
  createFinalFixMarker(
    pullRequest: number,
    marker: FinalFixMarker,
  ): Promise<{ id: number }>;
  dispatchContinuation(payload: {
    inputs: {
      expected_head: string;
      operation: "continue";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void>;
  dispatchFinalRereview(payload: {
    inputs: {
      expected_head: string;
      operation: "final-rereview";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void>;
  isClean(): Promise<boolean>;
  listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]>;
  listIssueComments(issue: number): Promise<FinalizationComment[]>;
  localHead(): Promise<string>;
  pushIntegration(branch: string, before: string, after: string): Promise<void>;
  remoteHead(branch: string): Promise<string | null>;
  runCommand(argv: string[], environment: NodeJS.ProcessEnv): Promise<void>;
}

export interface FinalFixOptions {
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
  repository: string;
}

export type FinalFixResult =
  | { actualHead: string | null; expectedHead: string; status: "stale-final-fix" }
  | { reason: string; status: "conflict" }
  | { reason: "assigned" | "blocked"; status: "waiting" }
  | { status: "processing"; ticket: number }
  | {
      beforeHead: string;
      completionCommit: string;
      markerCommentId: number;
      pullRequest: number;
      sessionId: string;
      status: "final-rereview-dispatched";
    };

type WorkUnitExecutor = (options: WorkUnitOptions) => Promise<WorkUnitResult>;

function conflict(reason: string): FinalFixResult {
  return { reason, status: "conflict" };
}

function finalizationMarkers(comments: FinalizationComment[]): {
  fixes: Array<{ id: number; marker: FinalFixMarker }>;
  reviews: Array<{ id: number; marker: FinalReviewMarker }>;
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
      reviews: comments
        .map(({ body, id }) => ({ id, marker: parseFinalReviewMarker(body) }))
        .filter(
          (value): value is { id: number; marker: FinalReviewMarker } =>
            value.marker !== null,
        ),
    };
  } catch {
    return null;
  }
}

async function runCommands(
  commands: CommandSpec[],
  boundary: FinalFixBoundary,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  for (const { argv } of commands) {
    await boundary.runCommand([...argv], environment);
  }
}

async function leaveFinalization(
  frontier: FrontierResult,
  options: FinalFixOptions,
  boundary: FinalFixBoundary,
  expectedHead: string,
): Promise<FinalFixResult | null> {
  if (frontier.status === "conflict") return frontier;
  if (frontier.status === "ready") {
    await boundary.dispatchContinuation({
      inputs: {
        expected_head: expectedHead,
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

export async function orchestrateFinalFix(
  options: FinalFixOptions,
  boundary: FinalFixBoundary,
  select: () => Promise<FrontierResult>,
  runWorkUnit: WorkUnitExecutor = executeWorkUnit,
): Promise<FinalFixResult> {
  const runId = options.environment.GITHUB_RUN_ID;
  if (
    !objectIdPattern.test(options.expectedHead) ||
    !runIdPattern.test(runId ?? "") ||
    !runIdPattern.test(options.predecessorRunId)
  ) {
    return conflict("invalid-final-fix-binding");
  }
  const actualHead = await boundary.remoteHead(options.integrationBranch);
  if (actualHead !== options.expectedHead) {
    return {
      actualHead,
      expectedHead: options.expectedHead,
      status: "stale-final-fix",
    };
  }
  const stopped = await leaveFinalization(
    await select(),
    options,
    boundary,
    options.expectedHead,
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
    pullRequest.state === "closed"
  ) {
    return conflict("unique-draft-integration-pull-request-required");
  }
  const markers = finalizationMarkers(
    await boundary.listIssueComments(pullRequest.number),
  );
  const authorization = markers?.reviews.filter(
    ({ marker }) =>
      marker.integrationHead === options.expectedHead &&
      marker.runId === options.predecessorRunId &&
      marker.verdict === "needs-fix",
  );
  if (!markers || markers.fixes.length > 0 || authorization?.length !== 1) {
    return conflict("final-fix-authorization-unprovable-or-consumed");
  }

  await boundary.checkoutIntegration(
    options.integrationBranch,
    options.expectedHead,
  );
  const commandEnvironment = withoutExecutionCredentials(options.environment);
  await runCommands(
    options.commands.bootstrap,
    boundary,
    commandEnvironment,
  );
  const workUnit = await runWorkUnit({
    cwd: options.repository,
    environment: options.environment,
    model: options.model,
    promptFile: options.promptFile,
    role: "final-fix",
  });
  await runCommands(options.commands.test, boundary, commandEnvironment);
  await runCommands(
    options.commands.verification,
    boundary,
    commandEnvironment,
  );

  const afterHead = await boundary.localHead();
  const [parents, clean] = await Promise.all([
    boundary.commitParents(afterHead),
    boundary.isClean(),
  ]);
  if (
    !objectIdPattern.test(afterHead) ||
    afterHead === options.expectedHead ||
    workUnit.role !== "final-fix" ||
    workUnit.commits.length !== 1 ||
    workUnit.commits[0] !== afterHead ||
    parents.length !== 1 ||
    parents[0] !== options.expectedHead ||
    !clean
  ) {
    throw new Error(
      "Final Fix must produce one clean commit parented by the reviewed HEAD.",
    );
  }
  if (
    (await boundary.remoteHead(options.integrationBranch)) !==
    options.expectedHead
  ) {
    return conflict("final-fix-head-changed-before-publication");
  }
  await boundary.pushIntegration(
    options.integrationBranch,
    options.expectedHead,
    afterHead,
  );
  if ((await boundary.remoteHead(options.integrationBranch)) !== afterHead) {
    throw new Error("Remote Final Fix HEAD verification failed after push.");
  }

  const marker: FinalFixMarker = {
    afterHead,
    beforeHead: options.expectedHead,
    reviewRunId: options.predecessorRunId,
    runId: runId!,
    schemaVersion: 1,
    sessionId: workUnit.sessionId,
    type: "sandcastle-final-fix",
  };
  await boundary.createFinalFixMarker(pullRequest.number, marker);
  const visibleMarkers = finalizationMarkers(
    await boundary.listIssueComments(pullRequest.number),
  );
  const visible = visibleMarkers?.fixes.filter(
    ({ marker: candidate }) =>
      renderFinalFixMarker(candidate) === renderFinalFixMarker(marker),
  );
  if (!visibleMarkers || visible?.length !== 1) {
    return conflict("final-fix-marker-not-unique-or-visible");
  }

  if ((await boundary.remoteHead(options.integrationBranch)) !== afterHead) {
    return conflict("final-fix-head-changed-after-publication");
  }
  const finalBoundary = await leaveFinalization(
    await select(),
    options,
    boundary,
    afterHead,
  );
  if (finalBoundary) return finalBoundary;
  await boundary.dispatchFinalRereview({
    inputs: {
      expected_head: afterHead,
      operation: "final-rereview",
      predecessor_run_id: runId!,
    },
    ref: options.baseBranch,
  });
  return {
    beforeHead: options.expectedHead,
    completionCommit: afterHead,
    markerCommentId: visible![0]!.id,
    pullRequest: pullRequest.number,
    sessionId: workUnit.sessionId,
    status: "final-rereview-dispatched",
  };
}
