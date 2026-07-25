import type { FrontierResult } from "./frontier.js";
import type { ReconciliationResult } from "./reconciliation.js";

const objectIdPattern = /^[0-9a-f]{40}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;

export type ProcessingRunOperation = "start" | "continue" | "resume";

export interface ProcessingRunInvocation {
  baseBranch: string;
  expectedHead?: string;
  integrationBranch: string;
  operation: ProcessingRunOperation;
  predecessorRunId?: string;
  runId: string;
}

export interface ContinuationBoundary {
  dispatchContinuation(payload: {
    inputs: {
      expected_head: string;
      operation: "continue";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void>;
  remoteHead(branch: string): Promise<string | null>;
}

export interface ProcessingRunDependencies {
  process(ticket: {
    body: string;
    number: number;
  }): Promise<{
    completionCommit: string;
    status: string;
    ticket: number;
  }>;
  reconcile(): Promise<ReconciliationResult>;
  select(activate: boolean): Promise<FrontierResult>;
}

export type WorkflowHostResult =
  | {
      actualHead: string | null;
      expectedHead: string;
      status: "stale-continuation";
    }
  | { reason: string; status: "conflict" }
  | FrontierResult
  | {
      head: string;
      source: "publication" | "reconciliation";
      status: "continued";
      ticket: number;
    }
  | {
      head: string;
      reason: "assigned" | "blocked" | "empty";
      source: "publication" | "reconciliation";
      status: "waiting";
      ticket: number;
    };

function conflict(reason: string): WorkflowHostResult {
  return { reason, status: "conflict" };
}

const operationPolicies: Record<
  ProcessingRunOperation,
  {
    automatic: boolean;
    expectedHead: "forbidden" | "required";
    predecessorRunId: "optional" | "required";
  }
> = {
  continue: {
    automatic: true,
    expectedHead: "required",
    predecessorRunId: "required",
  },
  resume: {
    automatic: false,
    expectedHead: "required",
    predecessorRunId: "optional",
  },
  start: {
    automatic: false,
    expectedHead: "forbidden",
    predecessorRunId: "optional",
  },
};

export function processingRunInputError(
  options: ProcessingRunInvocation,
): string | null {
  const policy = operationPolicies[options.operation];
  if (!runIdPattern.test(options.runId)) return "invalid-operation-binding";
  if (
    options.predecessorRunId !== undefined &&
    !runIdPattern.test(options.predecessorRunId)
  ) {
    return "invalid-operation-binding";
  }
  return (
    (policy.expectedHead === "forbidden"
      ? options.expectedHead === undefined
      : objectIdPattern.test(options.expectedHead ?? "")) &&
    (policy.predecessorRunId === "optional" ||
      options.predecessorRunId !== undefined)
  )
    ? null
    : "invalid-operation-binding";
}

async function preflight(
  options: ProcessingRunInvocation,
  boundary: ContinuationBoundary,
): Promise<WorkflowHostResult | null> {
  const inputError = processingRunInputError(options);
  if (inputError) return conflict(inputError);
  const policy = operationPolicies[options.operation];
  const actualHead = await boundary.remoteHead(options.integrationBranch);
  if (policy.expectedHead === "forbidden") {
    return actualHead === null
      ? null
      : conflict("manual-start-requires-absent-integration-branch");
  }
  if (actualHead === options.expectedHead) return null;
  if (policy.automatic) {
    return {
      actualHead,
      expectedHead: options.expectedHead!,
      status: "stale-continuation",
    };
  }
  return conflict("stale-manual-operation");
}

async function continueAfterProgress(
  options: ProcessingRunInvocation,
  boundary: ContinuationBoundary,
  dependencies: ProcessingRunDependencies,
  progress: {
    head: string;
    source: "publication" | "reconciliation";
    ticket: number;
  },
): Promise<WorkflowHostResult> {
  if (!objectIdPattern.test(progress.head)) {
    return conflict("progress-head-invalid");
  }
  const frontier = await dependencies.select(false);
  if (frontier.status === "conflict") return frontier;
  if (frontier.status === "waiting") {
    return {
      head: progress.head,
      reason: frontier.reason,
      source: progress.source,
      status: "waiting",
      ticket: progress.ticket,
    };
  }
  await boundary.dispatchContinuation({
    inputs: {
      expected_head: progress.head,
      operation: "continue",
      predecessor_run_id: options.runId,
    },
    ref: options.baseBranch,
  });
  return {
    head: progress.head,
    source: progress.source,
    status: "continued",
    ticket: progress.ticket,
  };
}

export async function orchestrateProcessingRun(
  options: ProcessingRunInvocation,
  boundary: ContinuationBoundary,
  dependencies: ProcessingRunDependencies,
): Promise<WorkflowHostResult> {
  const stopped = await preflight(options, boundary);
  if (stopped) return stopped;

  const reconciliation = await dependencies.reconcile();
  if (reconciliation.status === "conflict") return reconciliation;
  if (reconciliation.status === "reconciled") {
    return continueAfterProgress(options, boundary, dependencies, {
      head: reconciliation.head,
      source: "reconciliation",
      ticket: reconciliation.ticket,
    });
  }

  const frontier = await dependencies.select(options.operation === "start");
  if (frontier.status !== "ready") return frontier;
  const publication = await dependencies.process({
    body: frontier.body,
    number: frontier.ticket,
  });
  if (
    publication.status !== "published" ||
    publication.ticket !== frontier.ticket ||
    !objectIdPattern.test(publication.completionCommit)
  ) {
    return conflict("publication-progress-unprovable");
  }
  return continueAfterProgress(options, boundary, dependencies, {
    head: publication.completionCommit,
    source: "publication",
    ticket: publication.ticket,
  });
}
