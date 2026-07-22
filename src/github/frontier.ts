import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
  readProjectConfig,
  type ProjectConfig,
} from "../config.js";
import { sha256 } from "../hash.js";
import { resolveRepositoryRoot } from "../installer/plan.js";
import { resolveGitHubRepository } from "./configure.js";

const trustedAssociations = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
const auditMarkerPattern = /<!--\s*sandcastle(?::|-)?audit\b/iu;

export type TicketFrontierStatus =
  | "awaiting-enrollment"
  | "blocked"
  | "complete"
  | "excluded"
  | "executable";

export interface SpecCommentSnapshot {
  authorAssociation: "COLLABORATOR" | "MEMBER" | "OWNER";
  body: string;
  bodySha256: string;
  id: number;
  updatedAt: string;
  url: string;
}

export interface SpecIssueSnapshot {
  body: string;
  bodySha256: string;
  comments: SpecCommentSnapshot[];
  id: number;
  number: number;
  title: string;
  titleSha256: string;
  updatedAt: string;
  url: string;
}

export interface TicketSpecSnapshot {
  parent: SpecIssueSnapshot;
  specHash: string;
  ticket: SpecIssueSnapshot;
}

export interface FrontierTicket {
  number: number;
  reasons: string[];
  snapshot?: TicketSpecSnapshot;
  status: TicketFrontierStatus;
}

export interface FrontierResult {
  frontier: number[];
  parent: SpecIssueSnapshot;
  repository: string;
  tickets: FrontierTicket[];
}

export interface SpecVerificationResult {
  currentSpecHash: string;
  expectedSpecHash: string;
  parent: number;
  ticket: number;
  unchanged: true;
}

interface GitHubIssue {
  assignees?: unknown[];
  body?: string | null;
  html_url?: string;
  id?: number;
  issue_dependencies_summary?: { blocked_by?: number };
  labels?: Array<{ name?: string }>;
  number?: number;
  pull_request?: unknown;
  state?: string;
  title?: string;
  updated_at?: string;
}

interface GitHubComment {
  author_association?: string;
  body?: string;
  html_url?: string;
  id?: number;
  updated_at?: string;
}

interface GitHubResponse<T> {
  data: T;
  headers: Headers;
}

class GitHubFrontierClient {
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
      throw new InfrastructureError([
        {
          code: "GITHUB_API_UNREACHABLE",
          message: "Unable to reach GitHub while computing the Ticket frontier.",
        },
      ]);
    }
    if (response.status !== 200) {
      throw new InfrastructureError([
        {
          code: "GITHUB_API_FAILED",
          message: `GitHub frontier read failed with status ${response.status}.`,
        },
      ]);
    }
    try {
      return {
        data: (await response.json()) as T,
        headers: response.headers,
      };
    } catch {
      throw invalidGitHubResponse();
    }
  }
}

function frontierError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function invalidGitHubResponse(): InfrastructureError {
  return new InfrastructureError([
    {
      code: "GITHUB_API_INVALID_RESPONSE",
      message: "GitHub returned invalid Ticket frontier data.",
    },
  ]);
}

function validIssue(issue: GitHubIssue): boolean {
  return (
    typeof issue.id === "number" &&
    Number.isSafeInteger(issue.id) &&
    issue.id > 0 &&
    typeof issue.number === "number" &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    typeof issue.title === "string" &&
    (typeof issue.body === "string" || issue.body === null) &&
    typeof issue.updated_at === "string" &&
    typeof issue.html_url === "string" &&
    (issue.state === "open" || issue.state === "closed") &&
    Array.isArray(issue.labels) &&
    issue.labels.every(({ name }) => typeof name === "string") &&
    Array.isArray(issue.assignees)
  );
}

function validComment(comment: GitHubComment): boolean {
  return (
    typeof comment.id === "number" &&
    Number.isSafeInteger(comment.id) &&
    comment.id > 0 &&
    typeof comment.body === "string" &&
    typeof comment.updated_at === "string" &&
    typeof comment.html_url === "string" &&
    typeof comment.author_association === "string"
  );
}

async function listIssues(
  client: GitHubFrontierClient,
  repository: string,
): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  for (let page = 1; ; page += 1) {
    const response = await client.get<GitHubIssue[]>(
      `/repos/${repository}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.data)) {
      throw invalidGitHubResponse();
    }
    issues.push(...response.data);
    if (!/(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/iu.test(
      response.headers.get("link") ?? "",
    )) {
      return issues;
    }
  }
}

async function listComments(
  client: GitHubFrontierClient,
  repository: string,
  issueNumber: number,
): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = [];
  for (let page = 1; ; page += 1) {
    const response = await client.get<GitHubComment[]>(
      `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.data) || !response.data.every(validComment)) {
      throw invalidGitHubResponse();
    }
    comments.push(...response.data);
    if (!/(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/iu.test(
      response.headers.get("link") ?? "",
    )) {
      return comments;
    }
  }
}

