import { ConfigurationError, type ProjectConfig } from "../config.js";

const batchIdPattern = /^p([1-9][0-9]*)-([a-f0-9]{12})-r([1-9][0-9]*)$/u;
const completeStatuses = new Set<BatchRunTicketStatus>([
  "accepted-no-change",
  "preexisting-complete",
  "published",
]);

export type BatchRunMode = "continuation" | "process" | "resume";

export type BatchRunTicketStatus =
  | "accepted-no-change"
  | "awaiting-enrollment"
  | "blocked"
  | "conflict"
  | "executable"
  | "preexisting-complete"
  | "published"
  | "waiting-no-change";

export interface BatchRunTicket {
  number: number;
  reasons: string[];
  status: BatchRunTicketStatus;
}

export interface BatchRunState {
  activeHead: string;
  batchId: string;
  branch: string;
  defaultBranch: string;
  initialRunId: string;
  originalBaseSha: string;
  parent: number;
  remoteHead: string;
  tickets: BatchRunTicket[];
}

export interface BatchExecutionLimits {
  jobTimeoutMinutes: number;
  maxTicketsPerRun: number;
  minimumRemainingMinutes: number;
  processingBudgetMinutes: number;
  ticketTimeoutMinutes: number;
}

export interface RunBatchOptions {
  batchId: string;
  expectedHead?: string;
  limits: BatchExecutionLimits;
  mode: BatchRunMode;
  predecessorRunId?: string;
  runId: string;
  startedAt: string;
}

export interface BatchTicketExecution {
  beforeHead: string;
  head: string;
  status: "published" | "waiting-no-change";
  ticket: number;
}

export interface BatchTicketExecutionInput {
  batchId: string;
  beforeHead: string;
  number: number;
  signal: AbortSignal;
}

export interface ContinuationInput {
  batchId: string;
  expectedHead: string;
  predecessorRunId: string;
}

export interface RunBatchRuntime {
  dispatchContinuation: (input: ContinuationInput) => Promise<void> | void;
  now?: () => Date;
  processTicket: (
    input: BatchTicketExecutionInput,
  ) => Promise<BatchTicketExecution>;
  readState: (
    repositoryPath: string,
    batchId: string,
  ) => Promise<BatchRunState>;
}

interface BatchRunResultBase {
  batchId: string;
  processedTickets: number[];
  remoteHead: string;
  runId: string;
}

export type BatchRunResult = BatchRunResultBase &
  (
    | {
        failedTicket: number;
        message: string;
        status: "failed";
      }
    | {
        reason: "ticket-limit" | "time-budget";
        status: "checkpointed";
      }
    | {
        status:
          | "awaiting-enrollment"
          | "blocked"
          | "completed-no-change"
          | "conflict"
          | "ready-for-final-review"
          | "stale-continuation"
          | "waiting-no-change";
      }
  );

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value);
}

function validateLimits(limits: BatchExecutionLimits): void {
  const expected: BatchExecutionLimits = {
    jobTimeoutMinutes: 350,
    maxTicketsPerRun: 3,
    minimumRemainingMinutes: 140,
    processingBudgetMinutes: 300,
    ticketTimeoutMinutes: 120,
  };
  if (
    Object.entries(expected).some(
      ([name, value]) => limits[name as keyof BatchExecutionLimits] !== value,
    )
  ) {
    throw configurationError(
      "BATCH_EXECUTION_LIMITS_INVALID",
      "Batch processing requires the fixed GitHub-hosted runner safety limits.",
    );
  }
}

function validateOptions(options: RunBatchOptions): RegExpMatchArray {
  const match = options.batchId.match(batchIdPattern);
  if (
    !match ||
    (options.mode !== "continuation" &&
      options.mode !== "process" &&
      options.mode !== "resume") ||
    !/^[1-9][0-9]*$/u.test(options.runId) ||
    !Number.isFinite(Date.parse(options.startedAt))
  ) {
    throw configurationError(
      "BATCH_RUN_INPUT_INVALID",
      "Batch run identity, mode, run ID, or start time is invalid.",
    );
  }
  if (
    options.mode === "continuation" &&
    (!validSha(options.expectedHead) ||
      !options.predecessorRunId ||
      !/^[1-9][0-9]*$/u.test(options.predecessorRunId) ||
      options.predecessorRunId === options.runId)
  ) {
    throw configurationError(
      "CONTINUATION_INPUT_INVALID",
      "Continuation requires an expected HEAD and a distinct predecessor run ID.",
    );
  }
  validateLimits(options.limits);
  return match;
}

function validateState(
  state: BatchRunState,
  batchId: string,
  identity: RegExpMatchArray,
): void {
  const parent = Number(identity[1]);
  const basePrefix = identity[2];
  const initialRunId = identity[3];
  const statuses = new Set<BatchRunTicketStatus>([
    "accepted-no-change",
    "awaiting-enrollment",
    "blocked",
    "conflict",
    "executable",
    "preexisting-complete",
    "published",
    "waiting-no-change",
  ]);
  if (
    state.batchId !== batchId ||
    state.branch !== `sandcastle/${batchId}` ||
    state.parent !== parent ||
    state.initialRunId !== initialRunId ||
    !validSha(state.originalBaseSha) ||
    !state.originalBaseSha.startsWith(basePrefix ?? "") ||
    !validSha(state.remoteHead) ||
    state.activeHead !== state.remoteHead ||
    typeof state.defaultBranch !== "string" ||
    state.defaultBranch.length === 0 ||
    !Array.isArray(state.tickets) ||
    state.tickets.length === 0 ||
    !state.tickets.every(
      ({ number, reasons, status }) =>
        Number.isSafeInteger(number) &&
        number > 0 &&
        Array.isArray(reasons) &&
        reasons.every((reason) => typeof reason === "string") &&
        statuses.has(status),
    ) ||
    new Set(state.tickets.map(({ number }) => number)).size !==
      state.tickets.length
  ) {
    throw configurationError(
      "BATCH_REMOTE_STATE_INVALID",
      "Authoritative remote Batch state is missing or inconsistent.",
    );
  }
}

