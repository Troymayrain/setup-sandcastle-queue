import { randomUUID } from "node:crypto";

import { canonicalJson } from "../canonical-json.js";
import { ConfigurationError, InfrastructureError } from "../config.js";
import { isGitObjectId } from "../git/object-id.js";
import { hasExactShape, isRecord } from "../json.js";
import type { TicketPublicationRecord } from "../ticket/publish.js";

const batchIdPattern = /^p([1-9][0-9]*)-[a-f0-9]{12}-r[1-9][0-9]*$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sessionIdPattern = uuidPattern;
const abortRecordPattern =
  /<!-- sandcastle-batch-abort\n([\s\S]*?)\n-->/u;

export interface AbortBatchOptions {
  actor: string;
  batchId: string;
  expectedHead: string;
  pullRequest: number;
  reason: string;
  runId: string;
  trigger: "workflow_dispatch";
}

export interface BatchAbortRecord {
  actor: string;
  batchId: string;
  branch: string;
  defaultBranchHead: string;
  eventId: string;
  expectedHead: string;
  parent: number;
  preservedBranch: true;
  pullRequest: number;
  reason: string;
  reopenedTickets: number[];
  runId: string;
  schemaVersion: 1;
  stage: "completed" | "started";
}

export interface AbortBatchState {
  abortRecords: BatchAbortRecord[];
  activeProcessingRuns: Array<{
    id: number;
    status: "in_progress" | "queued";
  }>;
  batch: {
    branch: string;
    id: string;
    parent: number;
    remoteHead: string;
  };
  defaultBranchHead: string;
  parent: {
    number: number;
    state: "closed" | "open";
  };
  pullRequest: {
    draft: boolean;
    head: string;
    merged: boolean;
    number: number;
    state: "closed" | "open";
  };
  tickets: Array<{
    number: number;
    publication: TicketPublicationRecord | null;
    state: "closed" | "open";
  }>;
}

export type AbortCheckpoint =
  | "after-pr-close"
  | "after-start"
  | "after-ticket-reopen";

export interface AbortBatchRuntime {
  appendAudit: (record: BatchAbortRecord) => Promise<void> | void;
  checkpoint?: (point: AbortCheckpoint) => Promise<void> | void;
  closePullRequest: (number: number) => Promise<void> | void;
  commitInDefaultBranch: (
    commit: string,
    defaultBranchHead: string,
  ) => Promise<boolean>;
  readState: (
    repositoryPath: string,
    batchId: string,
  ) => Promise<AbortBatchState>;
  releaseActiveBatch: (expectedHead: string) => Promise<void> | void;
  reopenTicket: (number: number) => Promise<void> | void;
}

export interface AbortBatchResult {
  auditEventId: string;
  batchId: string;
  preservedBranch: string;
  pullRequest: number;
  reopenedTickets: number[];
  status: "aborted" | "already-aborted";
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function validActor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value)
  );
}

function validReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 8 &&
    value.length <= 2_000 &&
    !/[\u0000]/u.test(value)
  );
}

function validPublication(
  value: unknown,
  ticket: number,
): value is TicketPublicationRecord {
  if (
    !hasExactShape(value, [
      "batchId",
      "commit",
      "pullRequest",
      "schemaVersion",
      "sessionId",
      "ticket",
    ]) ||
    typeof value.batchId !== "string" ||
    !batchIdPattern.test(value.batchId) ||
    typeof value.commit !== "string" ||
    !isGitObjectId(value.commit) ||
    value.schemaVersion !== 1 ||
    typeof value.sessionId !== "string" ||
    !sessionIdPattern.test(value.sessionId) ||
    value.ticket !== ticket ||
    !hasExactShape(value.pullRequest, ["draft", "number", "url"]) ||
    value.pullRequest.draft !== true ||
    !Number.isSafeInteger(value.pullRequest.number) ||
    (value.pullRequest.number as number) <= 0 ||
    typeof value.pullRequest.url !== "string" ||
    value.pullRequest.url.length === 0
  ) {
    return false;
  }
  return true;
}

function validAbortRecord(value: unknown): value is BatchAbortRecord {
  return (
    hasExactShape(value, [
      "actor",
      "batchId",
      "branch",
      "defaultBranchHead",
      "eventId",
      "expectedHead",
      "parent",
      "preservedBranch",
      "pullRequest",
      "reason",
      "reopenedTickets",
      "runId",
      "schemaVersion",
      "stage",
    ]) &&
    validActor(value.actor) &&
    typeof value.batchId === "string" &&
    batchIdPattern.test(value.batchId) &&
    value.branch === `sandcastle/${value.batchId}` &&
    typeof value.defaultBranchHead === "string" &&
    isGitObjectId(value.defaultBranchHead) &&
    typeof value.eventId === "string" &&
    uuidPattern.test(value.eventId) &&
    typeof value.expectedHead === "string" &&
    isGitObjectId(value.expectedHead) &&
    Number.isSafeInteger(value.parent) &&
    (value.parent as number) > 0 &&
    value.preservedBranch === true &&
    Number.isSafeInteger(value.pullRequest) &&
    (value.pullRequest as number) > 0 &&
    validReason(value.reason) &&
    Array.isArray(value.reopenedTickets) &&
    value.reopenedTickets.every(
      (ticket) => Number.isSafeInteger(ticket) && ticket > 0,
    ) &&
    new Set(value.reopenedTickets).size === value.reopenedTickets.length &&
    typeof value.runId === "string" &&
    /^[1-9][0-9]*$/u.test(value.runId) &&
    value.schemaVersion === 1 &&
    (value.stage === "started" || value.stage === "completed")
  );
}

