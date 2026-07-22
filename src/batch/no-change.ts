import { ConfigurationError, InfrastructureError } from "../config.js";
import { resolveGitHubRepository } from "../github/configure.js";
import {
  hasNextGitHubPage,
  readBoundedGitHubResponseText,
} from "../github/response.js";
import { isGitObjectId } from "../git/object-id.js";
import { resolveRepositoryRoot } from "../git/repository.js";
import { readBoundedJsonFile } from "../json.js";
import { readBatchRunState } from "./github-run.js";
import {
  parseBatchNoChangeCompletion,
  parseTicketNoChangeAcceptance,
  parseTicketNoChangeCandidate,
  renderBatchNoChangeCompletion,
  renderTicketNoChangeAcceptance,
  renderTicketNoChangeCandidate,
  type BatchNoChangeCompletionRecord,
  type TicketNoChangeAcceptanceRecord,
  type TicketNoChangeCandidateRecord,
} from "./no-change-records.js";

interface GitHubComment {
  body?: string;
  id?: number;
}

interface GitHubIssue {
  number?: number;
  state?: string;
}

interface NoChangeGitHubResponse<T> {
  data: T | null;
  headers: Headers;
  status: number;
}

interface GitHubReference {
  object?: { sha?: string };
}

const batchIdPattern = /^p([1-9][0-9]*)-[a-f0-9]{12}-r[1-9][0-9]*$/u;
const activeBatchRefPath = "heads/sandcastle%2Factive";

export interface RecordTicketNoChangeOptions {
  batchId: string;
  expectedHead: string;
  sessionId: string;
  ticket: number;
}

export interface AcceptTicketNoChangeOptions {
  batchId: string;
  expectedHead: string;
  reason: string;
  sessionId?: string;
  ticket: number;
}

export interface CompleteNoChangeBatchOptions {
  batchId: string;
  expectedHead: string;
  reason: string;
}

export interface TicketNoChangeResult {
  batchId: string;
  head: string;
  sessionId: string;
  status: "accepted-no-change" | "waiting-no-change";
  ticket: number;
}

export interface BatchNoChangeResult {
  batchId: string;
  head: string;
  parent: number;
  status: "completed-no-change";
}

class NoChangeGitHubClient {
  readonly #apiUrl: string;
  readonly #token: string;

  constructor(apiUrl: string, token: string) {
    this.#apiUrl = apiUrl.replace(/\/$/u, "");
    this.#token = token;
  }

  async request<T>(
    method: "DELETE" | "GET" | "PATCH" | "POST",
    path: string,
    body: object | undefined,
    allowedStatuses: readonly number[],
  ): Promise<NoChangeGitHubResponse<T>> {
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
        "Unable to reach GitHub for a no-change decision.",
      );
    }
    if (!allowedStatuses.includes(response.status)) {
      throw infrastructureError(
        method === "GET" ? "GITHUB_API_FAILED" : "GITHUB_API_WRITE_FAILED",
        `GitHub no-change ${method} failed with status ${response.status}.`,
      );
    }
    const source = await readBoundedGitHubResponseText(response);
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
        "GitHub returned invalid no-change response JSON.",
      );
    }
  }

  delete<T>(path: string): Promise<NoChangeGitHubResponse<T>> {
    return this.request<T>("DELETE", path, undefined, [204]);
  }

  get<T>(
    path: string,
    allowedStatuses: readonly number[] = [200],
  ): Promise<NoChangeGitHubResponse<T>> {
    return this.request<T>("GET", path, undefined, allowedStatuses);
  }

  patch<T>(path: string, body: object): Promise<NoChangeGitHubResponse<T>> {
    return this.request<T>("PATCH", path, body, [200]);
  }

  post<T>(path: string, body: object): Promise<NoChangeGitHubResponse<T>> {
    return this.request<T>("POST", path, body, [201]);
  }
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function validSession(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function validReason(reason: string): boolean {
  return (
    reason === reason.trim() &&
    reason.length >= 8 &&
    reason.length <= 2_000 &&
    !reason.includes("\u0000")
  );
}

function environmentRepository(environment: NodeJS.ProcessEnv): string | undefined {
  const candidate = environment.GITHUB_REPOSITORY;
  return candidate && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(candidate)
    ? candidate
    : undefined;
}

function clientFor(environment: NodeJS.ProcessEnv): NoChangeGitHubClient {
  const token = environment.GITHUB_TOKEN;
  if (!token) {
    throw configurationError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required for a no-change decision.",
    );
  }
  return new NoChangeGitHubClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    token,
  );
}

