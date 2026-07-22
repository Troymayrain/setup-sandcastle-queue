import { randomUUID } from "node:crypto";
import { chmod, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
  readProjectConfig,
} from "../config.js";
import { resolveGitHubRepository } from "../github/configure.js";
import {
  hasNextGitHubPage,
  readBoundedGitHubResponseText,
} from "../github/response.js";
import { isGitObjectId } from "../git/object-id.js";
import { sha256 } from "../hash.js";
import { resolveRepositoryRoot } from "../git/repository.js";
import { hasExactShape, isRecord } from "../json.js";

const hashPattern = /^[a-f0-9]{64}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;
const sessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const eventIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const imagePattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;

export interface RunAuditSkillReceipt {
  ok: true;
  receiptId: string;
}

export interface RunAuditTicketEvidence {
  commit: string | null;
  reviewHead: string | null;
  sessionId: string;
  skills: {
    codeReview: RunAuditSkillReceipt | null;
    implement: RunAuditSkillReceipt | null;
    tdd: RunAuditSkillReceipt | null;
  };
  ticket: number;
  verificationHash: string | null;
}

export interface RunAuditReviewExecution {
  receiptId: string;
  sessionId: string;
}

export interface RunAuditReviewEvidence {
  axes: {
    Spec: RunAuditReviewExecution;
    Standards: RunAuditReviewExecution;
  } | null;
  findingCodes: string[];
  fix: RunAuditReviewExecution | null;
  phase:
    | "fix-1"
    | "fix-2"
    | "needs-human-fix"
    | "passed"
    | "review-0"
    | "review-1"
    | "review-2"
    | "review-only";
  verificationHash: string | null;
}

export type RunAuditOutcome =
  | "aborted"
  | "awaiting-enrollment"
  | "blocked"
  | "cancelled"
  | "checkpointed"
  | "completed-no-change"
  | "conflict"
  | "correction"
  | "failed"
  | "final-fix"
  | "final-review-findings"
  | "final-review-passed"
  | "needs-human-fix"
  | "partial"
  | "ready-for-final-review"
  | "stale-continuation"
  | "waiting-no-change";

export interface RunAuditInput {
  batch: {
    branch: string;
    id: string;
    parent: number;
  };
  correctionOf?: string;
  dependencies: {
    lockfile: string;
    runtimeSkills: string;
  };
  heads: {
    end: string;
    reviewed: string | null;
    start: string;
    targetBase: string;
  };
  outcome: RunAuditOutcome;
  predecessorRunId: string | null;
  runId: string;
  runtimeImage: string;
  review?: RunAuditReviewEvidence;
  schemaVersion: 1;
  tickets: RunAuditTicketEvidence[];
  timing: {
    finishedAt: string;
    startedAt: string;
  };
}

export interface RunAuditArtifact extends RunAuditInput {
  durationMs: number;
  eventId: string;
}

export interface RunAuditUploadRequest {
  name: string;
  path: string;
  retentionDays: number;
}

export interface RunAuditRuntime {
  uploadArtifact: (
    request: RunAuditUploadRequest,
  ) => Promise<{ artifactId: string }>;
}

export interface PublishedRunAudit {
  artifactId: string;
  artifactName: string;
  artifactSha256: string;
  commentTarget: {
    kind: "issue" | "pull-request";
    number: number;
  };
  eventId: string;
  retentionDays: number;
}

interface GitHubResponse<T> {
  data: T | null;
  headers: Headers;
}

interface GitHubPullRequest {
  head?: { ref?: string };
  number?: number;
}

interface RunAuditSummary extends RunAuditArtifact {
  artifact: {
    id: string;
    name: string;
    retentionDays: number;
    sha256: string;
  };
}

const outcomes = new Set<RunAuditOutcome>([
  "aborted",
  "awaiting-enrollment",
  "blocked",
  "cancelled",
  "checkpointed",
  "completed-no-change",
  "conflict",
  "correction",
  "failed",
  "final-fix",
  "final-review-findings",
  "final-review-passed",
  "needs-human-fix",
  "partial",
  "ready-for-final-review",
  "stale-continuation",
  "waiting-no-change",
]);

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validReceipt(value: unknown): value is RunAuditSkillReceipt | null {
  if (value === null) return true;
  return (
    hasExactShape(value, ["ok", "receiptId"]) &&
    value.ok === true &&
    typeof value.receiptId === "string" &&
    opaqueIdPattern.test(value.receiptId)
  );
}

