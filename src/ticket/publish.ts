import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { BatchMetadata } from "../batch/start.js";
import { canonicalJson } from "../canonical-json.js";
import { ConfigurationError, InfrastructureError } from "../config.js";
import { resolveGitHubRepository } from "../github/configure.js";
import { resolveRepositoryRoot } from "../installer/plan.js";
import { checkProtectedPaths } from "../sandbox/policy.js";
import type { TicketProcessingResult } from "./process.js";

const markerPattern = /<!-- sandcastle-batch-state\n([\s\S]*?)\n-->/u;
const publicationRecordPattern =
  /<!-- sandcastle-ticket-publication\n([\s\S]*?)\n-->/u;

interface GitHubResponse<T> {
  data: T | null;
  headers: Headers;
  status: number;
}

interface GitHubIssue {
  number?: number;
  state?: string;
  title?: string;
}

interface GitHubPullRequest {
  base?: { ref?: string };
  body?: string | null;
  draft?: boolean;
  head?: { ref?: string };
  html_url?: string;
  number?: number;
  title?: string;
}

interface GitHubCommit {
  commit?: { message?: string };
  parents?: Array<{ sha?: string }>;
  sha?: string;
}

interface GitHubComment {
  body?: string;
  id?: number;
}

interface PullRequestMarker {
  batchId: string;
  parent: number;
  publishedTickets: number[];
  schemaVersion: 1;
}

export interface TicketPublicationRecord {
  batchId: string;
  commit: string;
  pullRequest: PublishedPullRequest;
  schemaVersion: 1;
  sessionId: string;
  ticket: number;
}

export interface PublishTicketOptions {
  batch: BatchMetadata;
  processing: TicketProcessingResult;
}

export interface PublishedPullRequest {
  draft: true;
  number: number;
  url: string;
}

export interface TicketPublicationResult {
  batchId: string;
  commit: string;
  pullRequest: PublishedPullRequest;
  remoteHead: string;
  sessionId: string;
  status: "published";
  ticket: number;
}

export type PublicationCheckpoint =
  | "after-close"
  | "after-push"
  | "before-push";

export interface TicketPublicationRuntime {
  checkpoint?: (point: PublicationCheckpoint) => Promise<void> | void;
}

export interface ReconcileTicketPublicationOptions
  extends PublishTicketOptions {
  expectedHead?: string;
}

export interface TicketPublicationPendingResult {
  batchId: string;
  expectedHead: null;
  remoteHead: string;
  sessionId: string;
  status: "publication-required";
  ticket: number;
}

export interface TicketReconciliationResult
  extends Omit<TicketPublicationResult, "status"> {
  expectedHead: string;
  status: "reconciled";
}

class PublicationGitHubClient {
  readonly #apiUrl: string;
  readonly #token: string;

  constructor(apiUrl: string, token: string) {
    this.#apiUrl = apiUrl.replace(/\/$/u, "");
    this.#token = token;
  }

