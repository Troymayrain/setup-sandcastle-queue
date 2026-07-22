import { join } from "node:path";

import { ConfigurationError, InfrastructureError, readProjectConfig } from "../config.js";
import { resolveGitHubRepository } from "../github/configure.js";
import { parseParentMembership } from "../github/frontier.js";
import { resolveRepositoryRoot } from "../installer/plan.js";
import {
  parseTicketPublicationRecord,
  type TicketPublicationRecord,
} from "../ticket/publish.js";
import type { BatchRunState, BatchRunTicket } from "./run.js";
import type { ContinuationInput } from "./run.js";

const batchIdPattern = /^p([1-9][0-9]*)-([a-f0-9]{12})-r([1-9][0-9]*)$/u;

interface GitHubResponse<T> {
  data: T | null;
  headers: Headers;
}

interface GitHubIssue {
  assignees?: unknown[];
  body?: string | null;
  closed_at?: string | null;
  issue_dependencies_summary?: { blocked_by?: number };
  labels?: Array<{ name?: string }>;
  number?: number;
  pull_request?: unknown;
  state?: string;
}

interface GitHubComment {
  body?: string;
  id?: number;
}

interface GitHubCommit {
  commit?: { message?: string };
  parents?: Array<{ sha?: string }>;
  sha?: string;
}

interface PublishedCommitFact {
  batchId: string;
  sessionId: string;
  sha: string;
  ticket: number;
}

class BatchRunGitHubClient {
  readonly #apiUrl: string;
  readonly #token: string;

  constructor(apiUrl: string, token: string) {
    this.#apiUrl = apiUrl.replace(/\/$/u, "");
    this.#token = token;
  }

  async get<T>(path: string): Promise<GitHubResponse<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.#apiUrl}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "user-agent": "setup-sandcastle-queue",
          "x-github-api-version": "2022-11-28",
        },
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw infrastructureError(
        "GITHUB_API_UNREACHABLE",
        "Unable to read authoritative Batch run state from GitHub.",
      );
    }
    if (response.status !== 200) {
      throw infrastructureError(
        "GITHUB_API_FAILED",
        `GitHub Batch run state read failed with status ${response.status}.`,
      );
    }
    try {
      return {
        data: (await response.json()) as T,
        headers: response.headers,
      };
    } catch {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid Batch run state JSON.",
      );
    }
  }

  async post(path: string, body: object): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.#apiUrl}${path}`, {
        body: JSON.stringify(body),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "user-agent": "setup-sandcastle-queue",
          "x-github-api-version": "2022-11-28",
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw infrastructureError(
        "GITHUB_API_UNREACHABLE",
        "Unable to dispatch a Batch continuation.",
      );
    }
    if (response.status !== 204) {
      throw infrastructureError(
        "GITHUB_API_WRITE_FAILED",
        `GitHub continuation dispatch failed with status ${response.status}.`,
      );
    }
  }
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value);
}

function hasNextPage(headers: Headers): boolean {
  return /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/iu.test(
    headers.get("link") ?? "",
  );
}

function clientFor(environment: NodeJS.ProcessEnv): BatchRunGitHubClient {
  const token = environment.GITHUB_TOKEN;
  if (!token) {
    throw configurationError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to read Batch run state.",
    );
  }
  return new BatchRunGitHubClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    token,
  );
}

function environmentRepository(environment: NodeJS.ProcessEnv): string | undefined {
  const candidate = environment.GITHUB_REPOSITORY;
  return candidate && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(candidate)
    ? candidate
    : undefined;
}