function validTicketEvidence(value: unknown): value is RunAuditTicketEvidence {
  if (
    !hasExactShape(value, [
      "commit",
      "reviewHead",
      "sessionId",
      "skills",
      "ticket",
      "verificationHash",
    ]) ||
    !Number.isSafeInteger(value.ticket) ||
    (value.ticket as number) <= 0 ||
    typeof value.sessionId !== "string" ||
    !sessionIdPattern.test(value.sessionId) ||
    (value.commit !== null &&
      !isGitObjectId(value.commit)) ||
    (value.reviewHead !== null &&
      (typeof value.reviewHead !== "string" ||
        !isGitObjectId(value.reviewHead))) ||
    (value.verificationHash !== null &&
      (typeof value.verificationHash !== "string" ||
        !hashPattern.test(value.verificationHash))) ||
    !hasExactShape(value.skills, ["codeReview", "implement", "tdd"])
  ) {
    return false;
  }
  return (
    validReceipt(value.skills.codeReview) &&
    validReceipt(value.skills.implement) &&
    validReceipt(value.skills.tdd)
  );
}

function validReviewExecution(value: unknown): value is RunAuditReviewExecution {
  return (
    hasExactShape(value, ["receiptId", "sessionId"]) &&
    typeof value.receiptId === "string" &&
    opaqueIdPattern.test(value.receiptId) &&
    typeof value.sessionId === "string" &&
    sessionIdPattern.test(value.sessionId)
  );
}

function validReviewEvidence(value: unknown): value is RunAuditReviewEvidence {
  if (
    !hasExactShape(value, [
      "axes",
      "findingCodes",
      "fix",
      "phase",
      "verificationHash",
    ]) ||
    !new Set([
      "fix-1",
      "fix-2",
      "needs-human-fix",
      "passed",
      "review-0",
      "review-1",
      "review-2",
      "review-only",
    ]).has(value.phase as string) ||
    !Array.isArray(value.findingCodes) ||
    !value.findingCodes.every(
      (code) => typeof code === "string" && /^[A-Z][A-Z0-9_]{1,127}$/u.test(code),
    ) ||
    new Set(value.findingCodes).size !== value.findingCodes.length ||
    (value.verificationHash !== null &&
      (typeof value.verificationHash !== "string" ||
        !hashPattern.test(value.verificationHash))) ||
    (value.fix !== null && !validReviewExecution(value.fix))
  ) {
    return false;
  }
  if (value.axes === null) {
    return value.fix !== null && value.verificationHash === null;
  }
  return (
    value.fix === null &&
    value.verificationHash !== null &&
    hasExactShape(value.axes, ["Spec", "Standards"]) &&
    validReviewExecution(value.axes.Spec) &&
    validReviewExecution(value.axes.Standards) &&
    value.axes.Spec.sessionId !== value.axes.Standards.sessionId &&
    value.axes.Spec.receiptId !== value.axes.Standards.receiptId
  );
}