function validateOptions(options: AbortBatchOptions): RegExpMatchArray {
  const match = options.batchId.match(batchIdPattern);
  if (
    !hasExactShape(options, [
      "actor",
      "batchId",
      "expectedHead",
      "pullRequest",
      "reason",
      "runId",
      "trigger",
    ]) ||
    !match ||
    !validActor(options.actor) ||
    !isGitObjectId(options.expectedHead) ||
    !Number.isSafeInteger(options.pullRequest) ||
    options.pullRequest <= 0 ||
    !validReason(options.reason) ||
    !/^[1-9][0-9]*$/u.test(options.runId) ||
    options.trigger !== "workflow_dispatch"
  ) {
    throw configurationError(
      "BATCH_ABORT_INPUT_INVALID",
      "Batch abort requires an exact human workflow dispatch and fixed identities.",
    );
  }
  return match;
}

function validateState(
  state: AbortBatchState,
  options: AbortBatchOptions,
  identity: RegExpMatchArray,
): void {
  if (
    !hasExactShape(state, [
      "abortRecords",
      "activeProcessingRuns",
      "batch",
      "defaultBranchHead",
      "parent",
      "pullRequest",
      "tickets",
    ]) ||
    !Array.isArray(state.abortRecords) ||
    !state.abortRecords.every(validAbortRecord) ||
    !Array.isArray(state.activeProcessingRuns) ||
    !state.activeProcessingRuns.every(
      (run) =>
        hasExactShape(run, ["id", "status"]) &&
        Number.isSafeInteger(run.id) &&
        (run.id as number) > 0 &&
        (run.status === "in_progress" || run.status === "queued"),
    ) ||
    !hasExactShape(state.batch, ["branch", "id", "parent", "remoteHead"]) ||
    state.batch.id !== options.batchId ||
    state.batch.branch !== `sandcastle/${options.batchId}` ||
    state.batch.parent !== Number(identity[1]) ||
    state.batch.remoteHead !== options.expectedHead ||
    typeof state.defaultBranchHead !== "string" ||
    !isGitObjectId(state.defaultBranchHead) ||
    !hasExactShape(state.parent, ["number", "state"]) ||
    state.parent.number !== state.batch.parent ||
    state.parent.state !== "open" ||
    !hasExactShape(state.pullRequest, [
      "draft",
      "head",
      "merged",
      "number",
      "state",
    ]) ||
    state.pullRequest.number !== options.pullRequest ||
    state.pullRequest.draft !== true ||
    state.pullRequest.head !== options.expectedHead ||
    state.pullRequest.merged !== false ||
    (state.pullRequest.state !== "open" && state.pullRequest.state !== "closed") ||
    !Array.isArray(state.tickets) ||
    !state.tickets.every(
      (ticket) =>
        hasExactShape(ticket, ["number", "publication", "state"]) &&
        Number.isSafeInteger(ticket.number) &&
        (ticket.number as number) > 0 &&
        (ticket.state === "open" || ticket.state === "closed") &&
        (ticket.publication === null ||
          validPublication(ticket.publication, ticket.number as number)),
    ) ||
    new Set(state.tickets.map(({ number }) => number)).size !== state.tickets.length
  ) {
    throw infrastructureError(
      "BATCH_ABORT_STATE_INVALID",
      "Authoritative Batch, HEAD, parent, Ticket, or draft PR state is invalid.",
    );
  }
}

function recordsForBatch(
  state: AbortBatchState,
  options: AbortBatchOptions,
): { completed?: BatchAbortRecord; started?: BatchAbortRecord } {
  const records = state.abortRecords.filter(
    ({ batchId }) => batchId === options.batchId,
  );
  const started = records.filter(({ stage }) => stage === "started");
  const completed = records.filter(({ stage }) => stage === "completed");
  if (started.length > 1 || completed.length > 1 || (completed.length && !started.length)) {
    throw infrastructureError(
      "BATCH_ABORT_RECORD_INVALID",
      "Batch abort audit records are duplicated or incomplete.",
    );
  }
  const first = started[0];
  const last = completed[0];
  if (
    (first &&
      (first.actor !== options.actor ||
        first.expectedHead !== options.expectedHead ||
        first.parent !== state.batch.parent ||
        first.pullRequest !== options.pullRequest ||
        first.reason !== options.reason ||
        first.runId !== options.runId ||
        first.reopenedTickets.some(
          (ticket) => !state.tickets.some(({ number }) => number === ticket),
        ))) ||
    (last &&
      (!first ||
        canonicalJson(last) !==
          canonicalJson({ ...first, stage: "completed" })))
  ) {
    throw infrastructureError(
      "BATCH_ABORT_RECORD_INVALID",
      "Batch abort audit records do not match this immutable decision.",
    );
  }
  return { ...(first ? { started: first } : {}), ...(last ? { completed: last } : {}) };
}

