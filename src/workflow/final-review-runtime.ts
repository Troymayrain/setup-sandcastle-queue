import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import type { RunAuditReviewEvidence } from "../audit/run.js";
import { ConfigurationError, InfrastructureError } from "../config.js";
import { createHostGitEnvironment } from "../git/environment.js";
import { isGitObjectId } from "../git/object-id.js";
import { readBoundedJsonFile } from "../json.js";
import {
  acceptHumanFinalFix,
  createFinalReviewProgress,
  executeFinalReviewStep,
  type AutomaticFinalFixInput,
  type AutomaticFinalFixResult,
  type FinalReviewCycleReviewInput,
  type FinalReviewCycleReviewResult,
  type FinalReviewPhase,
  type FinalReviewProgress,
} from "../final-review/fix.js";
import {
  acceptHumanBaseMerge,
  createFinalReviewBaseProgress,
  reconcileFinalReviewBase,
  recordFinalReviewBaseFailure,
  type FinalReviewBasePhase,
  type FinalReviewBaseProgress,
} from "../final-review/base.js";
import {
  dispatchFinalReview,
  runFinalReview,
  type CumulativeReviewSpecification,
  type FinalReviewAxisInput,
  type FinalReviewAxisResult,
  type FinalReviewDispatchInput,
  type FinalReviewState,
} from "../final-review/run.js";
import { resolveRepositoryRoot } from "../git/repository.js";
import { parseParentMembership } from "../github/frontier.js";
import { sha256 } from "../hash.js";
import {
  checkProtectedPaths,
  createSandboxPlan,
  executeObservedSandboxPlan,
  type SandboxAgentObservation,
  type SandboxMount,
} from "../sandbox/policy.js";
import { executeWorkflowCapability, type WorkflowOperation } from "./security.js";
import {
  hasNextGitHubPage,
  WorkflowGitHubClient,
} from "./github.js";

const batchIdPattern = /^p([1-9][0-9]*)-[a-f0-9]{12}-r[1-9][0-9]*$/u;
const imagePattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;
const progressMarker = /<!-- sandcastle-final-review-progress\n([\s\S]*?)\n-->/u;
const baseProgressMarker =
  /<!-- sandcastle-final-review-base-progress\n([\s\S]*?)\n-->/u;

interface GitHubIssue {
  body?: string | null;
  number?: number;
  pull_request?: unknown;
  state?: string;
  title?: string;
}

interface GitHubComment {
  body?: string;
  id?: number;
}

interface GitHubPullRequest {
  base?: { ref?: string; sha?: string };
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  number?: number;
  state?: string;
}

interface ReviewSnapshot {
  activeHead: string;
  defaultBranch: string;
  specification: CumulativeReviewSpecification;
  state: FinalReviewState;
}

interface FinalFixEvidenceEvent {
  kind: "skill-tool-result" | "workspace-change";
  ok?: true;
  sequence: number;
  skill?: "implement" | "tdd";
  toolCallId?: string;
}

interface FinalFixEvidence {
  events: FinalFixEvidenceEvent[];
  phase: "final-fix";
  schemaVersion: 1;
  sessionId: string;
  status: "fixed";
}