  async request<T>(
    method: "GET" | "PATCH" | "POST",
    path: string,
    body: object | undefined,
    allowedStatuses: number[],
  ): Promise<GitHubResponse<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.#apiUrl}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": "setup-sandcastle-queue",
          "x-github-api-version": "2022-11-28",
        },
        method,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw infrastructureError(
        "GITHUB_API_UNREACHABLE",
        "Unable to reach GitHub while publishing a Ticket.",
      );
    }
    if (!allowedStatuses.includes(response.status)) {
      throw infrastructureError(
        method === "GET" ? "GITHUB_API_FAILED" : "GITHUB_API_WRITE_FAILED",
        `GitHub Ticket publication ${method} failed with status ${response.status}.`,
      );
    }
    const source = await response.text();
    if (!source) {
      return { data: null, headers: response.headers, status: response.status };
    }
    try {
      return {
        data: JSON.parse(source) as T,
        headers: response.headers,
        status: response.status,
      };
    } catch {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid Ticket publication data.",
      );
    }
  }

  get<T>(path: string): Promise<GitHubResponse<T>> {
    return this.request<T>("GET", path, undefined, [200]);
  }

  patch<T>(path: string, body: object): Promise<GitHubResponse<T>> {
    return this.request<T>("PATCH", path, body, [200]);
  }

  post<T>(path: string, body: object): Promise<GitHubResponse<T>> {
    return this.request<T>("POST", path, body, [201]);
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

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function validToolCalls(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const calls = value as Partial<TicketProcessingResult["toolCalls"]>;
  return [calls.codeReview, calls.implement, calls.tdd].every(
    (call) => typeof call === "string" && call.length > 0 && call.length <= 256,
  );
}

function validateInputs(options: PublishTicketOptions): void {
  const { batch, processing } = options;
  if (
    batch === null ||
    typeof batch !== "object" ||
    Array.isArray(batch) ||
    batch.schemaVersion !== 1 ||
    batch.state !== "processing" ||
    !Number.isSafeInteger(batch.parent) ||
    batch.parent <= 0 ||
    !validSha(batch.originalBaseSha) ||
    !/^[1-9][0-9]*$/u.test(batch.initialRunId) ||
    batch.id !==
      `p${batch.parent}-${batch.originalBaseSha.slice(0, 12)}-r${batch.initialRunId}` ||
    batch.branch !== `sandcastle/${batch.id}` ||
    !Array.isArray(batch.verifiedTickets) ||
    !batch.verifiedTickets.every(
      (ticket) => Number.isSafeInteger(ticket) && ticket > 0,
    ) ||
    new Set(batch.verifiedTickets).size !== batch.verifiedTickets.length
  ) {
    throw configurationError(
      "BATCH_METADATA_INVALID",
      "Ticket publication requires valid processing Batch metadata.",
    );
  }
  if (
    processing === null ||
    typeof processing !== "object" ||
    Array.isArray(processing) ||
    processing.status !== "reviewed" ||
    !Number.isSafeInteger(processing.ticket) ||
    processing.ticket <= 0 ||
    !batch.verifiedTickets.includes(processing.ticket) ||
    !validSha(processing.beforeHead) ||
    !validSha(processing.head) ||
    !validSessionId(processing.sessionId) ||
    !Array.isArray(processing.findings) ||
    processing.findings.length !== 0 ||
    !validHash(processing.verificationHash) ||
    !validToolCalls(processing.toolCalls)
  ) {
    throw configurationError(
      "TICKET_RESULT_INVALID",
      "Ticket publication requires a finding-free verified processing result.",
    );
  }
}

async function readJson(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw configurationError(
      "PUBLICATION_INPUT_INVALID",
      "Unable to read a Ticket publication input file.",
    );
  }
  if (source.length > 1024 * 1024) {
    throw configurationError(
      "PUBLICATION_INPUT_INVALID",
      "Ticket publication input exceeds the supported size.",
    );
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw configurationError(
      "PUBLICATION_INPUT_INVALID",
      "Ticket publication input is not valid JSON.",
    );
  }
}

export async function readTicketPublicationInputs(
  batchPath: string,
  processingResultPath: string,
): Promise<PublishTicketOptions> {
  const [batch, processing] = await Promise.all([
    readJson(batchPath),
    readJson(processingResultPath),
  ]);
  const options = {
    batch: batch as BatchMetadata,
    processing: processing as TicketProcessingResult,
  };
  validateInputs(options);
  return options;
}

function git(
  repository: string,
  arguments_: string[],
  options: { allowFailure?: boolean; environment?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      arguments_,
      {
        cwd: repository,
        encoding: "utf8",
        env: options.environment,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        if (error && !options.allowFailure) {
          reject(
            infrastructureError(
              "TICKET_GIT_FAILED",
              "A host Git operation failed while publishing the Ticket.",
            ),
          );
          return;
        }
        resolve({ exitCode, stdout });
      },
    );
  });
}

