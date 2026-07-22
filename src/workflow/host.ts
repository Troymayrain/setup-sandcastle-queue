import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  readProjectConfig,
} from "../config.js";
import { createHostGitEnvironment } from "../git/environment.js";
import { computeTicketFrontier, verifySpecSnapshot } from "../github/frontier.js";
import { isGitObjectId } from "../git/object-id.js";
import { resolveRepositoryRoot } from "../git/repository.js";
import { readBoundedJsonFile } from "../json.js";
import { processTicket } from "../ticket/process.js";
import { publishTicket } from "../ticket/publish.js";
import { runRemoteDoctor } from "../remote-doctor.js";
import { createHostBatchRuntime } from "../batch/host-runtime.js";
import { readBatchRunState } from "../batch/github-run.js";
import {
  acceptTicketNoChange,
  completeNoChangeBatch,
  recordTicketNoChange,
} from "../batch/no-change.js";
import type { RunAuditTicketEvidence } from "../audit/run.js";
import {
  executionLimits,
  runBatch,
  type BatchRunMode,
  type BatchTicketExecution,
} from "../batch/run.js";
import type { WorkflowOperation } from "./security.js";
import { createWorkflowRemoteDoctorRuntime } from "./remote-doctor-runtime.js";
import {
  dispatchWorkflowFinalReview,
  runWorkflowFinalFix,
  runWorkflowFinalReview,
} from "./final-review-runtime.js";
import { runWorkflowAbort } from "./abort-runtime.js";
import { runWorkflowFinalizeBatch } from "./finalize-runtime.js";
import { publishWorkflowRunAudit } from "./audit-runtime.js";

const batchIdPattern = /^p([1-9][0-9]*)-[a-f0-9]{12}-r[1-9][0-9]*$/u;
const imagePattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;

export interface WorkflowHostInvocation {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  repositoryPath: string;
}

export type WorkflowHostRuntime = Record<
  WorkflowOperation,
  (invocation: WorkflowHostInvocation) => Promise<unknown>
>;

export interface WorkflowHostCommandResult {
  operation: WorkflowOperation;
  result: unknown;
}

export interface WorkflowTicketExecution extends BatchTicketExecution {
  audit: RunAuditTicketEvidence;
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function optionValue(arguments_: string[], name: string): string | undefined {
  const matches = arguments_
    .map((value, index) => (value === name ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) return undefined;
  return arguments_[matches[0]! + 1];
}

function assertWorkflowContext(
  operation: string | undefined,
  environment: NodeJS.ProcessEnv,
): void {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.SANDCASTLE_OPERATION !== operation ||
    !environment.GITHUB_RUN_ID ||
    !/^[1-9][0-9]*$/u.test(environment.GITHUB_RUN_ID)
  ) {
    throw configurationError(
      "WORKFLOW_HOST_CONTEXT_INVALID",
      "The workflow host runs only inside its matching manual GitHub Actions job.",
    );
  }
}

async function assertDispatchInputs(
  environment: NodeJS.ProcessEnv,
  expected: Record<string, string>,
): Promise<void> {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw configurationError(
      "WORKFLOW_DISPATCH_INPUT_INVALID",
      "The workflow host cannot verify the workflow_dispatch event payload.",
    );
  }
  const result = await readBoundedJsonFile(eventPath, 1024 * 1024);
  if (!result.ok && result.reason !== "invalid-json") {
    throw configurationError(
      "WORKFLOW_DISPATCH_INPUT_INVALID",
      "The workflow host cannot verify the workflow_dispatch event payload.",
    );
  }
  if (!result.ok) {
    throw configurationError(
      "WORKFLOW_DISPATCH_INPUT_INVALID",
      "The workflow_dispatch event payload is invalid.",
    );
  }
  const candidate = result.value;
  const inputs =
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as { inputs?: unknown }).inputs
      : undefined;
  if (
    inputs === null ||
    typeof inputs !== "object" ||
    Array.isArray(inputs)
  ) {
    throw configurationError(
      "WORKFLOW_DISPATCH_INPUT_INVALID",
      "The workflow_dispatch event payload does not contain valid inputs.",
    );
  }
  if (
    Object.entries(expected).some(
      ([name, value]) => (inputs as Record<string, unknown>)[name] !== value,
    )
  ) {
    throw configurationError(
      "WORKFLOW_DISPATCH_INPUT_MISMATCH",
      "Workflow host arguments do not match the human workflow_dispatch decision.",
    );
  }
}