function recordFor(
  state: AbortBatchState,
  options: AbortBatchOptions,
  eventId: string,
  reopenedTickets: number[],
  stage: BatchAbortRecord["stage"],
): BatchAbortRecord {
  return {
    actor: options.actor,
    batchId: options.batchId,
    branch: state.batch.branch,
    defaultBranchHead: state.defaultBranchHead,
    eventId,
    expectedHead: options.expectedHead,
    parent: state.batch.parent,
    preservedBranch: true,
    pullRequest: options.pullRequest,
    reason: options.reason,
    reopenedTickets,
    runId: options.runId,
    schemaVersion: 1,
    stage,
  };
}

export function parseBatchAbortRecord(body: string): BatchAbortRecord | null {
  const match = body.match(abortRecordPattern);
  if (!match?.[1]) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(match[1]) as unknown;
  } catch {
    throw configurationError(
      "BATCH_ABORT_RECORD_INVALID",
      "A Batch abort marker contains invalid JSON.",
    );
  }
  if (!validAbortRecord(candidate)) {
    throw configurationError(
      "BATCH_ABORT_RECORD_INVALID",
      "A Batch abort marker has an unsupported shape.",
    );
  }
  return candidate;
}

export function renderBatchAbortRecord(record: BatchAbortRecord): string {
  if (!validAbortRecord(record)) {
    throw configurationError(
      "BATCH_ABORT_RECORD_INVALID",
      "Cannot render invalid Batch abort evidence.",
    );
  }
  return [
    `Batch abort ${record.stage} by @${record.actor}.`,
    "",
    "<!-- sandcastle-batch-abort",
    canonicalJson(record).trimEnd(),
    "-->",
  ].join("\n");
}

export async function abortBatch(
  repositoryPath: string,
  options: AbortBatchOptions,
  runtime: AbortBatchRuntime,
): Promise<AbortBatchResult> {
  const identity = validateOptions(options);
  const state = await runtime.readState(repositoryPath, options.batchId);
  validateState(state, options, identity);
  if (state.activeProcessingRuns.length > 0) {
    throw configurationError(
      "BATCH_ABORT_ACTIVE_RUN",
      "Batch abort is forbidden while a processing run is queued or active.",
    );
  }
  const records = recordsForBatch(state, options);
  if (state.pullRequest.state === "closed" && !records.started) {
    throw configurationError(
      "BATCH_ABORT_PR_INVALID",
      "The Batch draft PR was already closed outside this abort decision.",
    );
  }
  if (records.completed) {
    await runtime.releaseActiveBatch(options.expectedHead);
    return {
      auditEventId: records.completed.eventId,
      batchId: options.batchId,
      preservedBranch: state.batch.branch,
      pullRequest: options.pullRequest,
      reopenedTickets: records.completed.reopenedTickets,
      status: "already-aborted",
    };
  }

  let started = records.started;
  if (!started) {
    const candidates = state.tickets.filter(
      ({ publication, state: ticketState }) =>
        ticketState === "closed" &&
        publication?.batchId === options.batchId &&
        publication.pullRequest.number === options.pullRequest,
    );
    const containment = await Promise.all(
      candidates.map(({ publication }) =>
        runtime.commitInDefaultBranch(
          publication!.commit,
          state.defaultBranchHead,
        ),
      ),
    );
    const reopenedTickets = candidates
      .filter((_ticket, index) => containment[index] === false)
      .map(({ number }) => number)
      .sort((left, right) => left - right);
    started = recordFor(
      state,
      options,
      randomUUID(),
      reopenedTickets,
      "started",
    );
    await runtime.appendAudit(started);
    await runtime.checkpoint?.("after-start");
  }

  if (state.pullRequest.state === "open") {
    await runtime.closePullRequest(options.pullRequest);
  }
  await runtime.checkpoint?.("after-pr-close");
  for (const ticket of started.reopenedTickets) {
    const current = state.tickets.find(({ number }) => number === ticket);
    if (!current) {
      throw infrastructureError(
        "BATCH_ABORT_STATE_INVALID",
        "A planned abort Ticket disappeared from authoritative state.",
      );
    }
    if (current.state === "closed") await runtime.reopenTicket(ticket);
    await runtime.checkpoint?.("after-ticket-reopen");
  }
  const completed = { ...started, stage: "completed" as const };
  await runtime.appendAudit(completed);
  await runtime.releaseActiveBatch(options.expectedHead);
  return {
    auditEventId: completed.eventId,
    batchId: options.batchId,
    preservedBranch: state.batch.branch,
    pullRequest: options.pullRequest,
    reopenedTickets: completed.reopenedTickets,
    status: "aborted",
  };
}