function gitWithInput(
  repository: string,
  arguments_: string[],
  input: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", arguments_, {
      cwd: repository,
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", () =>
      reject(
        infrastructureError(
          "TICKET_COMMIT_FAILED",
          "Unable to create the host-controlled Published Commit.",
        ),
      ),
    );
    child.on("close", (status) => {
      if (status !== 0) {
        reject(
          infrastructureError(
            "TICKET_COMMIT_FAILED",
            "Unable to create the host-controlled Published Commit.",
          ),
        );
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

function hasNextPage(headers: Headers): boolean {
  return /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/iu.test(
    headers.get("link") ?? "",
  );
}

function repositoryName(environment: NodeJS.ProcessEnv): string | undefined {
  const candidate = environment.GITHUB_REPOSITORY;
  return candidate && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(candidate)
    ? candidate
    : undefined;
}

function clientFor(environment: NodeJS.ProcessEnv): PublicationGitHubClient {
  const token = environment.GITHUB_TOKEN;
  if (!token) {
    throw configurationError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to publish a Ticket.",
    );
  }
  return new PublicationGitHubClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    token,
  );
}

function commitMessage(title: string, options: PublishTicketOptions): string {
  const subject = title.replace(/[\u0000\r\n]+/gu, " ").trim().slice(0, 200);
  return [
    `Ticket #${options.processing.ticket}: ${subject}`,
    "",
    `Sandcastle-Batch: ${options.batch.id}`,
    `Sandcastle-Ticket: ${options.processing.ticket}`,
    `Sandcastle-Session: ${options.processing.sessionId}`,
    "",
  ].join("\n");
}

function validMarker(candidate: unknown): candidate is PullRequestMarker {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const marker = candidate as Partial<PullRequestMarker>;
  return (
    Object.keys(candidate).sort().join("\u0000") ===
      ["batchId", "parent", "publishedTickets", "schemaVersion"]
        .sort()
        .join("\u0000") &&
    marker.schemaVersion === 1 &&
    typeof marker.batchId === "string" &&
    Number.isSafeInteger(marker.parent) &&
    (marker.parent ?? 0) > 0 &&
    Array.isArray(marker.publishedTickets) &&
    marker.publishedTickets.every(
      (ticket) => Number.isSafeInteger(ticket) && ticket > 0,
    ) &&
    new Set(marker.publishedTickets).size === marker.publishedTickets.length
  );
}

function markerFor(marker: PullRequestMarker): string {
  return `<!-- sandcastle-batch-state\n${canonicalJson(marker).trimEnd()}\n-->`;
}

function validPublishedPullRequest(
  candidate: unknown,
): candidate is PublishedPullRequest {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const pullRequest = candidate as Partial<PublishedPullRequest>;
  return (
    Object.keys(candidate).sort().join("\u0000") ===
      ["draft", "number", "url"].sort().join("\u0000") &&
    pullRequest.draft === true &&
    Number.isSafeInteger(pullRequest.number) &&
    (pullRequest.number ?? 0) > 0 &&
    typeof pullRequest.url === "string" &&
    pullRequest.url.length > 0
  );
}

function validPublicationRecord(candidate: unknown): candidate is TicketPublicationRecord {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const record = candidate as Partial<TicketPublicationRecord>;
  return (
    Object.keys(candidate).sort().join("\u0000") ===
      [
        "batchId",
        "commit",
        "pullRequest",
        "schemaVersion",
        "sessionId",
        "ticket",
      ]
        .sort()
        .join("\u0000") &&
    record.schemaVersion === 1 &&
    typeof record.batchId === "string" &&
    validSha(record.commit) &&
    validPublishedPullRequest(record.pullRequest) &&
    validSessionId(record.sessionId) &&
    Number.isSafeInteger(record.ticket) &&
    (record.ticket ?? 0) > 0
  );
}

function publicationComment(record: TicketPublicationRecord): string {
  return [
    `Published as ${record.commit} in draft PR #${record.pullRequest.number}.`,
    "",
    "<!-- sandcastle-ticket-publication",
    canonicalJson(record).trimEnd(),
    "-->",
  ].join("\n");
}

export function parseTicketPublicationRecord(
  body: string,
): TicketPublicationRecord | null {
  const match = body.match(publicationRecordPattern);
  if (!match?.[1]) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(match[1]) as unknown;
  } catch {
    throw configurationError(
      "TICKET_PUBLICATION_RECORD_INVALID",
      "A Ticket publication record contains invalid managed JSON.",
    );
  }
  if (!validPublicationRecord(candidate)) {
    throw configurationError(
      "TICKET_PUBLICATION_RECORD_INVALID",
      "A Ticket publication record has an unsupported shape.",
    );
  }
  return candidate;
}

