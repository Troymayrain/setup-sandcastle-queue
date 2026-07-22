import { join } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
  readProjectConfig,
} from "../config.js";
import {
  computeTicketFrontier,
  type FrontierResult,
} from "../github/frontier.js";
import { sha256 } from "../hash.js";
import { resolveRepositoryRoot } from "../installer/plan.js";

const workflowPath = "sandcastle.yml";
const activeBatchRef = "refs/heads/sandcastle/active";
const activeBatchRefPath = "heads/sandcastle%2Factive";
const activeRunStatuses = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);

interface GitHubResponse<T> {
  data: T | null;
  headers: Headers;
  status: number;
}

class BatchGitHubClient {
  readonly #apiUrl: string;
  readonly #token: string;

  constructor(apiUrl: string, token: string) {
    this.#apiUrl = apiUrl.replace(/\/$/u, "");
    this.#token = token;
  }

  async request<T>(
    method: "DELETE" | "GET" | "POST",
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
        "Unable to reach GitHub while starting a Batch.",
      );
    }
    if (!allowedStatuses.includes(response.status)) {
      throw infrastructureError(
        method === "GET" ? "GITHUB_API_FAILED" : "GITHUB_API_WRITE_FAILED",
        `GitHub Batch ${method === "GET" ? "read" : "write"} failed with status ${response.status}.`,
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
        "GitHub returned invalid Batch data.",
      );
    }
  }

  get<T>(path: string, allowedStatuses: number[] = [200]): Promise<GitHubResponse<T>> {
    return this.request<T>("GET", path, undefined, allowedStatuses);
  }

  post<T>(
    path: string,
    body: object,
    allowedStatuses: number[],
  ): Promise<GitHubResponse<T>> {
    return this.request<T>("POST", path, body, allowedStatuses);
  }

  delete(path: string, allowedStatuses: number[]): Promise<GitHubResponse<never>> {
    return this.request<never>("DELETE", path, undefined, allowedStatuses);
  }
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function clientFor(environment: NodeJS.ProcessEnv): BatchGitHubClient {
  const token = environment.GITHUB_TOKEN;
  if (!token) {
    throw configurationError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to start a Batch.",
    );
  }
  return new BatchGitHubClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    token,
  );
}

function hasNextPage(headers: Headers): boolean {
  return /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/iu.test(
    headers.get("link") ?? "",
  );
}

interface RepositoryBase {
  baseSha: string;
  defaultBranch: string;
}

async function readRepositoryBase(
  client: BatchGitHubClient,
  repository: string,
): Promise<RepositoryBase> {
  const metadata = await client.get<{ default_branch?: string }>(
    `/repos/${repository}`,
  );
  const defaultBranch = metadata.data?.default_branch;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
    throw infrastructureError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub repository metadata omitted the default branch.",
    );
  }
  const reference = await client.get<{ object?: { sha?: string } }>(
    `/repos/${repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
  );
  const baseSha = reference.data?.object?.sha;
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40,64}$/u.test(baseSha)) {
    throw infrastructureError(
      "GITHUB_API_INVALID_RESPONSE",
      "GitHub default-branch metadata omitted a valid commit SHA.",
    );
  }
  return { baseSha, defaultBranch };
}

async function activeRefExists(
  client: BatchGitHubClient,
  repository: string,
): Promise<boolean> {
  const response = await client.get(
    `/repos/${repository}/git/ref/${activeBatchRefPath}`,
    [200, 404],
  );
  return response.status === 200;
}

async function hasActiveWorkflowRun(
  client: BatchGitHubClient,
  repository: string,
): Promise<boolean> {
  for (let page = 1; ; page += 1) {
    const response = await client.get<{
      workflow_runs?: Array<{ status?: string }>;
    }>(
      `/repos/${repository}/actions/workflows/${workflowPath}/runs?per_page=100&page=${page}`,
    );
    const runs = response.data?.workflow_runs;
    if (
      !Array.isArray(runs) ||
      !runs.every(({ status }) => typeof status === "string")
    ) {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid workflow run data.",
      );
    }
    if (runs.some(({ status }) => activeRunStatuses.has(status as string))) {
      return true;
    }
    if (!hasNextPage(response.headers)) {
      return false;
    }
  }
}

async function hasOpenBatchPullRequest(
  client: BatchGitHubClient,
  repository: string,
): Promise<boolean> {
  for (let page = 1; ; page += 1) {
    const response = await client.get<Array<{ head?: { ref?: string } }>>(
      `/repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.data)) {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid pull request data.",
      );
    }
    if (
      response.data.some(({ head }) =>
        (head?.ref ?? "").startsWith("sandcastle/p"),
      )
    ) {
      return true;
    }
    if (!hasNextPage(response.headers)) {
      return false;
    }
  }
}