async function readIssue(
  client: GitHubFrontierClient,
  repository: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  const { data } = await client.get<GitHubIssue>(
    `/repos/${repository}/issues/${issueNumber}`,
  );
  if (!validIssue(data)) {
    throw invalidGitHubResponse();
  }
  return data;
}

type ParentMembership =
  | { kind: "different"; parent: number }
  | { kind: "malformed" | "missing" | "multiple" }
  | { kind: "valid"; parent: number };

export function parseParentMembership(body: string): ParentMembership {
  const headings = [...body.matchAll(/^##[ \t]+Parent[ \t]*$/gmu)];
  if (headings.length === 0) {
    return { kind: "missing" };
  }
  if (headings.length > 1) {
    return { kind: "multiple" };
  }
  const heading = headings[0];
  const start = (heading?.index ?? 0) + (heading?.[0].length ?? 0);
  const remainder = body.slice(start);
  const nextHeading = remainder.search(/^##[ \t]+/mu);
  const section = (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
  const match = section.match(/^#([1-9][0-9]*)$/u);
  if (!match?.[1]) {
    return { kind: "malformed" };
  }
  return { kind: "valid", parent: Number(match[1]) };
}

function trustedComments(comments: GitHubComment[]): SpecCommentSnapshot[] {
  return comments
    .filter(
      (comment) =>
        trustedAssociations.has(comment.author_association ?? "") &&
        !auditMarkerPattern.test(comment.body ?? ""),
    )
    .map((comment) => ({
      authorAssociation: comment.author_association as
        | "COLLABORATOR"
        | "MEMBER"
        | "OWNER",
      body: comment.body as string,
      bodySha256: sha256(comment.body as string),
      id: comment.id as number,
      updatedAt: comment.updated_at as string,
      url: comment.html_url as string,
    }))
    .sort((left, right) => left.id - right.id);
}

function issueSnapshot(
  issue: GitHubIssue,
  comments: GitHubComment[],
): SpecIssueSnapshot {
  const body = issue.body ?? "";
  const title = issue.title as string;
  return {
    body,
    bodySha256: sha256(body),
    comments: trustedComments(comments),
    id: issue.id as number,
    number: issue.number as number,
    title,
    titleSha256: sha256(title),
    updatedAt: issue.updated_at as string,
    url: issue.html_url as string,
  };
}

function specSnapshot(
  parent: SpecIssueSnapshot,
  ticket: SpecIssueSnapshot,
): TicketSpecSnapshot {
  return {
    parent,
    specHash: sha256(canonicalJson({ parent, ticket })),
    ticket,
  };
}

function labelSet(issue: GitHubIssue): Set<string> {
  return new Set(
    (issue.labels ?? []).map(({ name }) =>
      (name ?? "").toLocaleLowerCase("en-US"),
    ),
  );
}

function classifyTicket(
  issue: GitHubIssue,
  config: ProjectConfig,
): { reasons: string[]; status: Exclude<TicketFrontierStatus, "excluded"> } {
  if (issue.state === "closed") {
    return { reasons: [], status: "complete" };
  }
  const labels = labelSet(issue);
  const missingLabels = [config.queue.readyLabel, config.queue.ownershipLabel]
    .filter((label) => !labels.has(label.toLocaleLowerCase("en-US")))
    .map((label) => `missing-label:${label}`);
  const reasons: string[] = [...missingLabels];
  if ((issue.assignees?.length ?? 0) > 0) {
    reasons.push("assigned");
  }
  const blockedBy = issue.issue_dependencies_summary?.blocked_by;
  if (typeof blockedBy !== "number" || blockedBy > 0) {
    reasons.push(
      typeof blockedBy === "number" ? `blocked-by:${blockedBy}` : "blocked-by:unknown",
    );
  }
  if (missingLabels.length > 0) {
    return { reasons, status: "awaiting-enrollment" };
  }
  return reasons.length > 0
    ? { reasons, status: "blocked" }
    : { reasons, status: "executable" };
}

export async function computeTicketFrontier(
  repositoryPath: string,
  parentNumber: number,
  configPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<FrontierResult> {
  if (!Number.isSafeInteger(parentNumber) || parentNumber <= 0) {
    throw frontierError(
      "PARENT_INVALID",
      "status requires a positive parent issue number.",
    );
  }
  const token = environment.GITHUB_TOKEN;
  if (!token) {
    throw frontierError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to compute the Ticket frontier.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  const [repository, config] = await Promise.all([
    resolveGitHubRepository(root),
    readProjectConfig(configPath ?? join(root, ".sandcastle", "config.json")),
  ]);
  const client = new GitHubFrontierClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    token,
  );
  const [parentIssue, parentComments, listedIssues] = await Promise.all([
    readIssue(client, repository, parentNumber),
    listComments(client, repository, parentNumber),
    listIssues(client, repository),
  ]);
  const parent = issueSnapshot(parentIssue, parentComments);
  const candidateNumbers = [
    ...new Set(
      listedIssues.flatMap((issue) =>
        issue.pull_request === undefined &&
        typeof issue.number === "number" &&
        issue.number !== parentNumber
          ? [issue.number]
          : [],
      ),
    ),
  ].sort((left, right) => left - right);
  const latestIssues = await Promise.all(
    candidateNumbers.map((number) => readIssue(client, repository, number)),
  );
  const tickets: FrontierTicket[] = [];
  for (const issue of latestIssues) {
    const number = issue.number as number;
    const membership = parseParentMembership(issue.body ?? "");
    if (membership.kind !== "valid" || membership.parent !== parentNumber) {
      tickets.push({
        number,
        reasons: [
          membership.kind === "valid"
            ? `different-parent:${membership.parent}`
            : `parent-${membership.kind}`,
        ],
        status: "excluded",
      });
      continue;
    }
    const comments = await listComments(client, repository, number);
    const snapshot = specSnapshot(parent, issueSnapshot(issue, comments));
    tickets.push({ number, snapshot, ...classifyTicket(issue, config) });
  }
  tickets.sort((left, right) => left.number - right.number);
  return {
    frontier: tickets
      .filter(({ status }) => status === "executable")
      .map(({ number }) => number),
    parent,
    repository,
    tickets,
  };
}

export async function readSpecSnapshot(path: string): Promise<TicketSpecSnapshot> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw frontierError(
      "SPEC_SNAPSHOT_INVALID",
      "Unable to read a valid spec snapshot.",
    );
  }
  if (!validSpecSnapshot(candidate)) {
    throw frontierError(
      "SPEC_SNAPSHOT_INVALID",
      "Unable to read a valid spec snapshot.",
    );
  }
  return candidate;
}

function validSnapshotComment(candidate: unknown): candidate is SpecCommentSnapshot {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const comment = candidate as Partial<SpecCommentSnapshot>;
  return (
    trustedAssociations.has(comment.authorAssociation ?? "") &&
    typeof comment.body === "string" &&
    !auditMarkerPattern.test(comment.body) &&
    comment.bodySha256 === sha256(comment.body) &&
    typeof comment.id === "number" &&
    Number.isSafeInteger(comment.id) &&
    comment.id > 0 &&
    typeof comment.updatedAt === "string" &&
    typeof comment.url === "string"
  );
}

function validIssueSnapshot(candidate: unknown): candidate is SpecIssueSnapshot {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const issue = candidate as Partial<SpecIssueSnapshot>;
  return (
    typeof issue.body === "string" &&
    issue.bodySha256 === sha256(issue.body) &&
    Array.isArray(issue.comments) &&
    issue.comments.every(validSnapshotComment) &&
    typeof issue.id === "number" &&
    Number.isSafeInteger(issue.id) &&
    issue.id > 0 &&
    typeof issue.number === "number" &&
    Number.isSafeInteger(issue.number) &&
    issue.number > 0 &&
    typeof issue.title === "string" &&
    issue.titleSha256 === sha256(issue.title) &&
    typeof issue.updatedAt === "string" &&
    typeof issue.url === "string"
  );
}

function validSpecSnapshot(candidate: unknown): candidate is TicketSpecSnapshot {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const snapshot = candidate as Partial<TicketSpecSnapshot>;
  return (
    validIssueSnapshot(snapshot.parent) &&
    validIssueSnapshot(snapshot.ticket) &&
    typeof snapshot.specHash === "string" &&
    snapshot.specHash ===
      sha256(
        canonicalJson({ parent: snapshot.parent, ticket: snapshot.ticket }),
      )
  );
}

export async function verifySpecSnapshot(
  repositoryPath: string,
  snapshot: TicketSpecSnapshot,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SpecVerificationResult> {
  if (!validSpecSnapshot(snapshot)) {
    throw frontierError(
      "SPEC_SNAPSHOT_INVALID",
      "Unable to verify an invalid spec snapshot.",
    );
  }
  const token = environment.GITHUB_TOKEN;
  if (!token) {
    throw frontierError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to verify the spec snapshot.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  const repository = await resolveGitHubRepository(root);
  const client = new GitHubFrontierClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    token,
  );
  const [parentIssue, parentComments, ticketIssue, ticketComments] =
    await Promise.all([
      readIssue(client, repository, snapshot.parent.number),
      listComments(client, repository, snapshot.parent.number),
      readIssue(client, repository, snapshot.ticket.number),
      listComments(client, repository, snapshot.ticket.number),
    ]);
  const current = specSnapshot(
    issueSnapshot(parentIssue, parentComments),
    issueSnapshot(ticketIssue, ticketComments),
  );
  if (current.specHash !== snapshot.specHash) {
    throw frontierError(
      "SPEC_CHANGED",
      "Trusted parent or Ticket specification facts changed after the snapshot was captured.",
    );
  }
  return {
    currentSpecHash: current.specHash,
    expectedSpecHash: snapshot.specHash,
    parent: snapshot.parent.number,
    ticket: snapshot.ticket.number,
    unchanged: true,
  };
}