function updatePullRequestBody(
  current: string,
  batch: BatchMetadata,
  ticket: number,
): string {
  const match = current.match(markerPattern);
  let publishedTickets: number[] = [];
  if (match?.[1]) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(match[1]) as unknown;
    } catch {
      throw configurationError(
        "BATCH_PR_MARKER_INVALID",
        "The Batch draft PR contains an invalid managed state marker.",
      );
    }
    if (
      !validMarker(candidate) ||
      candidate.batchId !== batch.id ||
      candidate.parent !== batch.parent
    ) {
      throw configurationError(
        "BATCH_PR_MARKER_INVALID",
        "The Batch draft PR marker does not match the active Batch.",
      );
    }
    publishedTickets = candidate.publishedTickets;
  }
  const marker = markerFor({
    batchId: batch.id,
    parent: batch.parent,
    publishedTickets: [...new Set([...publishedTickets, ticket])].sort(
      (left, right) => left - right,
    ),
    schemaVersion: 1,
  });
  let updated = match
    ? current.replace(markerPattern, marker)
    : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${marker}\n`;
  const closingReference = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${batch.parent}\\b`,
    "iu",
  );
  if (!closingReference.test(updated)) {
    updated = `${updated.trimEnd()}\n\nCloses #${batch.parent}\n`;
  }
  return updated;
}

function validPullRequest(
  pullRequest: GitHubPullRequest,
  branch: string,
  defaultBranch: string,
): pullRequest is GitHubPullRequest & {
  draft: true;
  html_url: string;
  number: number;
} {
  return (
    Number.isSafeInteger(pullRequest.number) &&
    (pullRequest.number ?? 0) > 0 &&
    pullRequest.draft === true &&
    pullRequest.head?.ref === branch &&
    pullRequest.base?.ref === defaultBranch &&
    typeof pullRequest.html_url === "string" &&
    (pullRequest.body === null ||
      pullRequest.body === undefined ||
      typeof pullRequest.body === "string")
  );
}