async function ensureNoActiveBatch(
  client: BatchGitHubClient,
  repository: string,
): Promise<void> {
  const [hasRef, hasRun, hasPullRequest] = await Promise.all([
    activeRefExists(client, repository),
    hasActiveWorkflowRun(client, repository),
    hasOpenBatchPullRequest(client, repository),
  ]);
  if (hasRef || hasRun || hasPullRequest) {
    throw configurationError(
      "BATCH_ALREADY_ACTIVE",
      "This repository already has a non-terminal Sandcastle Batch.",
    );
  }
}

export interface BatchStartPreview {
  baseSha: string;
  confirmationHash: string | null;
  defaultBranch: string;
  enrollmentCandidates: number[];
  executableTickets: number[];
  mode: "preview";
  ownershipLabel: string;
  parent: number;
  repository: string;
  selectedTickets: number[];
}

export interface BatchStartResult {
  baseSha: string;
  defaultBranch: string;
  enrolledTickets: number[];
  mode: "dispatched";
  parent: number;
  repository: string;
}

function confirmationPayload(
  preview: Omit<BatchStartPreview, "confirmationHash" | "mode">,
): object {
  return { schemaVersion: 1, ...preview };
}

export function parseEnrollmentSelection(value: string | undefined): number[] | null {
  if (value === undefined) {
    return null;
  }
  if (value === "none") {
    return [];
  }
  if (!/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/u.test(value)) {
    throw configurationError(
      "ENROLLMENT_SELECTION_INVALID",
      "--enroll requires comma-separated positive issue numbers or 'none'.",
    );
  }
  const selected = value.split(",").map(Number);
  if (
    selected.some((number) => !Number.isSafeInteger(number)) ||
    new Set(selected).size !== selected.length
  ) {
    throw configurationError(
      "ENROLLMENT_SELECTION_INVALID",
      "--enroll requires unique safe issue numbers.",
    );
  }
  return selected.sort((left, right) => left - right);
}

function enrollmentCandidates(
  frontier: FrontierResult,
  ownershipLabel: string,
): number[] {
  const ownershipReason = `missing-label:${ownershipLabel}`;
  return frontier.tickets
    .filter(
      ({ reasons, status }) =>
        status === "awaiting-enrollment" &&
        reasons.length === 1 &&
        reasons[0] === ownershipReason,
    )
    .map(({ number }) => number);
}