async function listIssueNumbers(
  client: BatchRunGitHubClient,
  repository: string,
): Promise<number[]> {
  const numbers: number[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.get<Array<{ number?: number; pull_request?: unknown }>>(
      `/repos/${repository}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
    );
    if (
      !Array.isArray(response.data) ||
      !response.data.every(
        ({ number }) => Number.isSafeInteger(number) && (number ?? 0) > 0,
      )
    ) {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid issue identities for Batch reconstruction.",
      );
    }
    numbers.push(
      ...response.data
        .filter(({ pull_request: pullRequest }) => pullRequest === undefined)
        .map(({ number }) => number as number),
    );
    if (!hasNextPage(response.headers)) return [...new Set(numbers)];
  }
  throw infrastructureError(
    "GITHUB_API_INVALID_RESPONSE",
    "GitHub issue pagination exceeded the supported bound.",
  );
}

function validIssue(issue: GitHubIssue): boolean {
  return (
    Number.isSafeInteger(issue.number) &&
    (issue.number ?? 0) > 0 &&
    (typeof issue.body === "string" || issue.body === null) &&
    (issue.state === "open" || issue.state === "closed") &&
    Array.isArray(issue.labels) &&
    issue.labels.every(({ name }) => typeof name === "string") &&
    Array.isArray(issue.assignees) &&
    (issue.closed_at === null || typeof issue.closed_at === "string")
  );
}

async function readIssues(
  client: BatchRunGitHubClient,
  repository: string,
): Promise<GitHubIssue[]> {
  const numbers = await listIssueNumbers(client, repository);
  const responses = await Promise.all(
    numbers.map((number) =>
      client.get<GitHubIssue>(`/repos/${repository}/issues/${number}`),
    ),
  );
  const issues = responses.map(({ data }) => data);
  if (issues.some((issue) => !issue || !validIssue(issue))) {
    throw infrastructureError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub returned invalid latest issue state during Batch reconstruction.",
    );
  }
  return issues as GitHubIssue[];
}

async function readPublicationRecords(
  client: BatchRunGitHubClient,
  repository: string,
  ticket: number,
): Promise<TicketPublicationRecord[]> {
  const records: TicketPublicationRecord[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.get<GitHubComment[]>(
      `/repos/${repository}/issues/${ticket}/comments?per_page=100&page=${page}`,
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
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid Ticket comments during Batch reconstruction.",
      );
    }
    for (const comment of response.data) {
      const record = parseTicketPublicationRecord(comment.body as string);
      if (record) records.push(record);
    }
    if (!hasNextPage(response.headers)) return records;
  }
  throw infrastructureError(
    "GITHUB_API_INVALID_RESPONSE",
    "GitHub comment pagination exceeded the supported bound.",
  );
}

function trailerValues(message: string, name: string): string[] {
  const prefix = `${name}: `;
  return message
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function commitFact(commit: GitHubCommit): PublishedCommitFact | null {
  if (
    !validSha(commit.sha) ||
    typeof commit.commit?.message !== "string" ||
    !Array.isArray(commit.parents) ||
    !commit.parents.every(({ sha }) => validSha(sha))
  ) {
    throw infrastructureError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub returned invalid Batch commit history.",
    );
  }
  const batches = trailerValues(commit.commit.message, "Sandcastle-Batch");
  if (batches.length === 0) return null;
  const tickets = trailerValues(commit.commit.message, "Sandcastle-Ticket");
  const sessions = trailerValues(commit.commit.message, "Sandcastle-Session");
  if (
    batches.length !== 1 ||
    tickets.length !== 1 ||
    !/^[1-9][0-9]*$/u.test(tickets[0] ?? "") ||
    sessions.length !== 1
  ) {
    throw configurationError(
      "BATCH_HISTORY_INVALID",
      "Remote Batch history contains malformed Published Commit trailers.",
    );
  }
  return {
    batchId: batches[0] as string,
    sessionId: sessions[0] as string,
    sha: commit.sha,
    ticket: Number(tickets[0]),
  };
}

async function readBatchHistory(
  client: BatchRunGitHubClient,
  repository: string,
  branch: string,
  batchId: string,
  remoteHead: string,
): Promise<{ commits: Map<string, PublishedCommitFact>; originalBaseSha: string }> {
  const commits = new Map<string, PublishedCommitFact>();
  let expected = remoteHead;
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.get<GitHubCommit[]>(
      `/repos/${repository}/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.data)) {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid Batch commit history.",
      );
    }
    for (const commit of response.data) {
      if (commit.sha !== expected) {
        throw configurationError(
          "BATCH_HISTORY_INVALID",
          "Remote Batch history is not a single linear publication chain.",
        );
      }
      const fact = commitFact(commit);
      if (!fact || fact.batchId !== batchId) {
        return { commits, originalBaseSha: commit.sha as string };
      }
      if (
        commit.parents?.length !== 1 ||
        !validSha(commit.parents[0]?.sha) ||
        [...commits.values()].some(({ ticket }) => ticket === fact.ticket)
      ) {
        throw configurationError(
          "BATCH_HISTORY_INVALID",
          "Remote Batch commits do not match the active Batch or unique Ticket chain.",
        );
      }
      commits.set(fact.sha, fact);
      expected = commit.parents[0].sha as string;
    }
    if (!hasNextPage(response.headers)) break;
  }
  throw configurationError(
    "BATCH_HISTORY_INVALID",
    "Remote Batch history did not reach its original base.",
  );
}

