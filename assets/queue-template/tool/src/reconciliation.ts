import {
  parseCompletionMetadata,
  parsePublicationMarker,
  renderPublicationMarker,
  type PublicationMarker,
} from "./publication-facts.js";
import type {
  DraftPullRequest,
  IntegrationPullRequest,
} from "./processing-run.js";

export { renderPublicationMarker } from "./publication-facts.js";

interface RemoteCommit {
  message: string;
  parents: string[];
  sha: string;
}

interface RemoteIssue {
  number: number;
  state?: string;
}

interface IssueComment {
  body: string;
  id: number;
}

export interface ReconciliationBoundary {
  closeIssue(issue: number): Promise<void>;
  createDraftPullRequest(input: {
    base: string;
    head: string;
    title: string;
  }): Promise<DraftPullRequest>;
  createPublicationMarker(
    issue: number,
    marker: PublicationMarker,
  ): Promise<{ id: number }>;
  getCommit(sha: string): Promise<RemoteCommit>;
  getIssue(issue: number): Promise<RemoteIssue>;
  listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]>;
  listIssueComments(issue: number): Promise<IssueComment[]>;
  remoteHead(branch: string): Promise<string | null>;
}

export interface ReconciliationOptions {
  baseBranch: string;
  integrationBranch: string;
}

export type ReconciliationResult =
  | { status: "none" }
  | { head: string; status: "complete"; ticket: number }
  | { head: string; status: "reconciled"; ticket: number }
  | { reason: string; status: "conflict" };

function conflict(reason: string): ReconciliationResult {
  return { reason, status: "conflict" };
}

function equalMarker(
  left: PublicationMarker,
  right: PublicationMarker,
): boolean {
  return renderPublicationMarker(left) === renderPublicationMarker(right);
}

function markersFrom(comments: IssueComment[]): PublicationMarker[] | null {
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
    return comments
      .map(({ body }) => parsePublicationMarker(body))
      .filter((value): value is PublicationMarker => value !== null);
  } catch {
    return null;
  }
}

async function ensureDraftPullRequest(
  options: ReconciliationOptions,
  boundary: ReconciliationBoundary,
): Promise<boolean> {
  const input = {
    base: options.baseBranch,
    head: options.integrationBranch,
  };
  const existing = await boundary.listIntegrationPullRequests(input);
  if (existing.length > 1) return false;
  if (existing[0]) {
    return existing[0].draft === true && existing[0].state !== "closed";
  }
  const created = await boundary.createDraftPullRequest({
    ...input,
    title: "Sandcastle Queue integration",
  });
  return created.draft === true;
}

export async function reconcilePublication(
  options: ReconciliationOptions,
  boundary: ReconciliationBoundary,
): Promise<ReconciliationResult> {
  const [baseHead, integrationHead] = await Promise.all([
    boundary.remoteHead(options.baseBranch),
    boundary.remoteHead(options.integrationBranch),
  ]);
  if (!baseHead) return conflict("missing-base-head");
  if (!integrationHead) return { status: "none" };
  if (baseHead === integrationHead) return { status: "none" };

  const commit = await boundary.getCommit(integrationHead);
  const metadata = parseCompletionMetadata(commit.message);
  if (
    commit.sha !== integrationHead ||
    commit.parents.length !== 1 ||
    !metadata ||
    metadata.beforeHead !== commit.parents[0]
  ) {
    return conflict("unprovable-completion-commit");
  }

  const [issue, comments] = await Promise.all([
    boundary.getIssue(metadata.issue),
    boundary.listIssueComments(metadata.issue),
  ]);
  if (
    issue.number !== metadata.issue ||
    (issue.state !== "open" && issue.state !== "closed")
  ) {
    return conflict("contradictory-ticket");
  }
  const markers = markersFrom(comments);
  if (markers === null || markers.length > 1) {
    return conflict("ambiguous-publication-marker");
  }
  const expected: PublicationMarker = {
    afterHead: integrationHead,
    beforeHead: metadata.beforeHead,
    integrationBranch: options.integrationBranch,
    issue: metadata.issue,
    runId: metadata.runId,
    schemaVersion: 1,
    sessionId: metadata.sessionId,
    type: "sandcastle-ticket-publication",
  };

  if (markers[0]) {
    if (!equalMarker(markers[0], expected)) {
      return conflict("contradictory-publication-marker");
    }
    if (issue.state === "closed") {
      return { head: integrationHead, status: "complete", ticket: metadata.issue };
    }
    await boundary.closeIssue(metadata.issue);
    return { head: integrationHead, status: "reconciled", ticket: metadata.issue };
  }

  if (issue.state === "closed") {
    return conflict("closed-ticket-without-publication-marker");
  }
  if (!(await ensureDraftPullRequest(options, boundary))) {
    return conflict("ambiguous-integration-pull-request");
  }
  await boundary.createPublicationMarker(metadata.issue, expected);
  const visibleMarkers = markersFrom(
    await boundary.listIssueComments(metadata.issue),
  );
  if (
    !visibleMarkers ||
    visibleMarkers.length !== 1 ||
    !equalMarker(visibleMarkers[0]!, expected)
  ) {
    return conflict("publication-marker-not-unique-or-visible");
  }
  await boundary.closeIssue(metadata.issue);
  return { head: integrationHead, status: "reconciled", ticket: metadata.issue };
}