function validateAuditEvidence(candidate: unknown): asserts candidate is RunAuditInput {
  if (
    !hasExactShape(
      candidate,
      [
        "batch",
        "dependencies",
        "heads",
        "outcome",
        "predecessorRunId",
        "runId",
        "runtimeImage",
        "schemaVersion",
        "tickets",
        "timing",
      ],
      ["correctionOf", "review"],
    ) ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.runId !== "string" ||
    !runIdPattern.test(candidate.runId) ||
    (candidate.predecessorRunId !== null &&
      (typeof candidate.predecessorRunId !== "string" ||
        !runIdPattern.test(candidate.predecessorRunId) ||
        candidate.predecessorRunId === candidate.runId)) ||
    typeof candidate.runtimeImage !== "string" ||
    !imagePattern.test(candidate.runtimeImage) ||
    typeof candidate.outcome !== "string" ||
    !outcomes.has(candidate.outcome as RunAuditOutcome) ||
    !hasExactShape(candidate.batch, ["branch", "id", "parent"]) ||
    !Number.isSafeInteger(candidate.batch.parent) ||
    (candidate.batch.parent as number) <= 0 ||
    typeof candidate.batch.id !== "string" ||
    candidate.batch.id.match(
      new RegExp(
        `^p${candidate.batch.parent}-[a-f0-9]{12}-r[1-9][0-9]*$`,
        "u",
      ),
    ) === null ||
    candidate.batch.branch !== `sandcastle/${candidate.batch.id}` ||
    !hasExactShape(candidate.dependencies, ["lockfile", "runtimeSkills"]) ||
    typeof candidate.dependencies.lockfile !== "string" ||
    !hashPattern.test(candidate.dependencies.lockfile) ||
    typeof candidate.dependencies.runtimeSkills !== "string" ||
    !hashPattern.test(candidate.dependencies.runtimeSkills) ||
    !hasExactShape(candidate.heads, ["end", "reviewed", "start", "targetBase"]) ||
    typeof candidate.heads.start !== "string" ||
    !isGitObjectId(candidate.heads.start) ||
    typeof candidate.heads.end !== "string" ||
    !isGitObjectId(candidate.heads.end) ||
    typeof candidate.heads.targetBase !== "string" ||
    !isGitObjectId(candidate.heads.targetBase) ||
    (candidate.heads.reviewed !== null &&
      (typeof candidate.heads.reviewed !== "string" ||
        !isGitObjectId(candidate.heads.reviewed))) ||
    !hasExactShape(candidate.timing, ["finishedAt", "startedAt"]) ||
    !validDate(candidate.timing.startedAt) ||
    !validDate(candidate.timing.finishedAt) ||
    Date.parse(candidate.timing.finishedAt) < Date.parse(candidate.timing.startedAt) ||
    !Array.isArray(candidate.tickets) ||
    !candidate.tickets.every(validTicketEvidence) ||
    (candidate.review !== undefined && !validReviewEvidence(candidate.review)) ||
    (candidate.review !== undefined &&
      candidate.review.axes !== null &&
      candidate.heads.reviewed === null)
  ) {
    throw configurationError(
      "AUDIT_EVIDENCE_INVALID",
      "Run audit evidence must contain only validated host-produced fields.",
    );
  }

  const correctionOf = candidate.correctionOf;
  if (
    (candidate.outcome === "correction" &&
      (typeof correctionOf !== "string" || !eventIdPattern.test(correctionOf))) ||
    (candidate.outcome !== "correction" && correctionOf !== undefined)
  ) {
    throw configurationError(
      "AUDIT_CORRECTION_INVALID",
      "Correction audits must identify one prior immutable audit event.",
    );
  }

  const ticketNumbers = candidate.tickets.map(({ ticket }) => ticket);
  if (new Set(ticketNumbers).size !== ticketNumbers.length) {
    throw configurationError(
      "AUDIT_EVIDENCE_INVALID",
      "Run audit evidence cannot contain duplicate Ticket scopes.",
    );
  }
  const sessions = candidate.tickets.map(({ sessionId }) => sessionId);
  if (candidate.review?.axes) {
    sessions.push(
      candidate.review.axes.Spec.sessionId,
      candidate.review.axes.Standards.sessionId,
    );
  }
  if (candidate.review?.fix) sessions.push(candidate.review.fix.sessionId);
  if (new Set(sessions).size !== sessions.length) {
    throw configurationError(
      "AUDIT_SESSION_REUSED",
      "Each audited Ticket scope must use a unique session.",
    );
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function validateArtifactPath(
  repositoryPath: string,
  artifactPath: string,
): Promise<string> {
  const repositoryRoot = await realpath(
    await resolveRepositoryRoot(repositoryPath),
  );
  const resolvedArtifact = resolve(artifactPath);
  if (isWithin(repositoryRoot, resolvedArtifact)) {
    throw configurationError(
      "AUDIT_PATH_FORBIDDEN",
      "Run audit artifacts must be written outside the Git repository.",
    );
  }
  let artifactParent: string;
  try {
    artifactParent = await realpath(dirname(resolvedArtifact));
  } catch {
    throw infrastructureError(
      "AUDIT_ARTIFACT_WRITE_FAILED",
      "The external run audit artifact directory is unavailable.",
    );
  }
  if (isWithin(repositoryRoot, artifactParent)) {
    throw configurationError(
      "AUDIT_PATH_FORBIDDEN",
      "Run audit artifacts must be written outside the Git repository.",
    );
  }
  return resolvedArtifact;
}

class AuditGitHubClient {
  readonly #apiUrl: string;
  readonly #token: string;

  constructor(apiUrl: string, token: string) {
    this.#apiUrl = apiUrl.replace(/\/$/u, "");
    this.#token = token;
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    body: object | undefined,
    statuses: number[],
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
        "Unable to reach GitHub while publishing a run audit.",
      );
    }
    if (!statuses.includes(response.status)) {
      throw infrastructureError(
        method === "GET" ? "GITHUB_API_FAILED" : "GITHUB_API_WRITE_FAILED",
        `GitHub run audit ${method} failed with status ${response.status}.`,
      );
    }
    const source = await readBoundedGitHubResponseText(response);
    if (!source) return { data: null, headers: response.headers };
    try {
      return {
        data: JSON.parse(source) as T,
        headers: response.headers,
      };
    } catch {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid run audit data.",
      );
    }
  }

  get<T>(path: string): Promise<GitHubResponse<T>> {
    return this.request<T>("GET", path, undefined, [200]);
  }

  post<T>(path: string, body: object): Promise<GitHubResponse<T>> {
    return this.request<T>("POST", path, body, [201]);
  }
}