async function context(
  repositoryPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<{
  client: NoChangeGitHubClient;
  repository: string;
  root: string;
}> {
  const root = await resolveRepositoryRoot(repositoryPath);
  const repository =
    environmentRepository(environment) ?? (await resolveGitHubRepository(root));
  return { client: clientFor(environment), repository, root };
}

async function listComments(
  client: NoChangeGitHubClient,
  repository: string,
  issue: number,
): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.get<GitHubComment[]>(
      `/repos/${repository}/issues/${issue}/comments?per_page=100&page=${page}`,
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
        "GitHub returned invalid no-change audit comments.",
      );
    }
    comments.push(...response.data);
    if (!hasNextGitHubPage(response.headers)) return comments;
  }
  throw infrastructureError(
    "GITHUB_API_INVALID_RESPONSE",
    "GitHub no-change comments exceeded the pagination bound.",
  );
}

function candidateMatches(
  record: TicketNoChangeCandidateRecord,
  options: {
    batchId: string;
    expectedHead: string;
    sessionId?: string;
    ticket: number;
  },
): boolean {
  return (
    record.batchId === options.batchId &&
    record.head === options.expectedHead &&
    (options.sessionId === undefined || record.sessionId === options.sessionId) &&
    record.ticket === options.ticket
  );
}

function acceptanceMatches(
  record: TicketNoChangeAcceptanceRecord,
  candidate: TicketNoChangeCandidateRecord,
  reason: string,
): boolean {
  return (
    record.batchId === candidate.batchId &&
    record.head === candidate.head &&
    record.sessionId === candidate.sessionId &&
    record.ticket === candidate.ticket &&
    record.reason === reason
  );
}

async function workflowInputs(
  operation: "accept-no-change" | "complete-no-change",
  expected: Record<string, string>,
  environment: NodeJS.ProcessEnv,
): Promise<{ actor: string; runId: string }> {
  if (
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !environment.GITHUB_EVENT_PATH ||
    !environment.GITHUB_ACTOR ||
    !environment.GITHUB_RUN_ID
  ) {
    throw configurationError(
      "NO_CHANGE_AUTHORIZATION_REQUIRED",
      "No-change decisions are allowed only from an explicit workflow_dispatch.",
    );
  }
  const result = await readBoundedJsonFile(
    environment.GITHUB_EVENT_PATH,
    1024 * 1024,
  );
  if (!result.ok && result.reason !== "invalid-json") {
    throw configurationError(
      "NO_CHANGE_AUTHORIZATION_REQUIRED",
      "Unable to verify the workflow_dispatch no-change decision.",
    );
  }
  if (!result.ok) {
    throw configurationError(
      "NO_CHANGE_AUTHORIZATION_REQUIRED",
      "The workflow_dispatch event payload is invalid.",
    );
  }
  const event = result.value;
  const inputs =
    event !== null && typeof event === "object" && !Array.isArray(event)
      ? (event as { inputs?: unknown }).inputs
      : undefined;
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw configurationError(
      "NO_CHANGE_AUTHORIZATION_REQUIRED",
      "The workflow_dispatch event omitted no-change inputs.",
    );
  }
  const values = inputs as Record<string, unknown>;
  if (
    values.operation !== operation ||
    Object.entries(expected).some(([name, value]) => values[name] !== value) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(environment.GITHUB_ACTOR) ||
    !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID)
  ) {
    throw configurationError(
      "NO_CHANGE_AUTHORIZATION_REQUIRED",
      "No-change arguments do not match the workflow_dispatch decision.",
    );
  }
  return { actor: environment.GITHUB_ACTOR, runId: environment.GITHUB_RUN_ID };
}