async function findBatchPullRequest(
  client: PublicationGitHubClient,
  repository: string,
  branch: string,
): Promise<GitHubPullRequest | undefined> {
  for (let page = 1; ; page += 1) {
    const response = await client.get<GitHubPullRequest[]>(
      `/repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.data)) {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid pull request data.",
      );
    }
    const match = response.data.find(({ head }) => head?.ref === branch);
    if (match) return match;
    if (!hasNextPage(response.headers)) return undefined;
  }
}

async function ensureDraftPullRequest(
  client: PublicationGitHubClient,
  repository: string,
  defaultBranch: string,
  options: PublishTicketOptions,
): Promise<PublishedPullRequest> {
  const existing = await findBatchPullRequest(
    client,
    repository,
    options.batch.branch,
  );
  if (existing) {
    if (!validPullRequest(existing, options.batch.branch, defaultBranch)) {
      throw configurationError(
        "BATCH_PR_INVALID",
        "The existing Batch pull request is not the expected draft and base.",
      );
    }
    const body = updatePullRequestBody(
      existing.body ?? "",
      options.batch,
      options.processing.ticket,
    );
    if (body !== (existing.body ?? "")) {
      await client.patch(`/repos/${repository}/pulls/${existing.number}`, { body });
    }
    return { draft: true, number: existing.number, url: existing.html_url };
  }
  const body = updatePullRequestBody(
    "## Sandcastle Batch\n\nThis draft is maintained by the Sandcastle host.",
    options.batch,
    options.processing.ticket,
  );
  const created = await client.post<GitHubPullRequest>(
    `/repos/${repository}/pulls`,
    {
      base: defaultBranch,
      body,
      draft: true,
      head: options.batch.branch,
      title: `Sandcastle Batch ${options.batch.id}`,
    },
  );
  const candidate = created.data;
  if (
    !candidate ||
    candidate.draft !== true ||
    !Number.isSafeInteger(candidate.number) ||
    (candidate.number ?? 0) <= 0 ||
    typeof candidate.html_url !== "string"
  ) {
    throw infrastructureError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub omitted the created draft pull request identity.",
    );
  }
  return {
    draft: true,
    number: candidate.number as number,
    url: candidate.html_url,
  };
}

export async function publishTicket(
  repositoryPath: string,
  options: PublishTicketOptions,
  environment: NodeJS.ProcessEnv = process.env,
  runtime: TicketPublicationRuntime = {},
): Promise<TicketPublicationResult> {
  validateInputs(options);
  const root = await resolveRepositoryRoot(repositoryPath);
  const repository =
    repositoryName(environment) ?? (await resolveGitHubRepository(root));
  const client = clientFor(environment);
  const [{ stdout: branch }, { stdout: head }] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(root, ["rev-parse", "HEAD"]),
  ]);
  const currentBranch = branch.trim();
  const currentHead = head.trim();
  if (
    currentBranch !== options.batch.branch ||
    currentHead !== options.processing.head ||
    options.processing.beforeHead === currentHead
  ) {
    throw configurationError(
      "TICKET_PUBLICATION_STATE_MISMATCH",
      "The local Batch branch does not match the verified Ticket result.",
    );
  }
  const ancestry = await git(
    root,
    ["merge-base", "--is-ancestor", options.processing.beforeHead, currentHead],
    { allowFailure: true },
  );
  if (ancestry.exitCode !== 0) {
    throw configurationError(
      "TICKET_PUBLICATION_STATE_MISMATCH",
      "The verified Ticket result does not descend from the pre-processing Batch HEAD.",
    );
  }
  await checkProtectedPaths(root, options.processing.beforeHead);

  const [repositoryMetadata, issueResponse] = await Promise.all([
    client.get<{ default_branch?: string }>(`/repos/${repository}`),
    client.get<GitHubIssue>(
      `/repos/${repository}/issues/${options.processing.ticket}`,
    ),
  ]);
  const defaultBranch = repositoryMetadata.data?.default_branch;
  const issue = issueResponse.data;
  if (
    typeof defaultBranch !== "string" ||
    defaultBranch.length === 0 ||
    !issue ||
    issue.number !== options.processing.ticket ||
    issue.state !== "open" ||
    typeof issue.title !== "string" ||
    issue.title.trim().length === 0
  ) {
    throw configurationError(
      "TICKET_PUBLICATION_TARGET_INVALID",
      "Ticket publication requires an open matching Ticket and default branch.",
    );
  }

  await git(root, ["add", "-A", "--", "."]);
  const [{ stdout: tree }, { stdout: baseTree }] = await Promise.all([
    git(root, ["write-tree"]),
    git(root, ["rev-parse", `${options.processing.beforeHead}^{tree}`]),
  ]);
  if (tree.trim() === baseTree.trim()) {
    throw configurationError(
      "TICKET_NO_DIFF",
      "The verified Ticket result has no tree change to publish.",
    );
  }
  const publishedCommit = await gitWithInput(
    root,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "commit-tree",
      tree.trim(),
      "-p",
      options.processing.beforeHead,
    ],
    commitMessage(issue.title, options),
    {
      ...environment,
      GIT_AUTHOR_EMAIL: "sandcastle@users.noreply.github.com",
      GIT_AUTHOR_NAME: "Sandcastle Queue",
      GIT_COMMITTER_EMAIL: "sandcastle@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Sandcastle Queue",
    },
  );
  if (!validSha(publishedCommit)) {
    throw infrastructureError(
      "TICKET_COMMIT_FAILED",
      "Git did not return a valid Published Commit identity.",
    );
  }

  await runtime.checkpoint?.("before-push");

  const push = await git(
    root,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "--atomic",
      "--porcelain",
      `--force-with-lease=refs/heads/${options.batch.branch}:${options.processing.beforeHead}`,
      `--force-with-lease=refs/heads/sandcastle/active:${options.processing.beforeHead}`,
      "origin",
      `${publishedCommit}:refs/heads/${options.batch.branch}`,
      `${publishedCommit}:refs/heads/sandcastle/active`,
    ],
    { allowFailure: true, environment },
  );
  if (push.exitCode !== 0) {
    throw infrastructureError(
      "TICKET_ATOMIC_PUSH_FAILED",
      "The atomic Batch publication push was rejected.",
    );
  }
  await runtime.checkpoint?.("after-push");
  const remote = await client.get<{ object?: { sha?: string } }>(
    `/repos/${repository}/git/ref/heads/${encodeURIComponent(options.batch.branch)}`,
  );
  const remoteHead = remote.data?.object?.sha;
  if (remoteHead !== publishedCommit) {
    throw configurationError(
      "PUBLISHED_HEAD_MISMATCH",
      "GitHub remote HEAD does not match the host-created Published Commit.",
    );
  }
  await git(root, [
    "update-ref",
    `refs/heads/${options.batch.branch}`,
    publishedCommit,
    currentHead,
  ]);

  const pullRequest = await ensureDraftPullRequest(
    client,
    repository,
    defaultBranch,
    options,
  );
  await client.post(
    `/repos/${repository}/issues/${options.processing.ticket}/comments`,
    {
      body: publicationComment({
        batchId: options.batch.id,
        commit: publishedCommit,
        pullRequest,
        schemaVersion: 1,
        sessionId: options.processing.sessionId,
        ticket: options.processing.ticket,
      }),
    },
  );
  await client.patch(`/repos/${repository}/issues/${options.processing.ticket}`, {
    state: "closed",
  });
  await runtime.checkpoint?.("after-close");
  return {
    batchId: options.batch.id,
    commit: publishedCommit,
    pullRequest,
    remoteHead,
    sessionId: options.processing.sessionId,
    status: "published",
    ticket: options.processing.ticket,
  };
}

function validGitHubCommit(candidate: unknown): candidate is Required<GitHubCommit> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const commit = candidate as GitHubCommit;
  return (
    validSha(commit.sha) &&
    commit.commit !== undefined &&
    typeof commit.commit.message === "string" &&
    Array.isArray(commit.parents) &&
    commit.parents.every(({ sha }) => validSha(sha))
  );
}

async function readReachableCommits(
  client: PublicationGitHubClient,
  repository: string,
  branch: string,
  beforeHead: string,
): Promise<Array<Required<GitHubCommit>>> {
  const commits: Array<Required<GitHubCommit>> = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.get<GitHubCommit[]>(
      `/repos/${repository}/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.data) || !response.data.every(validGitHubCommit)) {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid remote commit history.",
      );
    }
    for (const commit of response.data) {
      commits.push(commit as Required<GitHubCommit>);
      if (commit.sha === beforeHead) return commits;
    }
    if (!hasNextPage(response.headers)) break;
  }
  throw configurationError(
    "REMOTE_HISTORY_UNEXPECTED",
    "The remote Batch history does not reach the pre-processing HEAD.",
  );
}

