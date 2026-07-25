import {
  ensureIntegrationPullRequest,
  type DraftPullRequest,
  type IntegrationPullRequest,
} from "./integration-pull-request.js";
import {
  parseCompletionMetadata,
  parsePublicationMarker,
  renderPublicationMarker,
  type PublicationMarker,
} from "./publication-facts.js";
import type { DeadlinePublicationFact } from "./deadline.js";

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

export interface PublicationInspectionBoundary {
  getCommit(sha: string): Promise<RemoteCommit>;
  getIssue(issue: number): Promise<RemoteIssue>;
  listIssueComments(issue: number): Promise<IssueComment[]>;
  remoteHead(branch: string): Promise<string | null>;
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

export async function inspectPublicationAtDeadline(
  options: {
    beforeHead: string;
    integrationBranch: string;
    ticket: number;
  },
  boundary: PublicationInspectionBoundary,
): Promise<DeadlinePublicationFact> {
  const integrationHead = await boundary.remoteHead(options.integrationBranch);
  if (integrationHead === options.beforeHead) return { status: "absent" };
  if (!integrationHead) return { status: "unknown" };

  const commit = await boundary.getCommit(integrationHead);
  const metadata = parseCompletionMetadata(commit.message);
  if (
    commit.sha !== integrationHead ||
    commit.parents.length !== 1 ||
    commit.parents[0] !== options.beforeHead ||
    metadata?.beforeHead !== options.beforeHead ||
    metadata.issue !== options.ticket
  ) {
    return { status: "unknown" };
  }

  const [issue, comments] = await Promise.all([
    boundary.getIssue(options.ticket),
    boundary.listIssueComments(options.ticket),
  ]);
  const markers = markersFrom(comments);
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
  if (
    issue.number !== options.ticket ||
    issue.state !== "closed" ||
    markers?.length !== 1 ||
    !equalMarker(markers[0]!, expected)
  ) {
    return { status: "unknown" };
  }
  return { head: integrationHead, status: "complete", ticket: options.ticket };
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

  const commit = await boundary.getCommit(integrationHead);
  const metadata = parseCompletionMetadata(commit.message);
  if (
    commit.sha !== integrationHead ||
    !Array.isArray(commit.parents)
  ) {
    return conflict("unprovable-completion-commit");
  }
  if (!metadata && baseHead === integrationHead) return { status: "none" };
  if (
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
  if (!(await ensureIntegrationPullRequest(options, boundary))) {
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