async function findBatchPullRequest(
  client: AuditGitHubClient,
  repository: string,
  branch: string,
): Promise<number | undefined> {
  for (let page = 1; ; page += 1) {
    const response = await client.get<GitHubPullRequest[]>(
      `/repos/${repository}/pulls?state=all&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.data)) {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid pull request data for the run audit.",
      );
    }
    const match = response.data.find(({ head }) => head?.ref === branch);
    if (match) {
      if (!Number.isSafeInteger(match.number) || (match.number ?? 0) <= 0) {
        throw infrastructureError(
          "GITHUB_API_INVALID_RESPONSE",
          "GitHub returned an invalid Batch pull request for the run audit.",
        );
      }
      return match.number;
    }
    if (response.data.length < 100 && !hasNextGitHubPage(response.headers)) {
      return undefined;
    }
  }
}

function repositoryFromEnvironment(environment: NodeJS.ProcessEnv): string | null {
  const repository = environment.GITHUB_REPOSITORY;
  return repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    ? repository
    : null;
}

function auditComment(summary: RunAuditSummary): string {
  return [
    `Run ${summary.runId} audit recorded with outcome \`${summary.outcome}\`.`,
    "",
    "<!-- sandcastle-run-audit",
    canonicalJson(summary).trimEnd(),
    "-->",
  ].join("\n");
}

export async function publishRunAudit(
  repositoryPath: string,
  configPath: string,
  input: RunAuditInput,
  artifactPath: string,
  runtime: RunAuditRuntime,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PublishedRunAudit> {
  validateAuditEvidence(input);
  const [config, resolvedArtifact, repository] = await Promise.all([
    readProjectConfig(configPath),
    validateArtifactPath(repositoryPath, artifactPath),
    repositoryFromEnvironment(environment) ??
      resolveGitHubRepository(repositoryPath),
  ]);
  const token = environment.GITHUB_TOKEN;
  if (!token) {
    throw configurationError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to publish a run audit.",
    );
  }

  const eventId = randomUUID();
  const artifact: RunAuditArtifact = {
    ...input,
    durationMs:
      Date.parse(input.timing.finishedAt) - Date.parse(input.timing.startedAt),
    eventId,
  };
  const source = canonicalJson(artifact);
  try {
    await writeFile(resolvedArtifact, source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(resolvedArtifact, 0o600);
  } catch {
    throw infrastructureError(
      "AUDIT_ARTIFACT_WRITE_FAILED",
      "Unable to create the immutable external run audit artifact.",
    );
  }

  const artifactName = `sandcastle-run-${input.runId}-audit`;
  let upload: { artifactId: string };
  try {
    upload = await runtime.uploadArtifact({
      name: artifactName,
      path: resolvedArtifact,
      retentionDays: config.audit.retentionDays,
    });
  } catch {
    throw infrastructureError(
      "AUDIT_ARTIFACT_UPLOAD_FAILED",
      "Unable to upload the sanitized run audit artifact.",
    );
  }
  if (!opaqueIdPattern.test(upload.artifactId)) {
    throw infrastructureError(
      "AUDIT_ARTIFACT_UPLOAD_INVALID",
      "The run audit uploader returned an invalid artifact identity.",
    );
  }

  const artifactSha256 = sha256(source);
  const summary: RunAuditSummary = {
    ...artifact,
    artifact: {
      id: upload.artifactId,
      name: artifactName,
      retentionDays: config.audit.retentionDays,
      sha256: artifactSha256,
    },
  };
  const client = new AuditGitHubClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    token,
  );
  const pullRequest = await findBatchPullRequest(
    client,
    repository,
    input.batch.branch,
  );
  const target = pullRequest ?? input.batch.parent;
  await client.post(`/repos/${repository}/issues/${target}/comments`, {
    body: auditComment(summary),
  });

  return {
    artifactId: upload.artifactId,
    artifactName,
    artifactSha256,
    commentTarget: {
      kind: pullRequest === undefined ? "issue" : "pull-request",
      number: target,
    },
    eventId,
    retentionDays: config.audit.retentionDays,
  };
}