function trailerValues(message: string, name: string): string[] {
  const prefix = `${name}: `;
  return message
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

function validatePublishedCommit(
  commits: Array<Required<GitHubCommit>>,
  remoteHead: string,
  options: PublishTicketOptions,
): string | null {
  const ticketValue = String(options.processing.ticket);
  const candidates = commits.filter(({ commit }) =>
    trailerValues(commit.message as string, "Sandcastle-Ticket").includes(
      ticketValue,
    ),
  );
  if (candidates.length > 1) {
    throw configurationError(
      "DUPLICATE_PUBLISHED_COMMITS",
      "Remote history contains duplicate completion commits for one Ticket.",
    );
  }
  if (candidates.length === 0) {
    if (remoteHead === options.processing.beforeHead) return null;
    throw configurationError(
      "REMOTE_HEAD_UNEXPECTED",
      "Remote Batch HEAD is not a valid Published Commit for this Ticket.",
    );
  }
  const candidate = candidates[0]!;
  const message = candidate.commit.message as string;
  const batch = trailerValues(message, "Sandcastle-Batch");
  const ticket = trailerValues(message, "Sandcastle-Ticket");
  const session = trailerValues(message, "Sandcastle-Session");
  if (
    candidate.sha !== remoteHead ||
    candidate.parents.length !== 1 ||
    candidate.parents[0]?.sha !== options.processing.beforeHead
  ) {
    throw configurationError(
      "REMOTE_HEAD_UNEXPECTED",
      "The valid Ticket completion commit is not the expected remote Batch HEAD.",
    );
  }
  if (
    batch.length !== 1 ||
    batch[0] !== options.batch.id ||
    ticket.length !== 1 ||
    ticket[0] !== ticketValue ||
    session.length !== 1 ||
    session[0] !== options.processing.sessionId
  ) {
    throw configurationError(
      "PUBLISHED_COMMIT_METADATA_MISMATCH",
      "Published Commit trailers do not match the active Batch, Ticket, and Session.",
    );
  }
  return candidate.sha as string;
}

async function listPublicationRecords(
  client: PublicationGitHubClient,
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
        (comment) =>
          Number.isSafeInteger(comment.id) &&
          (comment.id ?? 0) > 0 &&
          typeof comment.body === "string",
      )
    ) {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid Ticket comments during reconciliation.",
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
    "GitHub Ticket comment pagination exceeded the supported bound.",
  );
}