export async function recordTicketNoChange(
  repositoryPath: string,
  options: RecordTicketNoChangeOptions,
  configPath: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TicketNoChangeResult> {
  if (
    !isGitObjectId(options.expectedHead) ||
    !validSession(options.sessionId) ||
    !Number.isSafeInteger(options.ticket) ||
    options.ticket <= 0
  ) {
    throw configurationError(
      "NO_CHANGE_INPUT_INVALID",
      "No-change candidate identity is invalid.",
    );
  }
  const { client, repository, root } = await context(repositoryPath, environment);
  const state = await readBatchRunState(
    root,
    options.batchId,
    configPath,
    environment,
  );
  const ticket = state.tickets.find(({ number }) => number === options.ticket);
  if (
    state.remoteHead !== options.expectedHead ||
    (ticket?.status !== "executable" && ticket?.status !== "waiting-no-change")
  ) {
    throw configurationError(
      "NO_CHANGE_STATE_MISMATCH",
      "The Ticket is not an executable zero-diff candidate at the expected HEAD.",
    );
  }
  const comments = await listComments(client, repository, options.ticket);
  const candidates = comments
    .map(({ body }) => parseTicketNoChangeCandidate(body as string))
    .filter((record): record is TicketNoChangeCandidateRecord => record !== null);
  if (candidates.length > 1 || (candidates[0] && !candidateMatches(candidates[0], options))) {
    throw configurationError(
      "NO_CHANGE_RECORD_CONFLICT",
      "The Ticket has conflicting no-change candidate records.",
    );
  }
  const record: TicketNoChangeCandidateRecord = {
    batchId: options.batchId,
    head: options.expectedHead,
    schemaVersion: 1,
    sessionId: options.sessionId,
    ticket: options.ticket,
  };
  if (candidates.length === 0) {
    await client.post(`/repos/${repository}/issues/${options.ticket}/comments`, {
      body: renderTicketNoChangeCandidate(record),
    });
  }
  return {
    batchId: options.batchId,
    head: options.expectedHead,
    sessionId: options.sessionId,
    status: "waiting-no-change",
    ticket: options.ticket,
  };
}

export async function acceptTicketNoChange(
  repositoryPath: string,
  options: AcceptTicketNoChangeOptions,
  configPath: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TicketNoChangeResult> {
  if (
    !isGitObjectId(options.expectedHead) ||
    !Number.isSafeInteger(options.ticket) ||
    options.ticket <= 0 ||
    (options.sessionId !== undefined && !validSession(options.sessionId)) ||
    !validReason(options.reason)
  ) {
    throw configurationError(
      "NO_CHANGE_INPUT_INVALID",
      "A no-change acceptance requires valid identity and a bounded reason.",
    );
  }
  const identity = await workflowInputs(
    "accept-no-change",
    {
      batch_id: options.batchId,
      expected_head: options.expectedHead,
      reason: options.reason,
      ticket: String(options.ticket),
    },
    environment,
  );
  const { client, repository, root } = await context(repositoryPath, environment);
  const state = await readBatchRunState(
    root,
    options.batchId,
    configPath,
    environment,
  );
  if (state.remoteHead !== options.expectedHead) {
    throw configurationError(
      "NO_CHANGE_STATE_MISMATCH",
      "The Batch HEAD changed before no-change acceptance.",
    );
  }
  const [comments, issueResponse] = await Promise.all([
    listComments(client, repository, options.ticket),
    client.get<GitHubIssue>(`/repos/${repository}/issues/${options.ticket}`),
  ]);
  const issue = issueResponse.data;
  if (!issue || issue.number !== options.ticket || (issue.state !== "open" && issue.state !== "closed")) {
    throw infrastructureError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub omitted the no-change Ticket state.",
    );
  }
  const candidates = comments
    .map(({ body }) => parseTicketNoChangeCandidate(body as string))
    .filter((record): record is TicketNoChangeCandidateRecord => record !== null);
  const acceptances = comments
    .map(({ body }) => parseTicketNoChangeAcceptance(body as string))
    .filter((record): record is TicketNoChangeAcceptanceRecord => record !== null);
  const candidate = candidates[0];
  if (
    candidates.length !== 1 ||
    !candidate ||
    !candidateMatches(candidate, options) ||
    acceptances.length > 1 ||
    (acceptances[0] &&
      !acceptanceMatches(acceptances[0], candidate, options.reason))
  ) {
    throw configurationError(
      "NO_CHANGE_RECORD_CONFLICT",
      "The Ticket lacks one matching no-change candidate and acceptance chain.",
    );
  }
  if (issue.state === "closed" && acceptances.length === 0) {
    throw configurationError(
      "NO_CHANGE_RECORD_CONFLICT",
      "The no-change Ticket was closed without a valid acceptance record.",
    );
  }
  if (acceptances.length === 0) {
    const record: TicketNoChangeAcceptanceRecord = {
      actor: identity.actor,
      ...candidate,
      reason: options.reason,
      runId: identity.runId,
    };
    await client.post(`/repos/${repository}/issues/${options.ticket}/comments`, {
      body: renderTicketNoChangeAcceptance(record),
    });
  }
  if (issue.state === "open") {
    await client.patch(`/repos/${repository}/issues/${options.ticket}`, {
      state: "closed",
    });
  }
  return {
    batchId: options.batchId,
    head: options.expectedHead,
    sessionId: candidate.sessionId,
    status: "accepted-no-change",
    ticket: options.ticket,
  };
}

function completionMatches(
  record: BatchNoChangeCompletionRecord,
  options: CompleteNoChangeBatchOptions,
  parent: number,
): boolean {
  return (
    record.batchId === options.batchId &&
    record.head === options.expectedHead &&
    record.parent === parent &&
    record.reason === options.reason
  );
}

async function completedNoChangeResult(
  client: NoChangeGitHubClient,
  repository: string,
  options: CompleteNoChangeBatchOptions,
  parentNumber: number,
): Promise<BatchNoChangeResult> {
  const [comments, issueResponse] = await Promise.all([
    listComments(client, repository, parentNumber),
    client.get<GitHubIssue>(`/repos/${repository}/issues/${parentNumber}`),
  ]);
  const parent = issueResponse.data;
  const completions = comments
    .map(({ body }) => parseBatchNoChangeCompletion(body as string))
    .filter((record): record is BatchNoChangeCompletionRecord => record !== null);
  if (
    !parent ||
    parent.number !== parentNumber ||
    parent.state !== "closed" ||
    completions.length !== 1 ||
    !completionMatches(completions[0] as BatchNoChangeCompletionRecord, options, parentNumber)
  ) {
    throw configurationError(
      "BATCH_NO_CHANGE_RECORD_CONFLICT",
      "The released Batch lacks one matching completed no-change decision.",
    );
  }
  return {
    batchId: options.batchId,
    head: options.expectedHead,
    parent: parentNumber,
    status: "completed-no-change",
  };
}

async function releaseActiveBatch(
  client: NoChangeGitHubClient,
  repository: string,
  expectedHead: string,
): Promise<void> {
  const active = await client.get<GitHubReference>(
    `/repos/${repository}/git/ref/${activeBatchRefPath}`,
    [200, 404],
  );
  if (active.status === 404) return;
  if (active.data?.object?.sha !== expectedHead) {
    throw configurationError(
      "BATCH_NO_CHANGE_ACTIVE_REF_MISMATCH",
      "The active Batch ref no longer matches the Batch being completed.",
    );
  }
  await client.delete(
    `/repos/${repository}/git/refs/${activeBatchRefPath}`,
  );
}

export async function completeNoChangeBatch(
  repositoryPath: string,
  options: CompleteNoChangeBatchOptions,
  configPath: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BatchNoChangeResult> {
  const batchIdentity = options.batchId.match(batchIdPattern);
  if (
    !batchIdentity ||
    !isGitObjectId(options.expectedHead) ||
    !validReason(options.reason)
  ) {
    throw configurationError(
      "NO_CHANGE_INPUT_INVALID",
      "Batch no-change completion identity or reason is invalid.",
    );
  }
  const identity = await workflowInputs(
    "complete-no-change",
    {
      batch_id: options.batchId,
      expected_head: options.expectedHead,
      reason: options.reason,
    },
    environment,
  );
  const { client, repository, root } = await context(repositoryPath, environment);
  const active = await client.get<GitHubReference>(
    `/repos/${repository}/git/ref/${activeBatchRefPath}`,
    [200, 404],
  );
  const parentNumber = Number(batchIdentity[1]);
  if (active.status === 404) {
    return completedNoChangeResult(
      client,
      repository,
      options,
      parentNumber,
    );
  }
  if (active.data?.object?.sha !== options.expectedHead) {
    throw configurationError(
      "BATCH_NO_CHANGE_ACTIVE_REF_MISMATCH",
      "The active Batch ref does not match the Batch being completed.",
    );
  }
  const state = await readBatchRunState(
    root,
    options.batchId,
    configPath,
    environment,
  );
  if (
    state.remoteHead !== options.expectedHead ||
    state.remoteHead !== state.originalBaseSha ||
    !state.tickets.every(({ status }) =>
      status === "accepted-no-change" || status === "preexisting-complete",
    )
  ) {
    throw configurationError(
      "BATCH_NO_CHANGE_STATE_INVALID",
      "Batch completion requires all Tickets complete and no cumulative diff.",
    );
  }
  const [comments, issueResponse] = await Promise.all([
    listComments(client, repository, state.parent),
    client.get<GitHubIssue>(`/repos/${repository}/issues/${state.parent}`),
  ]);
  const parent = issueResponse.data;
  if (!parent || parent.number !== state.parent || (parent.state !== "open" && parent.state !== "closed")) {
    throw infrastructureError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub omitted the parent PRD state.",
    );
  }
  const completions = comments
    .map(({ body }) => parseBatchNoChangeCompletion(body as string))
    .filter((record): record is BatchNoChangeCompletionRecord => record !== null);
  if (
    completions.length > 1 ||
    (completions[0] &&
      !completionMatches(completions[0], options, state.parent)) ||
    (parent.state === "closed" && completions.length === 0)
  ) {
    throw configurationError(
      "BATCH_NO_CHANGE_RECORD_CONFLICT",
      "Parent PRD no-change completion state is inconsistent.",
    );
  }
  if (completions.length === 0) {
    const record: BatchNoChangeCompletionRecord = {
      actor: identity.actor,
      batchId: options.batchId,
      head: options.expectedHead,
      parent: state.parent,
      reason: options.reason,
      runId: identity.runId,
      schemaVersion: 1,
    };
    await client.post(`/repos/${repository}/issues/${state.parent}/comments`, {
      body: renderBatchNoChangeCompletion(record),
    });
  }
  if (parent.state === "open") {
    await client.patch(`/repos/${repository}/issues/${state.parent}`, {
      state: "closed",
    });
  }
  await releaseActiveBatch(client, repository, options.expectedHead);
  return {
    batchId: options.batchId,
    head: options.expectedHead,
    parent: state.parent,
    status: "completed-no-change",
  };
}