export interface WorkflowFinalReviewResult {
  basePhase: FinalReviewBasePhase;
  batchHead: string;
  batchId: string;
  phase: FinalReviewPhase;
  pullRequest: number;
  review: RunAuditReviewEvidence | null;
  reviewedHead: string | null;
  status: "advanced" | "dispatched" | "waiting-for-human";
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function validIssue(issue: GitHubIssue): boolean {
  return (
    Number.isSafeInteger(issue.number) &&
    (issue.number ?? 0) > 0 &&
    typeof issue.title === "string" &&
    (typeof issue.body === "string" || issue.body === null) &&
    (issue.state === "open" || issue.state === "closed")
  );
}

async function listIssues(client: WorkflowGitHubClient): Promise<GitHubIssue[]> {
  const issues: GitHubIssue[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.get<GitHubIssue[]>(
      `/repos/${client.repository}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.data) || !response.data.every(validIssue)) {
      throw infrastructureError(
        "FINAL_REVIEW_GITHUB_STATE_INVALID",
        "GitHub returned invalid issue state for cumulative final review.",
      );
    }
    issues.push(...response.data.filter(({ pull_request: pullRequest }) => !pullRequest));
    if (!hasNextGitHubPage(response.headers)) return issues;
  }
  throw infrastructureError(
    "FINAL_REVIEW_GITHUB_STATE_INVALID",
    "Final review issue pagination exceeded the supported bound.",
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
        "FINAL_REVIEW_GITHUB_STATE_INVALID",
        "GitHub returned invalid final review comments.",
      );
    }
    comments.push(...response.data);
    if (!hasNextGitHubPage(response.headers)) return comments;
  }
  throw infrastructureError(
    "FINAL_REVIEW_GITHUB_STATE_INVALID",
    "Final review comment pagination exceeded the supported bound.",
  );
}

function issueSpecification(
  parent: GitHubIssue,
  tickets: GitHubIssue[],
  comments: Map<number, GitHubComment[]>,
): CumulativeReviewSpecification {
  const specificationComments = (issue: number): string[] =>
    (comments.get(issue) ?? [])
      .map(({ body }) => body as string)
      .filter((body) => !/<!--\s*sandcastle(?::|-)/iu.test(body));
  const ticketNumbers = tickets
    .map(({ number }) => number as number)
    .sort((left, right) => left - right);
  const content = canonicalJson({
    parent: {
      body: parent.body ?? "",
      comments: specificationComments(parent.number as number),
      number: parent.number,
      title: parent.title,
    },
    tickets: tickets
      .map((ticket) => ({
        body: ticket.body ?? "",
        comments: specificationComments(ticket.number as number),
        number: ticket.number,
        title: ticket.title,
      }))
      .sort((left, right) => (left.number as number) - (right.number as number)),
  });
  return {
    content,
    marker: "sandcastle-final-review-spec",
    parent: parent.number as number,
    schemaVersion: 1,
    specHash: sha256(content),
    tickets: ticketNumbers,
  };
}

async function readReviewSnapshot(
  client: WorkflowGitHubClient,
  batchId: string,
  pullRequest: number,
): Promise<ReviewSnapshot> {
  const identity = batchId.match(batchIdPattern);
  if (!identity) {
    throw configurationError(
      "FINAL_REVIEW_INPUT_INVALID",
      "Final review requires a canonical Batch identity.",
    );
  }
  const parentNumber = Number(identity[1]);
  const branch = `sandcastle/${batchId}`;
  const [metadata, branchRef, activeRef, pull, issues] = await Promise.all([
    client.get<{ default_branch?: string }>(`/repos/${client.repository}`),
    client.get<{ object?: { sha?: string } }>(
      `/repos/${client.repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    ),
    client.get<{ object?: { sha?: string } }>(
      `/repos/${client.repository}/git/ref/heads/sandcastle%2Factive`,
    ),
    client.get<GitHubPullRequest>(
      `/repos/${client.repository}/pulls/${pullRequest}`,
    ),
    listIssues(client),
  ]);
  const defaultBranch = metadata.data?.default_branch;
  if (!defaultBranch) {
    throw infrastructureError(
      "FINAL_REVIEW_GITHUB_STATE_INVALID",
      "GitHub omitted the default branch during final review.",
    );
  }
  const baseRef = await client.get<{ object?: { sha?: string } }>(
    `/repos/${client.repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
  );
  const batchHead = branchRef.data?.object?.sha;
  const activeHead = activeRef.data?.object?.sha;
  const targetBase = baseRef.data?.object?.sha;
  const pullRequestState = pull.data;
  const parent = issues.find(({ number }) => number === parentNumber);
  const tickets = issues.filter((issue) => {
    if (issue.number === parentNumber) return false;
    const membership = parseParentMembership(issue.body ?? "");
    return membership.kind === "valid" && membership.parent === parentNumber;
  });
  if (
    !isGitObjectId(batchHead) ||
    !isGitObjectId(activeHead) ||
    !isGitObjectId(targetBase) ||
    !parent ||
    tickets.length === 0 ||
    !pullRequestState ||
    pullRequestState.number !== pullRequest ||
    pullRequestState.draft !== true ||
    pullRequestState.state !== "open" ||
    pullRequestState.head?.ref !== branch ||
    pullRequestState.head.sha !== batchHead ||
    pullRequestState.base?.ref !== defaultBranch
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_GITHUB_STATE_INVALID",
      "Authoritative Batch, PR, base, or Ticket state is invalid for final review.",
    );
  }
  const commentEntries = await Promise.all(
    [parent, ...tickets].map(async (issue) => [
      issue.number as number,
      await listComments(client, issue.number as number),
    ] as const),
  );
  const comments = new Map(commentEntries);
  return {
    activeHead: activeHead as string,
    defaultBranch,
    specification: issueSpecification(parent, tickets, comments),
    state: {
      batchHead: batchHead as string,
      batchId,
      parent: parentNumber,
      pullRequest: { draft: true, number: pullRequest },
      targetBase: targetBase as string,
      tickets: tickets
        .map(({ number, state }) => ({
          number: number as number,
          state: state as "closed" | "open",
        }))
        .sort((left, right) => left.number - right.number),
    },
  };
}

async function findBatchPullRequest(
  client: WorkflowGitHubClient,
  batchId: string,
): Promise<number> {
  const branch = `sandcastle/${batchId}`;
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.get<GitHubPullRequest[]>(
      `/repos/${client.repository}/pulls?state=open&per_page=100&page=${page}`,
    );
    if (!Array.isArray(response.data)) {
      throw infrastructureError(
        "FINAL_REVIEW_GITHUB_STATE_INVALID",
        "GitHub returned invalid pull requests for final review dispatch.",
      );
    }
    const match = response.data.find(({ head }) => head?.ref === branch);
    if (match) {
      if (!Number.isSafeInteger(match.number) || (match.number ?? 0) <= 0) {
        throw infrastructureError(
          "FINAL_REVIEW_GITHUB_STATE_INVALID",
          "The Batch pull request identity is invalid.",
        );
      }
      return match.number as number;
    }
    if (!hasNextGitHubPage(response.headers)) break;
  }
  throw configurationError(
    "FINAL_REVIEW_PULL_REQUEST_MISSING",
    "The completed Batch has no matching draft pull request.",
  );
}

function renderProgress(progress: FinalReviewProgress): string {
  return [
    `Final review advanced to \`${progress.phase}\` at ${progress.batchHead}.`,
    "",
    "<!-- sandcastle-final-review-progress",
    canonicalJson(progress).trimEnd(),
    "-->",
  ].join("\n");
}

function renderBaseProgress(progress: FinalReviewBaseProgress): string {
  return [
    `Final review base tracking is \`${progress.phase}\` at ${progress.targetBase}.`,
    "",
    "<!-- sandcastle-final-review-base-progress",
    canonicalJson(progress).trimEnd(),
    "-->",
  ].join("\n");
}

function latestReviewedHead(progress: FinalReviewProgress): string | null {
  for (let index = progress.history.length - 1; index >= 0; index -= 1) {
    const event = progress.history[index];
    if (event?.kind === "review") return event.reviewedHead;
  }
  return null;
}

function reviewAuditEvidence(
  progress: FinalReviewProgress,
): RunAuditReviewEvidence | null {
  const event = progress.history.at(-1);
  if (event?.kind === "review") {
    return {
      axes: {
        Spec: { ...event.axes.Spec },
        Standards: { ...event.axes.Standards },
      },
      findingCodes: [...event.findingCodes],
      fix: null,
      phase:
        progress.phase === "passed" || progress.phase === "needs-human-fix"
          ? progress.phase
          : event.phase,
      verificationHash: event.verificationHash,
    };
  }
  if (event?.kind === "automatic-fix") {
    return {
      axes: null,
      findingCodes: [],
      fix: { receiptId: event.receiptId, sessionId: event.sessionId },
      phase: event.phase,
      verificationHash: null,
    };
  }
  return null;
}

async function readProgress(
  client: WorkflowGitHubClient,
  pullRequest: number,
): Promise<FinalReviewProgress | null> {
  const comments = await listComments(client, pullRequest);
  const records = comments
    .map(({ body, id }) => {
      const source = (body as string).match(progressMarker)?.[1];
      if (!source) return null;
      try {
        return { id: id as number, progress: JSON.parse(source) as FinalReviewProgress };
      } catch {
        throw configurationError(
          "FINAL_REVIEW_PROGRESS_INVALID",
          "A managed final review progress marker contains invalid JSON.",
        );
      }
    })
    .filter(
      (record): record is { id: number; progress: FinalReviewProgress } =>
        record !== null,
    )
    .sort((left, right) => left.id - right.id);
  return records.at(-1)?.progress ?? null;
}

async function readBaseProgress(
  client: WorkflowGitHubClient,
  pullRequest: number,
): Promise<FinalReviewBaseProgress | null> {
  const comments = await listComments(client, pullRequest);
  const records = comments
    .map(({ body, id }) => {
      const source = (body as string).match(baseProgressMarker)?.[1];
      if (!source) return null;
      try {
        return {
          id: id as number,
          progress: JSON.parse(source) as FinalReviewBaseProgress,
        };
      } catch {
        throw configurationError(
          "FINAL_REVIEW_BASE_STATE_INVALID",
          "A managed final review base marker contains invalid JSON.",
        );
      }
    })
    .filter(
      (record): record is { id: number; progress: FinalReviewBaseProgress } =>
        record !== null,
    )
    .sort((left, right) => left.id - right.id);
  return records.at(-1)?.progress ?? null;
}

async function appendProgress(
  client: WorkflowGitHubClient,
  operation: WorkflowOperation,
  pullRequest: number,
  progress: FinalReviewProgress,
): Promise<void> {
  await executeWorkflowCapability(
    { boundary: "host", capability: "publish-audit", operation },
    () =>
      client.post(
        `/repos/${client.repository}/issues/${pullRequest}/comments`,
        { body: renderProgress(progress) },
      ),
  );
}

async function appendBaseProgress(
  client: WorkflowGitHubClient,
  operation: WorkflowOperation,
  pullRequest: number,
  progress: FinalReviewBaseProgress,
): Promise<void> {
  await executeWorkflowCapability(
    { boundary: "host", capability: "publish-audit", operation },
    () =>
      client.post(
        `/repos/${client.repository}/issues/${pullRequest}/comments`,
        { body: renderBaseProgress(progress) },
      ),
  );
}

async function dispatchOperation(
  client: WorkflowGitHubClient,
  operation: "final-fix" | "review-only",
  caller: WorkflowOperation,
  defaultBranch: string,
  input: FinalReviewDispatchInput,
): Promise<void> {
  await executeWorkflowCapability(
    { boundary: "host", capability: "dispatch-continuation", operation: caller },
    () =>
      client.post(
        `/repos/${client.repository}/actions/workflows/sandcastle.yml/dispatches`,
        {
          inputs: {
            batch_id: input.batchId,
            expected_head: input.batchHead,
            operation,
            pull_request: String(input.pullRequest),
          },
          ref: defaultBranch,
        },
        [204],
      ),
  );
}

function gitOutput(
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
        env: createHostGitEnvironment(options.environment),
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        if (error && !options.allowFailure) {
          reject(
            infrastructureError(
              "FINAL_REVIEW_GIT_FAILED",
              "A host Git operation failed during final review.",
            ),
          );
          return;
        }
        resolve({ exitCode, stdout });
      },
    );
  });
}

