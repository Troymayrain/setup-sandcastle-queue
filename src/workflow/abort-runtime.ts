import {
  abortBatch,
  parseBatchAbortRecord,
  renderBatchAbortRecord,
  type AbortBatchResult,
  type AbortBatchState,
  type BatchAbortRecord,
} from "../batch/abort.js";
import { ConfigurationError, InfrastructureError } from "../config.js";
import { isGitObjectId } from "../git/object-id.js";
import { parseParentMembership } from "../github/frontier.js";
import {
  parseTicketPublicationRecord,
  type TicketPublicationRecord,
} from "../ticket/publish.js";
import { executeWorkflowCapability } from "./security.js";
import {
  hasNextGitHubPage,
  WorkflowGitHubClient,
} from "./github.js";

const batchIdPattern = /^p([1-9][0-9]*)-[a-f0-9]{12}-r[1-9][0-9]*$/u;

interface GitHubIssue {
  body?: string | null;
  number?: number;
  pull_request?: unknown;
  state?: string;
}

interface GitHubComment {
  body?: string;
  id?: number;
}

interface GitHubPullRequest {
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  merged?: boolean;
  number?: number;
  state?: string;
}

interface GitHubRun {
  display_title?: string;
  event?: string;
  id?: number;
  status?: string;
}