function terminalStatus(state: BatchRunState): BatchRunResult["status"] | null {
  if (state.tickets.some(({ status }) => status === "conflict")) {
    return "conflict";
  }
  if (state.tickets.some(({ status }) => status === "waiting-no-change")) {
    return "waiting-no-change";
  }
  if (state.tickets.some(({ status }) => status === "executable")) {
    return null;
  }
  if (state.tickets.some(({ status }) => status === "awaiting-enrollment")) {
    return "awaiting-enrollment";
  }
  if (state.tickets.some(({ status }) => status === "blocked")) {
    return "blocked";
  }
  if (state.tickets.every(({ status }) => completeStatuses.has(status))) {
    return state.remoteHead === state.originalBaseSha
      ? "completed-no-change"
      : "ready-for-final-review";
  }
  return "conflict";
}

function elapsedMinutes(startedAt: string, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(startedAt)) / 60_000);
}

function shouldCheckpoint(
  options: RunBatchOptions,
  processedCount: number,
  now: Date,
): "ticket-limit" | "time-budget" | null {
  if (processedCount >= options.limits.maxTicketsPerRun) {
    return "ticket-limit";
  }
  const elapsed = elapsedMinutes(options.startedAt, now);
  if (
    elapsed >= options.limits.processingBudgetMinutes ||
    options.limits.jobTimeoutMinutes - elapsed <
      options.limits.minimumRemainingMinutes
  ) {
    return "time-budget";
  }
  return null;
}

async function executeWithHardLimit(
  runtime: RunBatchRuntime,
  input: Omit<BatchTicketExecutionInput, "signal">,
  timeoutMinutes: number,
): Promise<BatchTicketExecution> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Ticket exceeded its hard processing limit."));
    }, timeoutMinutes * 60_000);
    timeout.unref();
  });
  try {
    return await Promise.race([
      runtime.processTicket({ ...input, signal: controller.signal }),
      expired,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function runBatch(
  repositoryPath: string,
  options: RunBatchOptions,
  runtime: RunBatchRuntime,
): Promise<BatchRunResult> {
  const identity = validateOptions(options);
  const now = runtime.now ?? (() => new Date());
  let state = await runtime.readState(repositoryPath, options.batchId);
  validateState(state, options.batchId, identity);
  const processedTickets: number[] = [];

  if (
    options.mode === "continuation" &&
    state.remoteHead !== options.expectedHead
  ) {
    return {
      batchId: options.batchId,
      processedTickets,
      remoteHead: state.remoteHead,
      runId: options.runId,
      status: "stale-continuation",
    };
  }

  for (;;) {
    const terminal = terminalStatus(state);
    if (terminal) {
      return {
        batchId: options.batchId,
        processedTickets,
        remoteHead: state.remoteHead,
        runId: options.runId,
        status: terminal,
      } as BatchRunResult;
    }
    const checkpoint = shouldCheckpoint(options, processedTickets.length, now());
    if (checkpoint) {
      await runtime.dispatchContinuation({
        batchId: options.batchId,
        expectedHead: state.remoteHead,
        predecessorRunId: options.runId,
      });
      return {
        batchId: options.batchId,
        processedTickets,
        reason: checkpoint,
        remoteHead: state.remoteHead,
        runId: options.runId,
        status: "checkpointed",
      };
    }
    const next = state.tickets
      .filter(({ status }) => status === "executable")
      .sort((left, right) => left.number - right.number)[0]!;
    let result: BatchTicketExecution;
    try {
      result = await executeWithHardLimit(
        runtime,
        {
          batchId: options.batchId,
          beforeHead: state.remoteHead,
          number: next.number,
        },
        options.limits.ticketTimeoutMinutes,
      );
    } catch {
      return {
        batchId: options.batchId,
        failedTicket: next.number,
        message: "Ticket processing failed; the current run stopped.",
        processedTickets,
        remoteHead: state.remoteHead,
        runId: options.runId,
        status: "failed",
      };
    }
    if (
      result.ticket !== next.number ||
      result.beforeHead !== state.remoteHead ||
      !validSha(result.head) ||
      (result.status !== "published" && result.status !== "waiting-no-change")
    ) {
      throw configurationError(
        "TICKET_RUN_RESULT_INVALID",
        "Ticket driver returned a result that does not match the active Batch state.",
      );
    }
    state = await runtime.readState(repositoryPath, options.batchId);
    validateState(state, options.batchId, identity);
    const observed = state.tickets.find(({ number }) => number === next.number);
    if (
      state.remoteHead !== result.head ||
      (result.status === "published" && observed?.status !== "published") ||
      (result.status === "waiting-no-change" &&
        observed?.status !== "waiting-no-change")
    ) {
      throw configurationError(
        "TICKET_REMOTE_CONFIRMATION_FAILED",
        "GitHub state did not confirm the Ticket driver result.",
      );
    }
    processedTickets.push(next.number);
  }
}

export function executionLimits(config: ProjectConfig): BatchExecutionLimits {
  return { ...config.execution };
}
