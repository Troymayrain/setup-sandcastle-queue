import { canonicalJson } from "../canonical-json.js";
import { ConfigurationError } from "../config.js";
import { isGitObjectId } from "../git/object-id.js";

const candidatePattern =
  /<!-- sandcastle-ticket-no-change-candidate\n([\s\S]*?)\n-->/u;
const acceptancePattern =
  /<!-- sandcastle-ticket-no-change-acceptance\n([\s\S]*?)\n-->/u;
const completionPattern =
  /<!-- sandcastle-batch-no-change-completion\n([\s\S]*?)\n-->/u;

export interface TicketNoChangeCandidateRecord {
  batchId: string;
  head: string;
  schemaVersion: 1;
  sessionId: string;
  ticket: number;
}

export interface TicketNoChangeAcceptanceRecord
  extends TicketNoChangeCandidateRecord {
  actor: string;
  reason: string;
  runId: string;
}

export interface BatchNoChangeCompletionRecord {
  actor: string;
  batchId: string;
  head: string;
  parent: number;
  reason: string;
  runId: string;
  schemaVersion: 1;
}

function configurationError(message: string): ConfigurationError {
  return new ConfigurationError([
    { code: "NO_CHANGE_RECORD_INVALID", message, path: "" },
  ]);
}

function validSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
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

function parseMarker(body: string, pattern: RegExp): unknown | null {
  const match = body.match(pattern);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    throw configurationError("A managed no-change marker contains invalid JSON.");
  }
}

function exactKeys(candidate: object, keys: string[]): boolean {
  return (
    Object.keys(candidate).sort().join("\u0000") ===
    [...keys].sort().join("\u0000")
  );
}

function validCandidate(
  candidate: unknown,
): candidate is TicketNoChangeCandidateRecord {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const record = candidate as Partial<TicketNoChangeCandidateRecord>;
  return (
    exactKeys(candidate, ["batchId", "head", "schemaVersion", "sessionId", "ticket"]) &&
    record.schemaVersion === 1 &&
    typeof record.batchId === "string" &&
    isGitObjectId(record.head) &&
    validSessionId(record.sessionId) &&
    Number.isSafeInteger(record.ticket) &&
    (record.ticket ?? 0) > 0
  );
}

export function parseTicketNoChangeCandidate(
  body: string,
): TicketNoChangeCandidateRecord | null {
  const candidate = parseMarker(body, candidatePattern);
  if (candidate === null) return null;
  if (!validCandidate(candidate)) {
    throw configurationError("A Ticket no-change candidate has an unsupported shape.");
  }
  return candidate;
}

export function parseTicketNoChangeAcceptance(
  body: string,
): TicketNoChangeAcceptanceRecord | null {
  const candidate = parseMarker(body, acceptancePattern);
  if (candidate === null) return null;
  if (
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, [
      "actor",
      "batchId",
      "head",
      "reason",
      "runId",
      "schemaVersion",
      "sessionId",
      "ticket",
    ])
  ) {
    throw configurationError("A Ticket no-change acceptance has an unsupported shape.");
  }
  const record = candidate as Partial<TicketNoChangeAcceptanceRecord>;
  if (
    record.schemaVersion !== 1 ||
    !validActor(record.actor) ||
    typeof record.batchId !== "string" ||
    !isGitObjectId(record.head) ||
    !validReason(record.reason) ||
    typeof record.runId !== "string" ||
    !/^[1-9][0-9]*$/u.test(record.runId) ||
    !validSessionId(record.sessionId) ||
    !Number.isSafeInteger(record.ticket) ||
    (record.ticket ?? 0) <= 0
  ) {
    throw configurationError("A Ticket no-change acceptance contains invalid values.");
  }
  return record as TicketNoChangeAcceptanceRecord;
}

export function parseBatchNoChangeCompletion(
  body: string,
): BatchNoChangeCompletionRecord | null {
  const candidate = parseMarker(body, completionPattern);
  if (candidate === null) return null;
  if (
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    !exactKeys(candidate, [
      "actor",
      "batchId",
      "head",
      "parent",
      "reason",
      "runId",
      "schemaVersion",
    ])
  ) {
    throw configurationError("A Batch no-change completion has an unsupported shape.");
  }
  const record = candidate as Partial<BatchNoChangeCompletionRecord>;
  if (
    record.schemaVersion !== 1 ||
    !validActor(record.actor) ||
    typeof record.batchId !== "string" ||
    !isGitObjectId(record.head) ||
    !Number.isSafeInteger(record.parent) ||
    (record.parent ?? 0) <= 0 ||
    !validReason(record.reason) ||
    typeof record.runId !== "string" ||
    !/^[1-9][0-9]*$/u.test(record.runId)
  ) {
    throw configurationError("A Batch no-change completion contains invalid values.");
  }
  return record as BatchNoChangeCompletionRecord;
}

function marker(name: string, record: object): string {
  return `<!-- ${name}\n${canonicalJson(record).trimEnd()}\n-->`;
}

export function renderTicketNoChangeCandidate(
  record: TicketNoChangeCandidateRecord,
): string {
  return [
    "This Ticket produced no repository diff and is waiting for explicit human acceptance.",
    "",
    marker("sandcastle-ticket-no-change-candidate", record),
  ].join("\n");
}

export function renderTicketNoChangeAcceptance(
  record: TicketNoChangeAcceptanceRecord,
): string {
  return [
    `No-change accepted by @${record.actor}: ${record.reason}`,
    "",
    marker("sandcastle-ticket-no-change-acceptance", record),
  ].join("\n");
}

export function renderBatchNoChangeCompletion(
  record: BatchNoChangeCompletionRecord,
): string {
  return [
    `Zero-diff Batch completion confirmed by @${record.actor}: ${record.reason}`,
    "",
    marker("sandcastle-batch-no-change-completion", record),
  ].join("\n");
}