function validRecord(
  record: TicketPublicationRecord,
  batchId: string,
  ticket: number,
  commits: Map<string, PublishedCommitFact>,
): boolean {
  const commit = commits.get(record.commit);
  return (
    record.batchId === batchId &&
    record.ticket === ticket &&
    commit?.batchId === record.batchId &&
    commit.ticket === record.ticket &&
    commit.sessionId === record.sessionId
  );
}

function classifyOpenIssue(
  issue: GitHubIssue,
  readyLabel: string,
  ownershipLabel: string,
): BatchRunTicket {
  const labels = new Set(
    (issue.labels ?? []).map(({ name }) =>
      (name as string).toLocaleLowerCase("en-US"),
    ),
  );
  const reasons: string[] = [];
  if (!labels.has(readyLabel.toLocaleLowerCase("en-US"))) {
    reasons.push(`missing-label:${readyLabel}`);
  }
  if (!labels.has(ownershipLabel.toLocaleLowerCase("en-US"))) {
    reasons.push(`missing-label:${ownershipLabel}`);
  }
  if ((issue.assignees?.length ?? 0) > 0) reasons.push("assigned-to-human");
  if ((issue.issue_dependencies_summary?.blocked_by ?? 0) > 0) {
    reasons.push("blocked-by-dependency");
  }
  return {
    number: issue.number as number,
    reasons,
    status:
      reasons.some((reason) => reason.startsWith("missing-label:"))
        ? "awaiting-enrollment"
        : reasons.length > 0
          ? "blocked"
          : "executable",
  };
}