export async function createBatchStartPreview(
  repositoryPath: string,
  parent: number,
  configPath: string | undefined,
  selectedTickets: number[] | null,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BatchStartPreview> {
  const root = await resolveRepositoryRoot(repositoryPath);
  const [frontier, config] = await Promise.all([
    computeTicketFrontier(root, parent, configPath, environment),
    readProjectConfig(configPath ?? join(root, ".sandcastle", "config.json")),
  ]);
  const client = clientFor(environment);
  const [{ baseSha, defaultBranch }] = await Promise.all([
    readRepositoryBase(client, frontier.repository),
    ensureNoActiveBatch(client, frontier.repository),
  ]);
  const candidates = enrollmentCandidates(frontier, config.queue.ownershipLabel);
  const selection = selectedTickets ?? [];
  const invalidSelection = selection.filter(
    (ticket) => !candidates.includes(ticket),
  );
  if (invalidSelection.length > 0) {
    throw configurationError(
      "ENROLLMENT_SELECTION_STALE",
      "Selected Tickets are no longer exact ownership-only enrollment candidates.",
    );
  }
  if (
    selectedTickets !== null &&
    frontier.frontier.length === 0 &&
    selection.length === 0
  ) {
    throw configurationError(
      "BATCH_FRONTIER_EMPTY",
      "A Batch requires at least one currently or prospectively executable Ticket.",
    );
  }
  const previewWithoutHash = {
    baseSha,
    defaultBranch,
    enrollmentCandidates: candidates,
    executableTickets: frontier.frontier,
    ownershipLabel: config.queue.ownershipLabel,
    parent,
    repository: frontier.repository,
    selectedTickets: selection,
  };
  return {
    ...previewWithoutHash,
    confirmationHash:
      selectedTickets === null
        ? null
        : sha256(canonicalJson(confirmationPayload(previewWithoutHash))),
    mode: "preview",
  };
}

export async function applyBatchStart(
  preview: BatchStartPreview,
  confirmation: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BatchStartResult> {
  if (!preview.confirmationHash || confirmation !== preview.confirmationHash) {
    throw configurationError(
      "BATCH_START_NOT_CONFIRMED",
      "Batch start requires confirmation of the exact enrollment selection and base.",
    );
  }
  const expectedHash = sha256(
    canonicalJson(
      confirmationPayload({
        baseSha: preview.baseSha,
        defaultBranch: preview.defaultBranch,
        enrollmentCandidates: preview.enrollmentCandidates,
        executableTickets: preview.executableTickets,
        ownershipLabel: preview.ownershipLabel,
        parent: preview.parent,
        repository: preview.repository,
        selectedTickets: preview.selectedTickets,
      }),
    ),
  );
  if (expectedHash !== preview.confirmationHash) {
    throw configurationError(
      "BATCH_START_PREVIEW_INVALID",
      "Batch start preview content does not match its confirmation hash.",
    );
  }
  const client = clientFor(environment);
  for (const ticket of preview.selectedTickets) {
    await client.post(
      `/repos/${preview.repository}/issues/${ticket}/labels`,
      { labels: [preview.ownershipLabel] },
      [200],
    );
  }
  await client.post(
    `/repos/${preview.repository}/actions/workflows/${workflowPath}/dispatches`,
    {
      inputs: {
        base_sha: preview.baseSha,
        operation: "start",
        parent: String(preview.parent),
      },
      ref: preview.defaultBranch,
    },
    [204],
  );
  return {
    baseSha: preview.baseSha,
    defaultBranch: preview.defaultBranch,
    enrolledTickets: preview.selectedTickets,
    mode: "dispatched",
    parent: preview.parent,
    repository: preview.repository,
  };
}

export interface BatchMetadata {
  branch: string;
  id: string;
  initialRunId: string;
  originalBaseSha: string;
  parent: number;
  schemaVersion: 1;
  state: "processing";
  verifiedTickets: number[];
}

function createBatchMetadata(
  parent: number,
  baseSha: string,
  initialRunId: string,
  verifiedTickets: number[],
): BatchMetadata {
  if (!Number.isSafeInteger(parent) || parent <= 0) {
    throw configurationError(
      "BATCH_PARENT_INVALID",
      "Batch parent must be a positive safe issue number.",
    );
  }
  if (!/^[a-f0-9]{40,64}$/u.test(baseSha)) {
    throw configurationError(
      "BATCH_BASE_INVALID",
      "Batch base must be a complete Git commit SHA.",
    );
  }
  if (!/^[1-9][0-9]*$/u.test(initialRunId)) {
    throw configurationError(
      "BATCH_RUN_ID_INVALID",
      "Initial workflow run ID must be a positive decimal identifier.",
    );
  }
  const id = `p${parent}-${baseSha.slice(0, 12)}-r${initialRunId}`;
  return {
    branch: `sandcastle/${id}`,
    id,
    initialRunId,
    originalBaseSha: baseSha,
    parent,
    schemaVersion: 1,
    state: "processing",
    verifiedTickets,
  };
}

export async function initializeBatch(
  repositoryPath: string,
  parent: number,
  baseSha: string,
  initialRunId: string,
  configPath: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BatchMetadata> {
  const root = await resolveRepositoryRoot(repositoryPath);
  const frontier = await computeTicketFrontier(
    root,
    parent,
    configPath,
    environment,
  );
  if (frontier.frontier.length === 0) {
    throw configurationError(
      "BATCH_FRONTIER_EMPTY",
      "The runner found no executable Ticket after read-only label validation.",
    );
  }
  const client = clientFor(environment);
  const currentBase = await readRepositoryBase(client, frontier.repository);
  if (currentBase.baseSha !== baseSha) {
    throw configurationError(
      "BATCH_BASE_CHANGED",
      "The default branch changed after Batch start confirmation.",
    );
  }
  if (await activeRefExists(client, frontier.repository)) {
    throw configurationError(
      "BATCH_ALREADY_ACTIVE",
      "This repository already has a non-terminal Sandcastle Batch.",
    );
  }
  const metadata = createBatchMetadata(
    parent,
    baseSha,
    initialRunId,
    frontier.frontier,
  );
  const repositoryApiPath = `/repos/${frontier.repository}`;
  const active = await client.post(
    `${repositoryApiPath}/git/refs`,
    { ref: activeBatchRef, sha: baseSha },
    [201, 422],
  );
  if (active.status === 422) {
    throw configurationError(
      "BATCH_ALREADY_ACTIVE",
      "Another serialized start already acquired the repository Batch lock.",
    );
  }
  try {
    const branch = await client.post(
      `${repositoryApiPath}/git/refs`,
      { ref: `refs/heads/${metadata.branch}`, sha: baseSha },
      [201, 422],
    );
    if (branch.status === 422) {
      throw configurationError(
        "BATCH_BRANCH_CONFLICT",
        "The stable Batch branch already exists.",
      );
    }
  } catch (error) {
    await client.delete(
      `${repositoryApiPath}/git/refs/${activeBatchRefPath}`,
      [204],
    );
    throw error;
  }
  return metadata;
}
