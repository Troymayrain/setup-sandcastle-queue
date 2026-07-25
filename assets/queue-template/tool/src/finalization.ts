import {
  parseFinalFixMarker,
  parseFinalRereviewMarker,
  parseFinalReviewMarker,
  type FinalFixMarker,
  type FinalRereviewMarker,
  type FinalReviewMarker,
} from "./final-review-facts.js";
import type { FrontierResult } from "./frontier.js";
import type { IntegrationPullRequest } from "./integration-pull-request.js";
import type { CommandSpec } from "./processing-run.js";

export interface FinalizationComment {
  body: string;
  id: number;
}

export interface FinalizationMarkers {
  fixes: Array<{ id: number; marker: FinalFixMarker }>;
  rereviews: Array<{ id: number; marker: FinalRereviewMarker }>;
  reviews: Array<{ id: number; marker: FinalReviewMarker }>;
}

export function scanFinalizationMarkers(
  comments: FinalizationComment[],
): FinalizationMarkers | null {
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

export type FinalizationExit =
  | { reason: string; status: "conflict" }
  | { reason: "assigned" | "blocked"; status: "waiting" }
  | { status: "processing"; ticket: number };

export async function leaveFinalization(
  frontier: FrontierResult,
  input: { baseBranch: string; expectedHead: string; runId: string },
  dispatchContinuation: (payload: {
    inputs: {
      expected_head: string;
      operation: "continue";
      predecessor_run_id: string;
    };
    ref: string;
  }) => Promise<void>,
): Promise<FinalizationExit | null> {
  if (frontier.status === "conflict") return frontier;
  if (frontier.status === "ready") {
    await dispatchContinuation({
      inputs: {
        expected_head: input.expectedHead,
        operation: "continue",
        predecessor_run_id: input.runId,
      },
      ref: input.baseBranch,
    });
    return { status: "processing", ticket: frontier.ticket };
  }
  return frontier.reason === "empty"
    ? null
    : { reason: frontier.reason, status: "waiting" };
}

export async function runCommandGroups(
  groups: CommandSpec[][],
  run: (argv: string[]) => Promise<void>,
): Promise<void> {
  for (const commands of groups) {
    for (const { argv } of commands) {
      await run([...argv]);
    }
  }
}

export interface FinalOperationBoundary {
  listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]>;
  listIssueComments(issue: number): Promise<FinalizationComment[]>;
}

export type NextFinalOperation =
  | { operation: "final-rereview" | "final-review"; status: "ready" }
  | { reason: string; status: "conflict" };

export async function nextFinalOperation(
  branches: { baseBranch: string; integrationBranch: string },
  boundary: FinalOperationBoundary,
): Promise<NextFinalOperation> {
  const pullRequests = await boundary.listIntegrationPullRequests({
    base: branches.baseBranch,
    head: branches.integrationBranch,
  });
  const pullRequest = pullRequests[0];
  if (
    pullRequests.length !== 1 ||
    !pullRequest ||
    pullRequest.state === "closed"
  ) {
    return {
      reason: "unique-integration-pull-request-required",
      status: "conflict",
    };
  }
  const markers = scanFinalizationMarkers(
    await boundary.listIssueComments(pullRequest.number),
  );
  if (!markers || markers.fixes.length > 1 || markers.rereviews.length > 0) {
    return { reason: "final-operation-unprovable", status: "conflict" };
  }
  return {
    operation:
      markers.fixes.length === 1 ? "final-rereview" : "final-review",
    status: "ready",
  };
}