function matchingPublicationRecord(
  records: TicketPublicationRecord[],
  commit: string,
  options: PublishTicketOptions,
): TicketPublicationRecord | undefined {
  if (records.length > 1) {
    throw configurationError(
      "DUPLICATE_PUBLICATION_RECORDS",
      "Ticket comments contain duplicate managed publication records.",
    );
  }
  const record = records[0];
  if (!record) return undefined;
  if (
    record.batchId !== options.batch.id ||
    record.commit !== commit ||
    record.sessionId !== options.processing.sessionId ||
    record.ticket !== options.processing.ticket
  ) {
    throw configurationError(
      "TICKET_PUBLICATION_RECORD_MISMATCH",
      "The managed Ticket publication record does not match remote Git history.",
    );
  }
  return record;
}

export async function reconcileTicketPublication(
  repositoryPath: string,
  options: ReconcileTicketPublicationOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TicketPublicationPendingResult | TicketReconciliationResult> {
  validateInputs(options);
  if (options.expectedHead !== undefined && !validSha(options.expectedHead)) {
    throw configurationError(
      "EXPECTED_HEAD_INVALID",
      "Ticket reconciliation expected HEAD must be a complete commit SHA.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  const repository =
    repositoryName(environment) ?? (await resolveGitHubRepository(root));
  const client = clientFor(environment);
  const [remoteResponse, repositoryMetadata, issueResponse] = await Promise.all([
    client.get<{ object?: { sha?: string } }>(
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(options.batch.branch)}`,
    ),
    client.get<{ default_branch?: string }>(`/repos/${repository}`),
    client.get<GitHubIssue>(
      `/repos/${repository}/issues/${options.processing.ticket}`,
    ),
  ]);
  const remoteHead = remoteResponse.data?.object?.sha;
  if (!validSha(remoteHead)) {
    throw infrastructureError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub omitted a valid remote Batch HEAD.",
    );
  }
  if (options.expectedHead && options.expectedHead !== remoteHead) {
    throw configurationError(
      "PUBLISHED_HEAD_MISMATCH",
      "Remote Batch HEAD no longer matches the expected reconciliation point.",
    );
  }
  const issue = issueResponse.data;
  const defaultBranch = repositoryMetadata.data?.default_branch;
  if (
    !issue ||
    issue.number !== options.processing.ticket ||
    (issue.state !== "open" && issue.state !== "closed") ||
    typeof defaultBranch !== "string" ||
    defaultBranch.length === 0
  ) {
    throw configurationError(
      "TICKET_RECONCILIATION_TARGET_INVALID",
      "Ticket reconciliation requires a matching Ticket and default branch.",
    );
  }
  const commits = await readReachableCommits(
    client,
    repository,
    options.batch.branch,
    options.processing.beforeHead,
  );
  const publishedCommit = validatePublishedCommit(commits, remoteHead, options);
  if (!publishedCommit) {
    if (issue.state === "closed") {
      throw configurationError(
        "TICKET_CLOSED_WITHOUT_RECORD",
        "The Ticket is closed without a reachable valid Published Commit.",
      );
    }
    return {
      batchId: options.batch.id,
      expectedHead: null,
      remoteHead,
      sessionId: options.processing.sessionId,
      status: "publication-required",
      ticket: options.processing.ticket,
    };
  }

  const records = await listPublicationRecords(
    client,
    repository,
    options.processing.ticket,
  );
  let record = matchingPublicationRecord(records, publishedCommit, options);
  if (issue.state === "closed") {
    if (!record) {
      throw configurationError(
        "TICKET_CLOSED_WITHOUT_RECORD",
        "The Ticket is closed without a valid managed publication record.",
      );
    }
    return {
      batchId: options.batch.id,
      commit: publishedCommit,
      expectedHead: publishedCommit,
      pullRequest: record.pullRequest,
      remoteHead,
      sessionId: options.processing.sessionId,
      status: "reconciled",
      ticket: options.processing.ticket,
    };
  }

  const pullRequest = await ensureDraftPullRequest(
    client,
    repository,
    defaultBranch,
    options,
  );
  if (record && canonicalJson(record.pullRequest) !== canonicalJson(pullRequest)) {
    throw configurationError(
      "TICKET_PUBLICATION_RECORD_MISMATCH",
      "The managed publication record identifies a different Batch pull request.",
    );
  }
  if (!record) {
    record = {
      batchId: options.batch.id,
      commit: publishedCommit,
      pullRequest,
      schemaVersion: 1,
      sessionId: options.processing.sessionId,
      ticket: options.processing.ticket,
    };
    await client.post(
      `/repos/${repository}/issues/${options.processing.ticket}/comments`,
      { body: publicationComment(record) },
    );
  }
  await client.patch(`/repos/${repository}/issues/${options.processing.ticket}`, {
    state: "closed",
  });
  return {
    batchId: options.batch.id,
    commit: publishedCommit,
    expectedHead: publishedCommit,
    pullRequest: record.pullRequest,
    remoteHead,
    sessionId: options.processing.sessionId,
    status: "reconciled",
    ticket: options.processing.ticket,
  };
}