function authenticatedGitEnvironment(
  environment: NodeJS.ProcessEnv,
  token: string,
): NodeJS.ProcessEnv {
  return createHostGitEnvironment(environment, [
    [
      "http.https://github.com/.extraheader",
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    ],
  ]);
}

export interface AdvanceWorkflowBatchRefsOptions {
  batchId: string;
  beforeHead: string;
  environment: NodeJS.ProcessEnv;
  head: string;
  mode: "active-only" | "branch-and-active";
  observedActiveHead?: string;
}

/**
 * 推进受控 Batch ref；显式 lease 保证旧 Batch 不会覆盖另一个 active HEAD。
 */
export async function advanceWorkflowBatchRefs(
  repository: string,
  options: AdvanceWorkflowBatchRefsOptions,
): Promise<void> {
  if (
    !batchIdPattern.test(options.batchId) ||
    !isGitObjectId(options.beforeHead) ||
    !isGitObjectId(options.head) ||
    (options.mode === "active-only" &&
      (!isGitObjectId(options.observedActiveHead) ||
        (options.observedActiveHead !== options.beforeHead &&
          options.observedActiveHead !== options.head)))
  ) {
    throw configurationError(
      options.mode === "active-only"
        ? "FINAL_REVIEW_ACTIVE_REF_MISMATCH"
        : "FINAL_REVIEW_BATCH_ADVANCE_INVALID",
      "Batch ref advancement requires the exact prior and next HEADs.",
    );
  }
  const token = options.environment.GITHUB_TOKEN;
  const repositoryName = options.environment.GITHUB_REPOSITORY;
  if (!token || !repositoryName) {
    throw configurationError(
      "GITHUB_TOKEN_MISSING",
      "Batch ref advancement requires the job-scoped GitHub identity.",
    );
  }
  const branch = `refs/heads/sandcastle/${options.batchId}`;
  const active = "refs/heads/sandcastle/active";
  const arguments_ =
    options.mode === "branch-and-active"
      ? [
          "push",
          "--atomic",
          "--porcelain",
          `--force-with-lease=${branch}:${options.beforeHead}`,
          `--force-with-lease=${active}:${options.beforeHead}`,
          `https://github.com/${repositoryName}.git`,
          `${options.head}:${branch}`,
          `${options.head}:${active}`,
        ]
      : [
          "push",
          "--porcelain",
          `--force-with-lease=${active}:${options.observedActiveHead}`,
          `https://github.com/${repositoryName}.git`,
          `${options.head}:${active}`,
        ];
  await new Promise<void>((resolve, reject) => {
    execFile(
      "git",
      arguments_,
      {
        cwd: repository,
        env: authenticatedGitEnvironment(options.environment, token),
        timeout: 60_000,
      },
      (error) => {
        if (error) {
          reject(
            infrastructureError(
              "FINAL_REVIEW_BATCH_ADVANCE_FAILED",
              "Unable to advance the leased Batch refs.",
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

function assertActiveBatchHead(observed: string, expected: string): void {
  if (observed !== expected) {
    throw configurationError(
      "FINAL_REVIEW_ACTIVE_REF_MISMATCH",
      "The active Batch ref does not match the reviewed Batch state.",
    );
  }
}

async function advanceReviewedBatchHead(
  repository: string,
  batchId: string,
  beforeHead: string,
  head: string,
  observedActiveHead: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await executeWorkflowCapability(
    {
      boundary: "host",
      capability: "advance-batch",
      operation: "review-only",
    },
    () =>
      advanceWorkflowBatchRefs(repository, {
        batchId,
        beforeHead,
        environment,
        head,
        mode: "active-only",
        observedActiveHead,
      }),
  );
}

async function reconcileWorkflowBase(
  repository: string,
  progress: FinalReviewBaseProgress,
  snapshot: ReviewSnapshot,
  client: WorkflowGitHubClient,
  environment: NodeJS.ProcessEnv,
): Promise<FinalReviewBaseProgress> {
  const batchRef = `refs/heads/sandcastle/${progress.batchId}`;
  const targetRef = `refs/remotes/origin/${snapshot.defaultBranch}`;
  await Promise.all([
    ensureGitCommit(repository, snapshot.state.batchHead, environment),
    ensureGitCommit(repository, snapshot.state.targetBase, environment),
  ]);
  await Promise.all([
    gitOutput(repository, ["update-ref", batchRef, snapshot.state.batchHead]),
    gitOutput(repository, ["update-ref", targetRef, snapshot.state.targetBase]),
  ]);
  return reconcileFinalReviewBase(
    repository,
    progress,
    { batchRef, targetRef },
    {
      async dispatchReplacementReview(input) {
        await dispatchOperation(
          client,
          "review-only",
          "review-only",
          snapshot.defaultBranch,
          input,
        );
      },
    },
  );
}

async function ensureGitCommit(
  repository: string,
  head: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const present = await gitOutput(
    repository,
    ["cat-file", "-e", `${head}^{commit}`],
    { allowFailure: true },
  );
  if (present.exitCode === 0) return;
  const token = environment.GITHUB_TOKEN;
  const repositoryName = environment.GITHUB_REPOSITORY;
  if (!token || !repositoryName) {
    throw configurationError(
      "FINAL_REVIEW_FETCH_IDENTITY_MISSING",
      "Final review cannot fetch the fixed Git commit without its job identity.",
    );
  }
  await new Promise<void>((resolve, reject) => {
    execFile(
      "git",
      [
        "fetch",
        "--no-tags",
        "--depth=1",
        `https://github.com/${repositoryName}.git`,
        head,
      ],
      {
        cwd: repository,
        env: authenticatedGitEnvironment(environment, token),
        timeout: 60_000,
      },
      (error) => {
        if (error) {
          reject(
            infrastructureError(
              "FINAL_REVIEW_FETCH_FAILED",
              "Unable to fetch a fixed final review commit.",
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

async function repositoryFingerprint(repository: string): Promise<string> {
  const [head, status, diff] = await Promise.all([
    gitOutput(repository, ["rev-parse", "HEAD"]),
    gitOutput(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    gitOutput(repository, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]),
  ]);
  return sha256(`${head.stdout}\u0000${status.stdout}\u0000${diff.stdout}`);
}

async function readBoundedJson(path: string): Promise<unknown> {
  const result = await readBoundedJsonFile(path, 1024 * 1024);
  if (!result.ok && result.reason === "unavailable") {
    throw configurationError(
      "FINAL_REVIEW_EVIDENCE_MISSING",
      "The final review Agent did not produce machine-readable evidence.",
    );
  }
  if (!result.ok && result.reason === "too-large") {
    throw configurationError(
      "FINAL_REVIEW_EVIDENCE_INVALID",
      "Final review evidence exceeds the supported file boundary.",
    );
  }
  if (!result.ok) {
    throw configurationError(
      "FINAL_REVIEW_EVIDENCE_INVALID",
      "Final review evidence is not valid JSON.",
    );
  }
  return result.value;
}

function axisEvidence(
  candidate: unknown,
  input: FinalReviewAxisInput,
  sessionId: string,
  observation: SandboxAgentObservation,
): FinalReviewAxisResult {
  const result = candidate as Partial<FinalReviewAxisResult>;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    result.axis !== input.axis ||
    result.reviewedHead !== input.reviewedHead ||
    result.specificationHash !== input.specification.specHash ||
    result.verificationHash !== input.verificationHash ||
    result.sessionId !== sessionId ||
    result.skill?.ok !== true ||
    typeof result.skill.receiptId !== "string" ||
    !observation.skillReceipts.some(
      ({ skill, toolCallId }) =>
        skill === "code-review" && toolCallId === result.skill?.receiptId,
    )
  ) {
    throw configurationError(
      "FINAL_REVIEW_SKILL_RECEIPT_MISSING",
      "Final review evidence does not match a host-observed code-review Skill result.",
    );
  }
  return result as FinalReviewAxisResult;
}

async function runReviewAxisSandbox(
  input: FinalReviewAxisInput,
  options: {
    configPath: string;
    environment: NodeJS.ProcessEnv;
    image: string;
  },
): Promise<FinalReviewAxisResult> {
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const scope = `final-review:${input.axis.toLocaleLowerCase("en-US")}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sandcastle-final-axis-"));
  const inputRoot = join(temporaryRoot, "input");
  const outputRoot = join(temporaryRoot, "output");
  await Promise.all([
    mkdir(inputRoot, { mode: 0o700 }),
    mkdir(outputRoot, { mode: 0o700 }),
  ]);
  const contractPath = join(inputRoot, "contract.json");
  const outputName = `final-review-${input.axis.toLocaleLowerCase("en-US")}.json`;
  const contract = {
    axis: input.axis,
    batchHead: input.batchHead,
    batchId: input.batchId,
    marker: "sandcastle-final-review-contract",
    reviewedHead: input.reviewedHead,
    schemaVersion: 1,
    sessionId,
    specification: input.specification,
    specificationHash: input.specification.specHash,
    targetBase: input.targetBase,
    verificationHash: input.verificationHash,
  };
  const scopedEnvironment: NodeJS.ProcessEnv = {
    ...options.environment,
    SANDCASTLE_BATCH_ID: input.batchId,
    SANDCASTLE_BROKER_BASE_URL:
      `http://sandcastle-broker:8081/batches/${encodeURIComponent(input.batchId)}/scopes/${encodeURIComponent(scope)}`,
    SANDCASTLE_SCOPE: scope,
    SANDCASTLE_SESSION_TOKEN: token,
  };
  const mounts: SandboxMount[] = [
    { readOnly: true, source: inputRoot, target: "/sandcastle/input" },
    { readOnly: false, source: outputRoot, target: "/sandcastle/output" },
  ];
  try {
    await writeFile(contractPath, canonicalJson(contract), { mode: 0o400 });
    await chmod(contractPath, 0o400);
    const before = await repositoryFingerprint(input.workspacePath);
    const plan = await createSandboxPlan(
      input.workspacePath,
      options.configPath,
      "agent",
      options.image,
      sessionId,
      [
        "sandcastle-queue",
        "final-review-driver",
        "--axis",
        input.axis,
        "--contract",
        "/sandcastle/input/contract.json",
        "--output",
        `/sandcastle/output/${outputName}`,
      ],
      scopedEnvironment,
      mounts,
    );
    const executed = await executeObservedSandboxPlan(
      plan,
      plan.planHash,
      scopedEnvironment,
    );
    if (executed.result.exitCode !== 0) {
      throw infrastructureError(
        "FINAL_REVIEW_AXIS_FAILED",
        "A cumulative final review axis exited unsuccessfully.",
      );
    }
    const after = await repositoryFingerprint(input.workspacePath);
    if (after !== before) {
      throw configurationError(
        "FINAL_REVIEW_MUTATED_WORKSPACE",
        "Cumulative final review must not modify the temporary merge workspace.",
      );
    }
    return axisEvidence(
      await readBoundedJson(join(outputRoot, outputName)),
      input,
      sessionId,
      executed.observation,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function validFinalFixEvent(value: unknown): value is FinalFixEvidenceEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<FinalFixEvidenceEvent>;
  if (!Number.isSafeInteger(event.sequence) || (event.sequence ?? 0) <= 0) return false;
  if (event.kind === "workspace-change") return true;
  return (
    event.kind === "skill-tool-result" &&
    event.ok === true &&
    (event.skill === "implement" || event.skill === "tdd") &&
    typeof event.toolCallId === "string"
  );
}

function finalFixEvidence(
  candidate: unknown,
  sessionId: string,
  observation: SandboxAgentObservation,
): { implement: string; tdd: string } {
  const evidence = candidate as Partial<FinalFixEvidence>;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    evidence.schemaVersion !== 1 ||
    evidence.phase !== "final-fix" ||
    evidence.status !== "fixed" ||
    evidence.sessionId !== sessionId ||
    !Array.isArray(evidence.events) ||
    !evidence.events.every(validFinalFixEvent)
  ) {
    throw configurationError(
      "FINAL_FIX_EVIDENCE_INVALID",
      "Automatic final fix evidence does not match the host-controlled session.",
    );
  }
  const implement = evidence.events.find(
    (event) => event.kind === "skill-tool-result" && event.skill === "implement",
  );
  const tdd = evidence.events.find(
    (event) => event.kind === "skill-tool-result" && event.skill === "tdd",
  );
  const observedImplement = observation.skillReceipts.find(
    ({ skill, toolCallId }) =>
      skill === "implement" && toolCallId === implement?.toolCallId,
  );
  const observedTdd = observation.skillReceipts.find(
    ({ skill, toolCallId }) => skill === "tdd" && toolCallId === tdd?.toolCallId,
  );
  if (
    !implement?.toolCallId ||
    !tdd?.toolCallId ||
    !observedImplement ||
    !observedTdd ||
    observedImplement.sequence >= observedTdd.sequence ||
    observation.firstWorkspaceChangeSequence === null ||
    observedTdd.sequence >= observation.firstWorkspaceChangeSequence
  ) {
    throw configurationError(
      "FINAL_FIX_SKILL_RECEIPT_MISSING",
      "Automatic final fix evidence does not match ordered host-observed implement and tdd Skill results.",
    );
  }
  return { implement: implement.toolCallId, tdd: tdd.toolCallId };
}

async function assertNoGitFilters(repository: string, beforeHead: string): Promise<void> {
  const [tracked, untracked] = await Promise.all([
    gitOutput(repository, [
      "diff",
      "--name-only",
      "--no-ext-diff",
      "--no-renames",
      "--no-textconv",
      "-z",
      beforeHead,
      "--",
    ]),
    gitOutput(repository, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ]);
  const paths = [...new Set(`${tracked.stdout}${untracked.stdout}`.split("\u0000").filter(Boolean))];
  if (paths.length === 0) {
    throw configurationError(
      "FINAL_FIX_NO_CHANGE",
      "Automatic final fix did not produce a repository change.",
    );
  }
  const attributes = await gitOutput(repository, ["check-attr", "-z", "filter", "--", ...paths]);
  const fields = attributes.stdout.split("\u0000").filter(Boolean);
  for (let index = 0; index < fields.length; index += 3) {
    const value = fields[index + 2];
    if (value !== "unspecified" && value !== "unset") {
      throw configurationError(
        "HOST_GIT_FILTER_FORBIDDEN",
        "Final fix paths cannot activate repository Git filters on the host.",
      );
    }
  }
}

function commitTree(
  repository: string,
  tree: string,
  parent: string,
  message: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["commit-tree", tree, "-p", parent], {
      cwd: repository,
      env: createHostGitEnvironment({
        ...process.env,
        GIT_AUTHOR_EMAIL: "sandcastle@example.invalid",
        GIT_AUTHOR_NAME: "Sandcastle Final Fix",
        GIT_COMMITTER_EMAIL: "sandcastle@example.invalid",
        GIT_COMMITTER_NAME: "Sandcastle Final Fix",
      }),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.once("error", () => reject(infrastructureError("FINAL_FIX_COMMIT_FAILED", "Unable to create the host-controlled final fix commit.")));
    child.once("close", (code) => {
      const head = stdout.trim();
      if (code !== 0 || !isGitObjectId(head)) {
        reject(infrastructureError("FINAL_FIX_COMMIT_FAILED", "Unable to create the host-controlled final fix commit."));
        return;
      }
      resolve(head);
    });
    child.stdin.end(message);
  });
}

async function publishFinalFix(
  repository: string,
  input: AutomaticFinalFixInput,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  await Promise.all([
    checkProtectedPaths(repository, input.batchHead),
    assertNoGitFilters(repository, input.batchHead),
  ]);
  await gitOutput(repository, ["add", "--all", "--"]);
  const tree = (await gitOutput(repository, ["write-tree"])).stdout.trim();
  if (!isGitObjectId(tree)) {
    throw infrastructureError(
      "FINAL_FIX_COMMIT_FAILED",
      "Unable to write the host-controlled final fix tree.",
    );
  }
  const head = await commitTree(
    repository,
    tree,
    input.batchHead,
    `Sandcastle final fix ${input.fixNumber} for ${input.batchId}\n`,
  );
  await gitOutput(repository, [
    "update-ref",
    `refs/heads/sandcastle/${input.batchId}`,
    head,
    input.batchHead,
  ]);
  await advanceWorkflowBatchRefs(repository, {
    batchId: input.batchId,
    beforeHead: input.batchHead,
    environment,
    head,
    mode: "branch-and-active",
  });
  return head;
}

async function runAutomaticFixSandbox(
  repository: string,
  input: AutomaticFinalFixInput,
  options: { configPath: string; environment: NodeJS.ProcessEnv; image: string },
): Promise<AutomaticFinalFixResult> {
  const sessionId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const scope = `final-fix:${input.fixNumber}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sandcastle-final-fix-"));
  const inputRoot = join(temporaryRoot, "input");
  const outputRoot = join(temporaryRoot, "output");
  await Promise.all([
    mkdir(inputRoot, { mode: 0o700 }),
    mkdir(outputRoot, { mode: 0o700 }),
  ]);
  const contractPath = join(inputRoot, "contract.json");
  const scopedEnvironment: NodeJS.ProcessEnv = {
    ...options.environment,
    SANDCASTLE_BATCH_ID: input.batchId,
    SANDCASTLE_BROKER_BASE_URL:
      `http://sandcastle-broker:8081/batches/${encodeURIComponent(input.batchId)}/scopes/${encodeURIComponent(scope)}`,
    SANDCASTLE_SCOPE: scope,
    SANDCASTLE_SESSION_TOKEN: token,
  };
  try {
    await writeFile(
      contractPath,
      canonicalJson({ ...input, marker: "sandcastle-final-fix-contract", schemaVersion: 1, sessionId }),
      { mode: 0o400 },
    );
    await chmod(contractPath, 0o400);
    const headBefore = (await gitOutput(repository, ["rev-parse", "HEAD"])).stdout.trim();
    const statusBefore = (await gitOutput(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).stdout;
    if (headBefore !== input.batchHead || statusBefore) {
      throw configurationError(
        "FINAL_FIX_WORKSPACE_INVALID",
        "Automatic final fix requires the clean fixed Batch HEAD.",
      );
    }
    const plan = await createSandboxPlan(
      repository,
      options.configPath,
      "agent",
      options.image,
      sessionId,
      [
        "sandcastle-queue",
        "final-fix-driver",
        "--contract",
        "/sandcastle/input/contract.json",
        "--output",
        "/sandcastle/output/final-fix.json",
      ],
      scopedEnvironment,
      [
        { readOnly: true, source: inputRoot, target: "/sandcastle/input" },
        { readOnly: false, source: outputRoot, target: "/sandcastle/output" },
      ],
    );
    const executed = await executeObservedSandboxPlan(
      plan,
      plan.planHash,
      scopedEnvironment,
    );
    if (executed.result.exitCode !== 0) {
      throw infrastructureError(
        "FINAL_FIX_AGENT_FAILED",
        "The bounded automatic final fix Agent exited unsuccessfully.",
      );
    }
    const receipts = finalFixEvidence(
      await readBoundedJson(join(outputRoot, "final-fix.json")),
      sessionId,
      executed.observation,
    );
    const headAfterAgent = (await gitOutput(repository, ["rev-parse", "HEAD"])).stdout.trim();
    if (headAfterAgent !== input.batchHead) {
      throw configurationError(
        "FINAL_FIX_AGENT_COMMIT_FORBIDDEN",
        "The final fix Agent cannot create commits.",
      );
    }
    const head = await executeWorkflowCapability(
      { boundary: "host", capability: "push", operation: "final-fix" },
      () => publishFinalFix(repository, input, options.environment),
    );
    return {
      auditEventId: randomUUID(),
      beforeHead: input.batchHead,
      head,
      marker: "sandcastle-final-fix-result",
      schemaVersion: 1,
      sessionId,
      skill: { ok: true, receiptId: receipts.implement },
      status: "fixed",
    };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function runFullReviewCycle(
  repository: string,
  input: FinalReviewCycleReviewInput,
  client: WorkflowGitHubClient,
  options: { configPath: string; environment: NodeJS.ProcessEnv; image: string },
): Promise<FinalReviewCycleReviewResult> {
  const snapshot = await readReviewSnapshot(client, input.batchId, input.pullRequest);
  assertActiveBatchHead(snapshot.activeHead, input.batchHead);
  const result = await runFinalReview(
    repository,
    {
      batchHead: input.batchHead,
      batchId: input.batchId,
      configPath: options.configPath,
      pullRequest: input.pullRequest,
      specification: snapshot.specification,
      targetBase: input.targetBase,
    },
    {
      async markPullRequestReady(mark) {
        await executeWorkflowCapability(
          { boundary: "host", capability: "update-pull-request", operation: "review-only" },
          () =>
            client.patch(`/repos/${client.repository}/pulls/${mark.pullRequest}`, {
              draft: false,
            }),
        );
      },
      async readState() {
        return (await readReviewSnapshot(client, input.batchId, input.pullRequest)).state;
      },
      async reviewAxis(axisInput) {
        return runReviewAxisSandbox(axisInput, options);
      },
    },
  );
  if (result.status === "tickets-changed") {
    throw configurationError(
      "FINAL_REVIEW_TICKETS_CHANGED",
      "Child Ticket state changed during final review; return the Batch to processing.",
    );
  }
  return {
    auditEventId: randomUUID(),
    axes: {
      Spec: {
        receiptId: result.axes.Spec.skill.receiptId,
        sessionId: result.axes.Spec.sessionId,
      },
      Standards: {
        receiptId: result.axes.Standards.skill.receiptId,
        sessionId: result.axes.Standards.sessionId,
      },
    },
    batchHead: result.batchHead,
    findings: result.status === "findings" ? result.actionableFindings : [],
    reviewedHead: result.reviewedHead,
    status: result.status,
    verificationHash: result.verificationHash,
  };
}

export async function dispatchWorkflowFinalReview(
  repositoryPath: string,
  batchId: string,
  environment: NodeJS.ProcessEnv,
): Promise<WorkflowFinalReviewResult> {
  const client = new WorkflowGitHubClient(environment);
  const pullRequest = await findBatchPullRequest(client, batchId);
  const snapshot = await readReviewSnapshot(client, batchId, pullRequest);
  assertActiveBatchHead(snapshot.activeHead, snapshot.state.batchHead);
  const result = await dispatchFinalReview(repositoryPath, batchId, {
    async dispatch(input) {
      const existing = await readProgress(client, pullRequest);
      if (!existing) {
        const progress = createFinalReviewProgress(input);
        await appendProgress(
          client,
          "process",
          pullRequest,
          progress,
        );
        await appendBaseProgress(
          client,
          "process",
          pullRequest,
          createFinalReviewBaseProgress(input),
        );
      }
      await dispatchOperation(
        client,
        "review-only",
        "process",
        snapshot.defaultBranch,
        input,
      );
    },
    async readState() {
      return snapshot.state;
    },
  });
  if (result.status !== "dispatched") {
    return {
      basePhase: "review",
      batchHead: snapshot.state.batchHead,
      batchId,
      phase: "review-0",
      pullRequest,
      review: null,
      reviewedHead: null,
      status: "waiting-for-human",
    };
  }
  return {
    basePhase: "review",
    batchHead: result.batchHead,
    batchId,
    phase: "review-0",
    pullRequest,
    review: null,
    reviewedHead: null,
    status: "dispatched",
  };
}

export interface RunWorkflowFinalOperationOptions {
  batchId: string;
  configPath: string;
  environment: NodeJS.ProcessEnv;
  expectedHead: string;
  image: string;
  pullRequest: number;
  repositoryPath: string;
}

function validateOperationOptions(options: RunWorkflowFinalOperationOptions): void {
  if (
    !batchIdPattern.test(options.batchId) ||
    !isGitObjectId(options.expectedHead) ||
    !imagePattern.test(options.image) ||
    !Number.isSafeInteger(options.pullRequest) ||
    options.pullRequest <= 0
  ) {
    throw configurationError(
      "FINAL_REVIEW_INPUT_INVALID",
      "Final review operation requires fixed Batch, HEAD, PR, config, and image inputs.",
    );
  }
}

export async function runWorkflowFinalReview(
  options: RunWorkflowFinalOperationOptions,
): Promise<WorkflowFinalReviewResult> {
  validateOperationOptions(options);
  const root = await resolveRepositoryRoot(options.repositoryPath);
  const client = new WorkflowGitHubClient(options.environment);
  const snapshot = await readReviewSnapshot(client, options.batchId, options.pullRequest);
  if (snapshot.state.batchHead !== options.expectedHead) {
    throw configurationError(
      "FINAL_REVIEW_HEAD_STALE",
      "Review-only input no longer matches the authoritative Batch HEAD.",
    );
  }
  let progress =
    (await readProgress(client, options.pullRequest)) ??
    createFinalReviewProgress({
      batchHead: snapshot.state.batchHead,
      batchId: options.batchId,
      pullRequest: options.pullRequest,
      targetBase: snapshot.state.targetBase,
    });
  let baseProgress =
    (await readBaseProgress(client, options.pullRequest)) ??
    createFinalReviewBaseProgress({
      batchHead: progress.batchHead,
      batchId: progress.batchId,
      pullRequest: progress.pullRequest,
      targetBase: progress.targetBase,
    });
  let observedActiveHead = snapshot.activeHead;

  if (baseProgress.phase === "needs-base-resolution") {
    if (snapshot.state.batchHead === baseProgress.batchHead) {
      assertActiveBatchHead(observedActiveHead, baseProgress.batchHead);
      return {
        basePhase: baseProgress.phase,
        batchHead: progress.batchHead,
        batchId: progress.batchId,
        phase: progress.phase,
        pullRequest: progress.pullRequest,
        review: reviewAuditEvidence(progress),
        reviewedHead: latestReviewedHead(progress),
        status: "waiting-for-human",
      };
    }
    const beforeHead = baseProgress.batchHead;
    baseProgress = await acceptHumanBaseMerge(root, baseProgress, {
      auditEventId: randomUUID(),
      head: snapshot.state.batchHead,
    });
    await advanceReviewedBatchHead(
      root,
      options.batchId,
      beforeHead,
      baseProgress.batchHead,
      observedActiveHead,
      options.environment,
    );
    observedActiveHead = baseProgress.batchHead;
    progress = {
      ...progress,
      batchHead: baseProgress.batchHead,
      pendingFindings: [],
      phase: "review-only",
      targetBase: baseProgress.targetBase,
    };
    await appendBaseProgress(
      client,
      "review-only",
      options.pullRequest,
      baseProgress,
    );
  } else if (progress.phase === "needs-human-fix") {
    if (snapshot.state.batchHead === progress.batchHead) {
      assertActiveBatchHead(observedActiveHead, progress.batchHead);
      return {
        basePhase: baseProgress.phase,
        batchHead: progress.batchHead,
        batchId: progress.batchId,
        phase: progress.phase,
        pullRequest: progress.pullRequest,
        review: reviewAuditEvidence(progress),
        reviewedHead: latestReviewedHead(progress),
        status: "waiting-for-human",
      };
    }
    const beforeHead = progress.batchHead;
    progress = await acceptHumanFinalFix(root, progress, {
      auditEventId: randomUUID(),
      beforeHead: progress.batchHead,
      head: snapshot.state.batchHead,
    });
    await advanceReviewedBatchHead(
      root,
      options.batchId,
      beforeHead,
      progress.batchHead,
      observedActiveHead,
      options.environment,
    );
    observedActiveHead = progress.batchHead;
    baseProgress = { ...baseProgress, batchHead: progress.batchHead };
    await appendBaseProgress(
      client,
      "review-only",
      options.pullRequest,
      baseProgress,
    );
  }

  assertActiveBatchHead(observedActiveHead, progress.batchHead);

  if (
    baseProgress.phase === "base-moving" ||
    baseProgress.phase === "needs-reconcile" ||
    baseProgress.phase === "verification-failed"
  ) {
    return {
      basePhase: baseProgress.phase,
      batchHead: progress.batchHead,
      batchId: progress.batchId,
      phase: progress.phase,
      pullRequest: progress.pullRequest,
      review: reviewAuditEvidence(progress),
      reviewedHead: latestReviewedHead(progress),
      status: "waiting-for-human",
    };
  }

  const beforeBase = canonicalJson(baseProgress);
  const reconciledBase = await reconcileWorkflowBase(
    root,
    baseProgress,
    snapshot,
    client,
    options.environment,
  );
  if (canonicalJson(reconciledBase) !== beforeBase) {
    await appendBaseProgress(
      client,
      "review-only",
      options.pullRequest,
      reconciledBase,
    );
  }
  const replacementDispatched =
    baseProgress.phase !== "replacement-review" &&
    reconciledBase.phase === "replacement-review";
  baseProgress = reconciledBase;
  if (
    replacementDispatched ||
    baseProgress.phase === "base-moving" ||
    baseProgress.phase === "needs-reconcile"
  ) {
    return {
      basePhase: baseProgress.phase,
      batchHead: progress.batchHead,
      batchId: progress.batchId,
      phase: progress.phase,
      pullRequest: progress.pullRequest,
      review: reviewAuditEvidence(progress),
      reviewedHead: latestReviewedHead(progress),
      status: replacementDispatched ? "dispatched" : "waiting-for-human",
    };
  }
  progress = {
    ...progress,
    batchHead: baseProgress.batchHead,
    targetBase: baseProgress.targetBase,
  };
  try {
    progress = await executeFinalReviewStep(progress, {
      async runAutomaticFix() {
        throw configurationError(
          "FINAL_FIX_OPERATION_REQUIRED",
          "Automatic final fixes run only in the dedicated final-fix operation.",
        );
      },
      async runFullReview(input) {
        return runFullReviewCycle(root, input, client, options);
      },
    });
  } catch (error) {
    const code =
      error instanceof InfrastructureError ? error.diagnostics[0]?.code : undefined;
    if (code === "FINAL_REVIEW_STATE_STALE") {
      const latest = await readReviewSnapshot(
        client,
        options.batchId,
        options.pullRequest,
      );
      const beforeRefresh = canonicalJson(baseProgress);
      baseProgress = await reconcileWorkflowBase(
        root,
        baseProgress,
        latest,
        client,
        options.environment,
      );
      if (canonicalJson(baseProgress) !== beforeRefresh) {
        await appendBaseProgress(
          client,
          "review-only",
          options.pullRequest,
          baseProgress,
        );
      }
      return {
        basePhase: baseProgress.phase,
        batchHead: progress.batchHead,
        batchId: progress.batchId,
        phase: progress.phase,
        pullRequest: progress.pullRequest,
        review: reviewAuditEvidence(progress),
        reviewedHead: latestReviewedHead(progress),
        status:
          baseProgress.phase === "replacement-review"
            ? "dispatched"
            : "waiting-for-human",
      };
    }
    if (
      code === "FINAL_REVIEW_MERGE_CONFLICT" ||
      code === "FINAL_REVIEW_VERIFICATION_FAILED"
    ) {
      baseProgress = recordFinalReviewBaseFailure(baseProgress, code);
      await appendBaseProgress(
        client,
        "review-only",
        options.pullRequest,
        baseProgress,
      );
      return {
        basePhase: baseProgress.phase,
        batchHead: progress.batchHead,
        batchId: progress.batchId,
        phase: progress.phase,
        pullRequest: progress.pullRequest,
        review: reviewAuditEvidence(progress),
        reviewedHead: latestReviewedHead(progress),
        status: "waiting-for-human",
      };
    }
    throw error;
  }
  await appendProgress(client, "review-only", options.pullRequest, progress);
  if (progress.phase === "fix-1" || progress.phase === "fix-2") {
    await dispatchOperation(
      client,
      "final-fix",
      "review-only",
      snapshot.defaultBranch,
      progress,
    );
  }
  return {
    basePhase: baseProgress.phase,
    batchHead: progress.batchHead,
    batchId: progress.batchId,
    phase: progress.phase,
    pullRequest: progress.pullRequest,
    review: reviewAuditEvidence(progress),
    reviewedHead: latestReviewedHead(progress),
    status:
      progress.phase === "needs-human-fix"
        ? "waiting-for-human"
        : progress.phase === "fix-1" || progress.phase === "fix-2"
          ? "dispatched"
          : "advanced",
  };
}

export async function runWorkflowFinalFix(
  options: RunWorkflowFinalOperationOptions,
): Promise<WorkflowFinalReviewResult> {
  validateOperationOptions(options);
  const root = await resolveRepositoryRoot(options.repositoryPath);
  const client = new WorkflowGitHubClient(options.environment);
  const snapshot = await readReviewSnapshot(client, options.batchId, options.pullRequest);
  const progress = await readProgress(client, options.pullRequest);
  let baseProgress = await readBaseProgress(client, options.pullRequest);
  if (
    !progress ||
    !baseProgress ||
    (progress.phase !== "fix-1" && progress.phase !== "fix-2") ||
    progress.batchHead !== options.expectedHead ||
    snapshot.state.batchHead !== options.expectedHead ||
    baseProgress.batchHead !== options.expectedHead ||
    snapshot.activeHead !== options.expectedHead ||
    (baseProgress.phase !== "review" &&
      baseProgress.phase !== "replacement-review" &&
      baseProgress.phase !== "review-only")
  ) {
    throw configurationError(
      "FINAL_FIX_STATE_INVALID",
      "The final-fix operation does not match a pending bounded fix phase.",
    );
  }
  const advanced = await executeFinalReviewStep(progress, {
    async runAutomaticFix(input) {
      return runAutomaticFixSandbox(root, input, options);
    },
    async runFullReview() {
      throw configurationError(
        "FINAL_REVIEW_OPERATION_REQUIRED",
        "Full review runs only in the dedicated review-only operation.",
      );
    },
  });
  baseProgress = { ...baseProgress, batchHead: advanced.batchHead };
  await appendProgress(client, "final-fix", options.pullRequest, advanced);
  await appendBaseProgress(
    client,
    "final-fix",
    options.pullRequest,
    baseProgress,
  );
  await dispatchOperation(
    client,
    "review-only",
    "final-fix",
    snapshot.defaultBranch,
    advanced,
  );
  return {
    basePhase: baseProgress.phase,
    batchHead: advanced.batchHead,
    batchId: advanced.batchId,
    phase: advanced.phase,
    pullRequest: advanced.pullRequest,
    review: reviewAuditEvidence(advanced),
    reviewedHead: latestReviewedHead(advanced),
    status: "dispatched",
  };
}
