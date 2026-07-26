import { withoutExecutionCredentials } from "./credential-environment.js";
import {
  renderFinalRereviewMarker,
  type FinalFixMarker,
  type FinalRereviewMarker,
} from "./final-review-facts.js";
import {
  leaveFinalization,
  runCommandGroups,
  scanFinalizationMarkers,
  type FinalizationComment,
} from "./finalization.js";
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
  includes(commit: string): Promise<boolean>;
  remove(): Promise<void>;
  unchanged(): Promise<boolean>;
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
    {
      baseBranch: options.baseBranch,
      expectedHead: options.expectedHead,
      runId: runId!,
    },
    (payload) => boundary.dispatchContinuation(payload),
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
  const existing = scanFinalizationMarkers(
    await boundary.listIssueComments(pullRequest.number),
  );
  if (
    !existing ||
    existing.rereviews.length > 0 ||
    existing.fixes.length !== 1
  ) {
    return conflict("final-rereview-authorization-unprovable-or-consumed");
  }
  const fixMarker = existing.fixes[0]!.marker;
  if (
    fixMarker.afterHead === options.expectedHead &&
    fixMarker.runId !== options.predecessorRunId
  ) {
    return conflict("final-rereview-authorization-unprovable-or-consumed");
  }

  const temporary = await boundary.createTemporaryMerge({
    baseBranch: options.baseBranch,
    expectedIntegrationHead: options.expectedHead,
    integrationBranch: options.integrationBranch,
  });
  let workUnit: WorkUnitResult;
  let includesFix = false;
  let unchanged = false;
  try {
    includesFix = await temporary.includes(fixMarker.afterHead);
    await runCommandGroups(
      [
        options.commands.bootstrap,
        options.commands.test,
        options.commands.verification,
      ],
      (argv) =>
        boundary.runCommand(
          temporary.path,
          argv,
          withoutExecutionCredentials(options.environment),
        ),
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
    !includesFix ||
    workUnit.sessionId === fixMarker.sessionId ||
    workUnit.commits.length !== 0 ||
    !Array.isArray(workUnit.findings) ||
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
    {
      baseBranch: options.baseBranch,
      expectedHead: options.expectedHead,
      runId: runId!,
    },
    (payload) => boundary.dispatchContinuation(payload),
  );
  if (finalBoundary) return finalBoundary;

  const marker: FinalRereviewMarker = {
    baseHead: temporary.baseHead,
    findings: workUnit.findings,
    fixRunId: fixMarker.runId,
    integrationHead: options.expectedHead,
    runId: runId!,
    schemaVersion: 2,
    type: "sandcastle-final-rereview",
    verdict: workUnit.verdict,
  };
  renderFinalRereviewMarker(marker);
  await boundary.createFinalRereviewMarker(pullRequest.number, marker);
  const visibleMarkers = scanFinalizationMarkers(
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