function parseMode(value: string | undefined): BatchRunMode {
  if (value === "start" || value === "process") return "process";
  if (value === "continue" || value === "continuation") return "continuation";
  if (value === "resume") return "resume";
  throw configurationError(
    "WORKFLOW_HOST_MODE_INVALID",
    "Process workflow hosting requires start, continue, or resume mode.",
  );
}

function testingSeam(body: string): string {
  const match = body.match(
    /^##[ \t]+Testing seam[ \t]*\r?\n+([\s\S]*?)(?=^##[ \t]+|\s*$)/imu,
  );
  const description = match?.[1]?.trim() ?? "";
  if (description.length < 8 || description.length > 2_000) {
    throw configurationError(
      "TESTING_SEAM_UNCONFIRMED",
      "The Ticket must contain a pre-confirmed `## Testing seam` section.",
    );
  }
  return description;
}

function gitHead(repository: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["rev-parse", "HEAD"],
      {
        cwd: repository,
        encoding: "utf8",
        env: createHostGitEnvironment(),
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error) {
          reject(
            configurationError(
              "WORKFLOW_HOST_REPOSITORY_INVALID",
              "The workflow host cannot read the checked-out Batch HEAD.",
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function lastReviewedHead(tickets: RunAuditTicketEvidence[]): string | null {
  for (let index = tickets.length - 1; index >= 0; index -= 1) {
    const reviewedHead = tickets[index]?.reviewHead;
    if (reviewedHead) return reviewedHead;
  }
  return null;
}

export async function runWorkflowTicketDriver(
  repositoryPath: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkflowTicketExecution> {
  const batchId = optionValue(arguments_, "--batch-id");
  const beforeHead = optionValue(arguments_, "--before-head");
  const ticketSource = optionValue(arguments_, "--ticket");
  const configPath = optionValue(arguments_, "--config");
  const image = optionValue(arguments_, "--image");
  const identity = batchId?.match(batchIdPattern);
  if (
    !identity ||
    !beforeHead ||
    !isGitObjectId(beforeHead) ||
    !ticketSource ||
    !/^[1-9][0-9]*$/u.test(ticketSource) ||
    !configPath ||
    !image ||
    !imagePattern.test(image) ||
    image !== environment.SANDCASTLE_CONTROL_PLANE_IMAGE
  ) {
    throw configurationError(
      "WORKFLOW_TICKET_INPUT_INVALID",
      "The Ticket driver requires one fixed Batch, Ticket, HEAD, config, and control-plane image.",
    );
  }
  const fixedBatchId = batchId as string;
  const fixedBeforeHead = beforeHead as string;
  const fixedConfigPath = configPath as string;
  const fixedImage = image as string;
  const ticket = Number(ticketSource);
  const parent = Number(identity[1]);
  const root = await resolveRepositoryRoot(repositoryPath);
  if ((await gitHead(root)) !== fixedBeforeHead) {
    throw configurationError(
      "WORKFLOW_TICKET_HEAD_MISMATCH",
      "The checked-out host workspace does not match the authoritative Batch HEAD.",
    );
  }
  const [frontier, state] = await Promise.all([
    computeTicketFrontier(root, parent, fixedConfigPath, environment),
    readBatchRunState(root, fixedBatchId, fixedConfigPath, environment),
  ]);
  const candidate = frontier.tickets.find(({ number }) => number === ticket);
  if (candidate?.status !== "executable" || !candidate.snapshot) {
    throw configurationError(
      "WORKFLOW_TICKET_NOT_EXECUTABLE",
      "The requested Ticket is no longer executable at the authoritative frontier.",
    );
  }
  const sessionRoot = await mkdtemp(join(tmpdir(), "sandcastle-workflow-ticket-"));
  const snapshotPath = join(sessionRoot, "snapshot.json");
  const seamPath = join(sessionRoot, "seam.json");
  const scope = `ticket:${ticket}`;
  const sessionToken = randomBytes(32).toString("base64url");
  const scopedEnvironment = {
    ...environment,
    SANDCASTLE_BATCH_ID: fixedBatchId,
    SANDCASTLE_BROKER_BASE_URL:
      `http://sandcastle-broker:8081/batches/${encodeURIComponent(fixedBatchId)}/scopes/${encodeURIComponent(scope)}`,
    SANDCASTLE_SCOPE: scope,
    SANDCASTLE_SESSION_TOKEN: sessionToken,
  };
  try {
    await Promise.all([
      writeFile(snapshotPath, canonicalJson(candidate.snapshot), {
        encoding: "utf8",
        mode: 0o400,
      }),
      writeFile(
        seamPath,
        canonicalJson({
          confirmed: true,
          description: testingSeam(candidate.snapshot.ticket.body),
          schemaVersion: 1,
        }),
        { encoding: "utf8", mode: 0o400 },
      ),
    ]);
    const processing = await processTicket(
      root,
      {
        agentDriver: ["sandcastle-queue", "agent-driver"],
        beforeHead: fixedBeforeHead,
        configPath: fixedConfigPath,
        image: fixedImage,
        seamPath,
        snapshotPath,
        ticket,
      },
      scopedEnvironment,
    );
    await verifySpecSnapshot(root, candidate.snapshot, environment);
    if (processing.status === "waiting-no-change") {
      const recorded = await recordTicketNoChange(
        root,
        {
          batchId: fixedBatchId,
          expectedHead: fixedBeforeHead,
          sessionId: processing.sessionId,
          ticket,
        },
        fixedConfigPath,
        environment,
      );
      return {
        audit: {
          commit: null,
          reviewHead: null,
          sessionId: processing.sessionId,
          skills: {
            codeReview: null,
            implement: { ok: true, receiptId: processing.toolCalls.implement },
            tdd: { ok: true, receiptId: processing.toolCalls.tdd },
          },
          ticket,
          verificationHash: null,
        },
        beforeHead: fixedBeforeHead,
        head: recorded.head,
        status: "waiting-no-change",
        ticket,
      };
    }
    const published = await publishTicket(
      root,
      {
        batch: {
          branch: state.branch,
          id: state.batchId,
          initialRunId: state.initialRunId,
          originalBaseSha: state.originalBaseSha,
          parent: state.parent,
          schemaVersion: 1,
          state: "processing",
          verifiedTickets: [ticket],
        },
        processing,
      },
      environment,
    );
    return {
      audit: {
        commit: published.commit,
        reviewHead: processing.head,
        sessionId: processing.sessionId,
        skills: {
          codeReview: {
            ok: true,
            receiptId: processing.toolCalls.codeReview,
          },
          implement: { ok: true, receiptId: processing.toolCalls.implement },
          tdd: { ok: true, receiptId: processing.toolCalls.tdd },
        },
        ticket,
        verificationHash: processing.verificationHash,
      },
      beforeHead: fixedBeforeHead,
      head: published.remoteHead,
      status: "published",
      ticket,
    };
  } finally {
    await rm(sessionRoot, { force: true, recursive: true });
  }
}

export async function runWorkflowHostCommand(
  repositoryPath: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
  runtime?: WorkflowHostRuntime,
): Promise<WorkflowHostCommandResult> {
  const operationSource = optionValue(arguments_, "--operation");
  const operation = new Set<WorkflowOperation>([
    "accept-no-change",
    "abort",
    "complete-no-change",
    "finalize-batch",
    "final-fix",
    "process",
    "remote-doctor",
    "review-only",
  ]).has(operationSource as WorkflowOperation)
    ? (operationSource as WorkflowOperation)
    : undefined;
  assertWorkflowContext(operation, environment);
  if (!operation) {
    throw configurationError(
      "WORKFLOW_HOST_OPERATION_INVALID",
      "This workflow host invocation does not name a supported operation.",
    );
  }
  const selectedRuntime = runtime ?? defaultWorkflowHostRuntime;
  const result = await selectedRuntime[operation]({
    arguments: arguments_,
    environment,
    repositoryPath,
  });
  return { operation, result };
}

async function runProcessOperation({
  arguments: arguments_,
  environment,
  repositoryPath,
}: WorkflowHostInvocation): Promise<
  Awaited<ReturnType<typeof runBatch>> & { audit: unknown; finalReview?: unknown }
> {
  const batchId = optionValue(arguments_, "--batch-id");
  const configPath = optionValue(arguments_, "--config") ?? ".sandcastle/config.json";
  const runId = environment.GITHUB_RUN_ID as string;
  if (!batchId || !batchIdPattern.test(batchId)) {
    throw configurationError(
      "WORKFLOW_HOST_ARGUMENT_MISSING",
      "Process workflow hosting requires a canonical --batch-id.",
    );
  }
  const modeSource = optionValue(arguments_, "--mode");
  const dispatchInputs: Record<string, string> = {
    operation: modeSource ?? "",
  };
  if (modeSource !== "start") dispatchInputs.batch_id = batchId;
  const expectedHead = optionValue(arguments_, "--expected-head");
  const predecessor = optionValue(arguments_, "--predecessor-run-id");
  if (expectedHead) dispatchInputs.expected_head = expectedHead;
  if (predecessor) dispatchInputs.predecessor_run_id = predecessor;
  await assertDispatchInputs(environment, dispatchInputs);
  const config = await readProjectConfig(configPath);
  const image = environment.SANDCASTLE_CONTROL_PLANE_IMAGE;
  if (!image || !imagePattern.test(image)) {
    throw configurationError(
      "WORKFLOW_HOST_IMAGE_INVALID",
      "The workflow must bind the exact control-plane image digest.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  await mkdir(environment.RUNNER_TEMP ?? tmpdir(), { recursive: true });
  const runtime = await createHostBatchRuntime(
    root,
    {
      configPath,
      ticketDriver: [
        "sandcastle-queue",
        "ticket-driver",
        "--config",
        configPath,
        "--image",
        image,
      ],
    },
    environment,
  );
  const startedAt =
    environment.SANDCASTLE_RUN_STARTED_AT ?? new Date().toISOString();
  const predecessorRunId =
    optionValue(arguments_, "--predecessor-run-id") || undefined;
  let result: Awaited<ReturnType<typeof runBatch>>;
  try {
    result = await runBatch(
      root,
      {
        batchId,
        expectedHead: optionValue(arguments_, "--expected-head") || undefined,
        limits: executionLimits(config),
        mode: parseMode(optionValue(arguments_, "--mode")),
        predecessorRunId,
        runId,
        startedAt,
      },
      runtime,
    );
  } catch (error) {
    const initial = runtime.initialState();
    const current = runtime.currentState();
    if (initial && current) {
      await publishWorkflowRunAudit({
        batchId,
        configPath,
        endHead: current.remoteHead,
        environment,
        finishedAt: new Date().toISOString(),
        outcome: "partial",
        predecessorRunId: predecessorRunId ?? null,
        repositoryPath: root,
        reviewedHead: lastReviewedHead(runtime.auditTickets()),
        runtimeImage: image,
        startHead: initial.remoteHead,
        startedAt,
        tickets: runtime.auditTickets(),
      }).catch(() => undefined);
    }
    throw error;
  }
  const initial = runtime.initialState();
  const current = runtime.currentState();
  if (!initial || !current) {
    throw configurationError(
      "WORKFLOW_HOST_STATE_MISSING",
      "The process host could not retain authoritative Batch state for audit.",
    );
  }
  const ticketAudit = runtime.auditTickets();
  const audit = await publishWorkflowRunAudit({
    batchId,
    configPath,
    endHead: current.remoteHead,
    environment,
    finishedAt: new Date().toISOString(),
    outcome: result.status,
    predecessorRunId: predecessorRunId ?? null,
    repositoryPath: root,
    reviewedHead: lastReviewedHead(ticketAudit),
    runtimeImage: image,
    startHead: initial.remoteHead,
    startedAt,
    tickets: ticketAudit,
  });
  if (result.status === "ready-for-final-review") {
    const finalReview = await dispatchWorkflowFinalReview(
      root,
      batchId,
      environment,
    );
    return { ...result, audit, finalReview };
  }
  return { ...result, audit };
}

async function runRemoteDoctorOperation({
  arguments: arguments_,
  environment,
  repositoryPath,
}: WorkflowHostInvocation): Promise<Awaited<ReturnType<typeof runRemoteDoctor>>> {
  const configPath = optionValue(arguments_, "--config") ?? ".sandcastle/config.json";
  const image = environment.SANDCASTLE_CONTROL_PLANE_IMAGE;
  if (!image || !imagePattern.test(image)) {
    throw configurationError(
      "WORKFLOW_HOST_IMAGE_INVALID",
      "Remote doctor requires the exact control-plane image digest.",
    );
  }
  await assertDispatchInputs(environment, { operation: "remote-doctor" });
  const runtime = await createWorkflowRemoteDoctorRuntime({
    configPath,
    environment,
    image,
    repositoryPath,
  });
  return runRemoteDoctor(repositoryPath, configPath, runtime, environment);
}

function finalOperationOptions(invocation: WorkflowHostInvocation) {
  const { arguments: arguments_, environment, repositoryPath } = invocation;
  const batchId = optionValue(arguments_, "--batch-id");
  const configPath = optionValue(arguments_, "--config") ?? ".sandcastle/config.json";
  const expectedHead = optionValue(arguments_, "--expected-head");
  const pullRequestSource = optionValue(arguments_, "--pull-request");
  const image = environment.SANDCASTLE_CONTROL_PLANE_IMAGE;
  if (
    !batchId ||
    !expectedHead ||
    !pullRequestSource ||
    !/^[1-9][0-9]*$/u.test(pullRequestSource) ||
    !image
  ) {
    throw configurationError(
      "FINAL_REVIEW_INPUT_INVALID",
      "Final review workflow hosting requires fixed Batch, HEAD, PR, config, and image inputs.",
    );
  }
  return {
    batchId,
    configPath,
    environment,
    expectedHead,
    image,
    pullRequest: Number(pullRequestSource),
    repositoryPath,
  };
}

async function runReviewOnlyOperation(
  invocation: WorkflowHostInvocation,
): Promise<
  Awaited<ReturnType<typeof runWorkflowFinalReview>> & { audit: unknown }
> {
  const options = finalOperationOptions(invocation);
  await assertDispatchInputs(invocation.environment, {
    batch_id: options.batchId,
    expected_head: options.expectedHead,
    operation: "review-only",
    pull_request: String(options.pullRequest),
  });
  const startedAt =
    invocation.environment.SANDCASTLE_RUN_STARTED_AT ?? new Date().toISOString();
  const result = await runWorkflowFinalReview(options);
  const audit = await publishWorkflowRunAudit({
    batchId: options.batchId,
    configPath: options.configPath,
    endHead: result.batchHead,
    environment: options.environment,
    finishedAt: new Date().toISOString(),
    outcome:
      result.phase === "passed"
        ? "final-review-passed"
        : result.phase === "needs-human-fix"
          ? "needs-human-fix"
          : "final-review-findings",
    predecessorRunId: null,
    repositoryPath: options.repositoryPath,
    ...(result.review ? { review: result.review } : {}),
    reviewedHead: result.reviewedHead,
    runtimeImage: options.image,
    startHead: options.expectedHead,
    startedAt,
    tickets: [],
  });
  return { ...result, audit };
}

async function runFinalFixOperation(
  invocation: WorkflowHostInvocation,
): Promise<Awaited<ReturnType<typeof runWorkflowFinalFix>> & { audit: unknown }> {
  const options = finalOperationOptions(invocation);
  await assertDispatchInputs(invocation.environment, {
    batch_id: options.batchId,
    expected_head: options.expectedHead,
    operation: "final-fix",
    pull_request: String(options.pullRequest),
  });
  const startedAt =
    invocation.environment.SANDCASTLE_RUN_STARTED_AT ?? new Date().toISOString();
  const result = await runWorkflowFinalFix(options);
  const audit = await publishWorkflowRunAudit({
    batchId: options.batchId,
    configPath: options.configPath,
    endHead: result.batchHead,
    environment: options.environment,
    finishedAt: new Date().toISOString(),
    outcome: "final-fix",
    predecessorRunId: null,
    repositoryPath: options.repositoryPath,
    ...(result.review ? { review: result.review } : {}),
    reviewedHead: result.reviewedHead,
    runtimeImage: options.image,
    startHead: options.expectedHead,
    startedAt,
    tickets: [],
  });
  return { ...result, audit };
}

async function runFinalizeBatchOperation({
  arguments: arguments_,
  environment,
}: WorkflowHostInvocation): Promise<
  Awaited<ReturnType<typeof runWorkflowFinalizeBatch>>
> {
  const batchId = optionValue(arguments_, "--batch-id");
  const expectedHead = optionValue(arguments_, "--expected-head");
  const pullRequestSource = optionValue(arguments_, "--pull-request");
  if (
    !batchId ||
    !expectedHead ||
    !pullRequestSource ||
    !/^[1-9][0-9]*$/u.test(pullRequestSource)
  ) {
    throw configurationError(
      "BATCH_FINALIZE_INPUT_INVALID",
      "Batch finalization requires fixed Batch, HEAD, and pull request inputs.",
    );
  }
  await assertDispatchInputs(environment, {
    batch_id: batchId,
    expected_head: expectedHead,
    operation: "finalize-batch",
    pull_request: pullRequestSource,
  });
  return runWorkflowFinalizeBatch({
    batchId,
    environment,
    expectedHead,
    pullRequest: Number(pullRequestSource),
  });
}

async function runAbortOperation({
  arguments: arguments_,
  environment,
  repositoryPath,
}: WorkflowHostInvocation): Promise<
  Awaited<ReturnType<typeof runWorkflowAbort>> & { audit: unknown }
> {
  const batchId = optionValue(arguments_, "--batch-id");
  const expectedHead = optionValue(arguments_, "--expected-head");
  const pullRequestSource = optionValue(arguments_, "--pull-request");
  const reason = optionValue(arguments_, "--reason");
  const actor = environment.GITHUB_ACTOR;
  const runId = environment.GITHUB_RUN_ID;
  const configPath = optionValue(arguments_, "--config") ?? ".sandcastle/config.json";
  const image = environment.SANDCASTLE_CONTROL_PLANE_IMAGE;
  if (
    !batchId ||
    !expectedHead ||
    !pullRequestSource ||
    !/^[1-9][0-9]*$/u.test(pullRequestSource) ||
    !reason ||
    !actor ||
    !runId ||
    !image
  ) {
    throw configurationError(
      "BATCH_ABORT_INPUT_INVALID",
      "Abort workflow hosting requires fixed Batch, HEAD, PR, actor, run, and reason inputs.",
    );
  }
  const startedAt =
    environment.SANDCASTLE_RUN_STARTED_AT ?? new Date().toISOString();
  await assertDispatchInputs(environment, {
    batch_id: batchId,
    expected_head: expectedHead,
    operation: "abort",
    pull_request: pullRequestSource,
    reason,
  });
  const result = await runWorkflowAbort({
    actor,
    batchId,
    environment,
    expectedHead,
    pullRequest: Number(pullRequestSource),
    reason,
    repositoryPath,
    runId,
  });
  const audit = await publishWorkflowRunAudit({
    batchId,
    configPath,
    endHead: expectedHead,
    environment,
    finishedAt: new Date().toISOString(),
    outcome: "aborted",
    predecessorRunId: null,
    repositoryPath,
    reviewedHead: null,
    runtimeImage: image,
    startHead: expectedHead,
    startedAt,
    tickets: [],
  });
  return { ...result, audit };
}

async function runAcceptNoChangeOperation({
  arguments: arguments_,
  environment,
  repositoryPath,
}: WorkflowHostInvocation): Promise<Awaited<ReturnType<typeof acceptTicketNoChange>>> {
  const batchId = optionValue(arguments_, "--batch-id");
  const configPath = optionValue(arguments_, "--config") ?? ".sandcastle/config.json";
  const expectedHead = optionValue(arguments_, "--expected-head");
  const reason = optionValue(arguments_, "--reason");
  const ticketSource = optionValue(arguments_, "--ticket");
  if (
    !batchId ||
    !expectedHead ||
    !reason ||
    !ticketSource ||
    !/^[1-9][0-9]*$/u.test(ticketSource)
  ) {
    throw configurationError(
      "NO_CHANGE_INPUT_INVALID",
      "Ticket no-change workflow hosting requires fixed Batch, Ticket, HEAD, config, and reason inputs.",
    );
  }
  return acceptTicketNoChange(
    repositoryPath,
    {
      batchId,
      expectedHead,
      reason,
      ticket: Number(ticketSource),
    },
    configPath,
    environment,
  );
}

async function runCompleteNoChangeOperation({
  arguments: arguments_,
  environment,
  repositoryPath,
}: WorkflowHostInvocation): Promise<Awaited<ReturnType<typeof completeNoChangeBatch>>> {
  const batchId = optionValue(arguments_, "--batch-id");
  const configPath = optionValue(arguments_, "--config") ?? ".sandcastle/config.json";
  const expectedHead = optionValue(arguments_, "--expected-head");
  const reason = optionValue(arguments_, "--reason");
  if (!batchId || !expectedHead || !reason) {
    throw configurationError(
      "NO_CHANGE_INPUT_INVALID",
      "Batch no-change workflow hosting requires fixed Batch, HEAD, config, and reason inputs.",
    );
  }
  return completeNoChangeBatch(
    repositoryPath,
    { batchId, expectedHead, reason },
    configPath,
    environment,
  );
}

const defaultWorkflowHostRuntime: WorkflowHostRuntime = {
  "accept-no-change": runAcceptNoChangeOperation,
  abort: runAbortOperation,
  "complete-no-change": runCompleteNoChangeOperation,
  "finalize-batch": runFinalizeBatchOperation,
  "final-fix": runFinalFixOperation,
  process: runProcessOperation,
  "remote-doctor": runRemoteDoctorOperation,
  "review-only": runReviewOnlyOperation,
};