export async function readBatchRunState(
  repositoryPath: string,
  batchId: string,
  configPath: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BatchRunState> {
  const identity = batchId.match(batchIdPattern);
  if (!identity) {
    throw configurationError(
      "BATCH_ID_INVALID",
      "Batch run state requires a canonical Batch ID.",
    );
  }
  const parent = Number(identity[1]);
  const basePrefix = identity[2] as string;
  const initialRunId = identity[3] as string;
  const branch = `sandcastle/${batchId}`;
  const root = await resolveRepositoryRoot(repositoryPath);
  const configuredRepository = environmentRepository(environment);
  const [config, repository] = await Promise.all([
    readProjectConfig(configPath ?? join(root, ".sandcastle", "config.json")),
    configuredRepository
      ? Promise.resolve(configuredRepository)
      : resolveGitHubRepository(root),
  ]);
  const client = clientFor(environment);
  const [metadata, branchRef, activeRef, initialRun, issues] = await Promise.all([
    client.get<{ default_branch?: string }>(`/repos/${repository}`),
    client.get<{ object?: { sha?: string } }>(
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    ),
    client.get<{ object?: { sha?: string } }>(
      `/repos/${repository}/git/ref/heads/sandcastle%2Factive`,
    ),
    client.get<{
      created_at?: string;
      id?: number;
      repository?: { full_name?: string };
    }>(`/repos/${repository}/actions/runs/${initialRunId}`),
    readIssues(client, repository),
  ]);
  const defaultBranch = metadata.data?.default_branch;
  const remoteHead = branchRef.data?.object?.sha;
  const activeHead = activeRef.data?.object?.sha;
  const startedAt = initialRun.data?.created_at;
  if (
    typeof defaultBranch !== "string" ||
    !validSha(remoteHead) ||
    activeHead !== remoteHead ||
    initialRun.data?.id !== Number(initialRunId) ||
    initialRun.data?.repository?.full_name !== repository ||
    typeof startedAt !== "string" ||
    !Number.isFinite(Date.parse(startedAt))
  ) {
    throw configurationError(
      "BATCH_REMOTE_STATE_INVALID",
      "GitHub refs, repository metadata, or initial run identity do not match the Batch.",
    );
  }
  const history = await readBatchHistory(
    client,
    repository,
    branch,
    batchId,
    remoteHead,
  );
  if (!history.originalBaseSha.startsWith(basePrefix)) {
    throw configurationError(
      "BATCH_REMOTE_STATE_INVALID",
      "Remote Batch history does not match the Batch base prefix.",
    );
  }
  const childIssues = issues.filter((issue) => {
    if (issue.number === parent || issue.pull_request !== undefined) return false;
    const membership = parseParentMembership(issue.body ?? "");
    return membership.kind === "valid" && membership.parent === parent;
  });
  if (childIssues.length === 0) {
    throw configurationError(
      "BATCH_REMOTE_STATE_INVALID",
      "The parent PRD has no current child Tickets.",
    );
  }
  const records = await Promise.all(
    childIssues.map((issue) =>
      readPublicationRecords(client, repository, issue.number as number),
    ),
  );
  const tickets = childIssues.map((issue, index): BatchRunTicket => {
    const ticketRecords = records[index] as TicketPublicationRecord[];
    const number = issue.number as number;
    if (
      ticketRecords.length > 1 ||
      (ticketRecords[0] &&
        !validRecord(ticketRecords[0], batchId, number, history.commits))
    ) {
      return { number, reasons: ["publication-record-conflict"], status: "conflict" };
    }
    if (ticketRecords.length === 1) {
      return issue.state === "closed"
        ? { number, reasons: [], status: "published" }
        : { number, reasons: ["published-ticket-open"], status: "conflict" };
    }
    if (issue.state === "closed") {
      const closedAt = Date.parse(issue.closed_at ?? "");
      return Number.isFinite(closedAt) && closedAt <= Date.parse(startedAt)
        ? { number, reasons: [], status: "preexisting-complete" }
        : { number, reasons: ["closed-without-publication"], status: "conflict" };
    }
    return classifyOpenIssue(
      issue,
      config.queue.readyLabel,
      config.queue.ownershipLabel,
    );
  });
  return {
    activeHead,
    batchId,
    branch,
    defaultBranch,
    initialRunId,
    originalBaseSha: history.originalBaseSha,
    parent,
    remoteHead,
    tickets: tickets.sort((left, right) => left.number - right.number),
  };
}

export async function dispatchBatchContinuation(
  repositoryPath: string,
  state: BatchRunState,
  input: ContinuationInput,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (
    input.batchId !== state.batchId ||
    input.expectedHead !== state.remoteHead ||
    !/^[1-9][0-9]*$/u.test(input.predecessorRunId)
  ) {
    throw configurationError(
      "CONTINUATION_STATE_MISMATCH",
      "Continuation dispatch must bind the current Batch and remote HEAD.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  const configuredRepository = environmentRepository(environment);
  const repository =
    configuredRepository ?? (await resolveGitHubRepository(root));
  await clientFor(environment).post(
    `/repos/${repository}/actions/workflows/sandcastle.yml/dispatches`,
    {
      inputs: {
        batch_id: input.batchId,
        expected_head: input.expectedHead,
        operation: "continue",
        predecessor_run_id: input.predecessorRunId,
      },
      ref: state.defaultBranch,
    },
  );
}