interface GitHubReference {
  object?: { sha?: string };
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

async function listIssues(client: WorkflowGitHubClient): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.get<GitHubIssue[]>(
      `/repos/${client.repository}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
    );
    if (
      !Array.isArray(response.data) ||
      !response.data.every(
        ({ body, number, state }) =>
          Number.isSafeInteger(number) &&
          (number ?? 0) > 0 &&
          (typeof body === "string" || body === null) &&
          (state === "open" || state === "closed"),
      )
    ) {
      throw infrastructureError(
        "BATCH_ABORT_GITHUB_STATE_INVALID",
        "GitHub returned invalid issue state for Batch abort.",
      );
    }
    issues.push(...response.data.filter(({ pull_request: pullRequest }) => !pullRequest));
    if (!hasNextGitHubPage(response.headers)) return issues;
  }
  throw infrastructureError(
    "BATCH_ABORT_GITHUB_STATE_INVALID",
    "Batch abort issue pagination exceeded the supported bound.",
  );
}

async function listComments(
  client: WorkflowGitHubClient,
  issue: number,
): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.get<GitHubComment[]>(
      `/repos/${client.repository}/issues/${issue}/comments?per_page=100&page=${page}`,
    );
    if (
      !Array.isArray(response.data) ||
      !response.data.every(
        ({ body, id }) =>
          typeof body === "string" &&
          Number.isSafeInteger(id) &&
          (id ?? 0) > 0,
      )
    ) {
      throw infrastructureError(
        "BATCH_ABORT_GITHUB_STATE_INVALID",
        "GitHub returned invalid comments for Batch abort.",
      );
    }
    comments.push(...response.data);
    if (!hasNextGitHubPage(response.headers)) return comments;
  }
  throw infrastructureError(
    "BATCH_ABORT_GITHUB_STATE_INVALID",
    "Batch abort comment pagination exceeded the supported bound.",
  );
}

async function activeProcessingRuns(
  client: WorkflowGitHubClient,
  currentRunId: string,
): Promise<AbortBatchState["activeProcessingRuns"]> {
  const runs: GitHubRun[] = [];
  for (const status of ["in_progress", "queued"] as const) {
    const response = await client.get<{ workflow_runs?: GitHubRun[] }>(
      `/repos/${client.repository}/actions/workflows/sandcastle.yml/runs?event=workflow_dispatch&status=${status}&per_page=100`,
    );
    if (!Array.isArray(response.data?.workflow_runs)) {
      throw infrastructureError(
        "BATCH_ABORT_GITHUB_STATE_INVALID",
        "GitHub returned invalid active workflow runs for Batch abort.",
      );
    }
    runs.push(...response.data.workflow_runs);
  }
  return runs
    .filter(
      ({ display_title: title, event, id, status }) =>
        Number.isSafeInteger(id) &&
        String(id) !== currentRunId &&
        event === "workflow_dispatch" &&
        (status === "in_progress" || status === "queued") &&
        /^Sandcastle (?:start|continue|resume)\b/u.test(title ?? ""),
    )
    .map(({ id, status }) => ({
      id: id as number,
      status: status as "in_progress" | "queued",
    }));
}

async function publicationFor(
  client: WorkflowGitHubClient,
  ticket: number,
  batchId: string,
): Promise<TicketPublicationRecord | null> {
  const records = (await listComments(client, ticket))
    .map(({ body }) => parseTicketPublicationRecord(body as string))
    .filter(
      (record): record is TicketPublicationRecord =>
        record !== null && record.batchId === batchId,
    );
  if (records.length > 1) {
    throw infrastructureError(
      "BATCH_ABORT_GITHUB_STATE_INVALID",
      "A Ticket contains conflicting Batch publication records.",
    );
  }
  return records[0] ?? null;
}

async function readAbortState(
  client: WorkflowGitHubClient,
  options: {
    batchId: string;
    expectedHead: string;
    pullRequest: number;
    runId: string;
  },
): Promise<AbortBatchState> {
  const identity = options.batchId.match(batchIdPattern);
  if (!identity) {
    throw configurationError(
      "BATCH_ABORT_INPUT_INVALID",
      "Batch abort requires a canonical Batch identity.",
    );
  }
  const parentNumber = Number(identity[1]);
  const branch = `sandcastle/${options.batchId}`;
  const [metadata, branchRef, pull, issues, runs, auditComments] = await Promise.all([
    client.get<{ default_branch?: string }>(`/repos/${client.repository}`),
    client.get<{ object?: { sha?: string } }>(
      `/repos/${client.repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    ),
    client.get<GitHubPullRequest>(
      `/repos/${client.repository}/pulls/${options.pullRequest}`,
    ),
    listIssues(client),
    activeProcessingRuns(client, options.runId),
    listComments(client, options.pullRequest),
  ]);
  const defaultBranch = metadata.data?.default_branch;
  if (!defaultBranch) {
    throw infrastructureError(
      "BATCH_ABORT_GITHUB_STATE_INVALID",
      "GitHub omitted the default branch during Batch abort.",
    );
  }
  const defaultRef = await client.get<{ object?: { sha?: string } }>(
    `/repos/${client.repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
  );
  const remoteHead = branchRef.data?.object?.sha;
  const defaultBranchHead = defaultRef.data?.object?.sha;
  const pullRequest = pull.data;
  const parent = issues.find(({ number }) => number === parentNumber);
  const tickets = issues.filter((issue) => {
    if (issue.number === parentNumber) return false;
    const membership = parseParentMembership(issue.body ?? "");
    return membership.kind === "valid" && membership.parent === parentNumber;
  });
  if (
    !isGitObjectId(remoteHead) ||
    remoteHead !== options.expectedHead ||
    !isGitObjectId(defaultBranchHead) ||
    !parent ||
    !pullRequest ||
    pullRequest.number !== options.pullRequest ||
    pullRequest.draft !== true ||
    pullRequest.head?.ref !== branch ||
    pullRequest.head.sha !== remoteHead ||
    pullRequest.merged !== false ||
    (pullRequest.state !== "open" && pullRequest.state !== "closed")
  ) {
    throw infrastructureError(
      "BATCH_ABORT_GITHUB_STATE_INVALID",
      "Authoritative Batch, HEAD, parent, or draft PR state is invalid for abort.",
    );
  }
  const publications = await Promise.all(
    tickets.map(({ number }) =>
      publicationFor(client, number as number, options.batchId),
    ),
  );
  const abortRecords = auditComments
    .map(({ body }) => parseBatchAbortRecord(body as string))
    .filter((record): record is BatchAbortRecord => record !== null);
  return {
    abortRecords,
    activeProcessingRuns: runs,
    batch: {
      branch,
      id: options.batchId,
      parent: parentNumber,
      remoteHead: remoteHead as string,
    },
    defaultBranchHead: defaultBranchHead as string,
    parent: {
      number: parentNumber,
      state: parent.state as "closed" | "open",
    },
    pullRequest: {
      draft: true,
      head: remoteHead as string,
      merged: false,
      number: options.pullRequest,
      state: pullRequest.state,
    },
    tickets: tickets
      .map(({ number, state }, index) => ({
        number: number as number,
        publication: publications[index] ?? null,
        state: state as "closed" | "open",
      }))
      .sort((left, right) => left.number - right.number),
  };
}

export interface RunWorkflowAbortOptions {
  actor: string;
  batchId: string;
  environment: NodeJS.ProcessEnv;
  expectedHead: string;
  pullRequest: number;
  reason: string;
  repositoryPath: string;
  runId: string;
}

export async function runWorkflowAbort(
  options: RunWorkflowAbortOptions,
): Promise<AbortBatchResult> {
  const client = new WorkflowGitHubClient(options.environment);
  return abortBatch(
    options.repositoryPath,
    {
      actor: options.actor,
      batchId: options.batchId,
      expectedHead: options.expectedHead,
      pullRequest: options.pullRequest,
      reason: options.reason,
      runId: options.runId,
      trigger: "workflow_dispatch",
    },
    {
      async appendAudit(record) {
        await executeWorkflowCapability(
          { boundary: "host", capability: "publish-audit", operation: "abort" },
          () =>
            client.post(
              `/repos/${client.repository}/issues/${options.pullRequest}/comments`,
              { body: renderBatchAbortRecord(record) },
            ),
        );
      },
      async closePullRequest(number) {
        await executeWorkflowCapability(
          { boundary: "host", capability: "update-pull-request", operation: "abort" },
          () =>
            client.patch(`/repos/${client.repository}/pulls/${number}`, {
              state: "closed",
            }),
        );
      },
      async commitInDefaultBranch(commit, defaultBranchHead) {
        const response = await client.get<{
          ahead_by?: number;
          status?: string;
        }>(
          `/repos/${client.repository}/compare/${encodeURIComponent(commit)}...${encodeURIComponent(defaultBranchHead)}`,
        );
        return (
          response.data?.status === "identical" ||
          (response.data?.status === "ahead" &&
            Number.isSafeInteger(response.data.ahead_by) &&
            (response.data.ahead_by ?? 0) >= 0)
        );
      },
      async readState() {
        return readAbortState(client, options);
      },
      async releaseActiveBatch(expectedHead) {
        const path =
          `/repos/${client.repository}/git/ref/heads/sandcastle%2Factive`;
        const active = await client.get<GitHubReference>(path, [200, 404]);
        if (active.status === 404) return;
        if (active.data?.object?.sha !== expectedHead) {
          throw infrastructureError(
            "BATCH_ABORT_ACTIVE_REF_MISMATCH",
            "The active Batch ref no longer matches the Batch being aborted.",
          );
        }
        await executeWorkflowCapability(
          { boundary: "host", capability: "release-batch", operation: "abort" },
          () =>
            client.delete(
              `/repos/${client.repository}/git/refs/heads/sandcastle%2Factive`,
            ),
        );
      },
      async reopenTicket(number) {
        await executeWorkflowCapability(
          { boundary: "host", capability: "close-issue", operation: "abort" },
          () =>
            client.patch(`/repos/${client.repository}/issues/${number}`, {
              state: "open",
            }),
        );
      },
    },
  );
}
