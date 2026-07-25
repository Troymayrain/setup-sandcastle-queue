import type { FrontierResult } from "./frontier.js";
import type { ReconciliationResult } from "./reconciliation.js";

const objectIdPattern = /^[0-9a-f]{40}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;

export type ProcessingOperation = "start" | "continue" | "resume";

export interface QueueOperationOptions {
  baseBranch: string;
  expectedHead?: string;
  integrationBranch: string;
  operation: ProcessingOperation;
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

export interface QueueOperationDependencies {
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

export type QueueOperationResult =
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

function conflict(reason: string): QueueOperationResult {
  return { reason, status: "conflict" };
}

export function queueOperationInputError(
  options: QueueOperationOptions,
): string | null {
  if (!runIdPattern.test(options.runId)) return "invalid-operation-binding";
  if (
    options.predecessorRunId !== undefined &&
    !runIdPattern.test(options.predecessorRunId)
  ) {
    return "invalid-operation-binding";
  }
  if (options.operation === "start") {
    return options.expectedHead === undefined
      ? null
      : "invalid-operation-binding";
  }
  return (
    objectIdPattern.test(options.expectedHead ?? "") &&
    (options.operation !== "continue" ||
      options.predecessorRunId !== undefined)
  )
    ? null
    : "invalid-operation-binding";
}

async function preflight(
  options: QueueOperationOptions,
  boundary: ContinuationBoundary,
): Promise<QueueOperationResult | null> {
  const inputError = queueOperationInputError(options);
  if (inputError) return conflict(inputError);
  const actualHead = await boundary.remoteHead(options.integrationBranch);
  if (options.operation === "start") {
    return actualHead === null
      ? null
      : conflict("manual-start-requires-absent-integration-branch");
  }
  if (actualHead === options.expectedHead) return null;
  if (options.operation === "continue") {
    return {
      actualHead,
      expectedHead: options.expectedHead!,
      status: "stale-continuation",
    };
  }
  return conflict("stale-manual-operation");
}

async function continueAfterProgress(
  options: QueueOperationOptions,
  boundary: ContinuationBoundary,
  dependencies: QueueOperationDependencies,
  progress: {
    head: string;
    source: "publication" | "reconciliation";
    ticket: number;
  },
): Promise<QueueOperationResult> {
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

export async function runQueueOperation(
  options: QueueOperationOptions,
  boundary: ContinuationBoundary,
  dependencies: QueueOperationDependencies,
): Promise<QueueOperationResult> {
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
