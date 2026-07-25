import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import type {
  WorkflowHostOperation,
} from "./workflow-host.js";

const objectIdPattern = /^[0-9a-f]{40}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;
const safeIdentifierPattern = /^[A-Za-z0-9._:/-]{1,160}$/u;
const auditStatuses = new Set([
  "complete",
  "conflict",
  "continued",
  "failure",
  "final-fix-dispatched",
  "final-rereview-dispatched",
  "final-review-dispatched",
  "needs-human-review",
  "processing",
  "published",
  "ready-for-human-review",
  "reconciled",
  "stale-continuation",
  "stale-final-fix",
  "stale-final-rereview",
  "stale-final-review",
  "waiting",
]);

export interface QueueAuditRecord {
  afterHead?: string;
  baseHead?: string;
  beforeHead?: string;
  completionCommit?: string;
  durationMs: number;
  expectedHead?: string;
  integrationHead?: string;
  operation: WorkflowHostOperation;
  runId: string;
  schemaVersion: 1;
  sessionId?: string;
  status: string;
  ticket?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sensitiveValues(environment: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    Object.entries(environment)
      .filter(
        ([name, value]) =>
          value &&
          /(?:AUTH_TOKEN|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)/u.test(
            name,
          ),
      )
      .map(([, value]) => value!),
  );
}

function containsSensitive(
  value: string,
  sensitive: ReadonlySet<string>,
): boolean {
  return [...sensitive].some(
    (secret) =>
      value === secret ||
      (secret.length >= 8 && value.includes(secret)),
  );
}

function objectId(
  value: unknown,
  sensitive: ReadonlySet<string>,
): string | undefined {
  return typeof value === "string" &&
    objectIdPattern.test(value) &&
    !containsSensitive(value, sensitive)
    ? value
    : undefined;
}

function safeIdentifier(
  value: unknown,
  sensitive: ReadonlySet<string>,
): string | undefined {
  return typeof value === "string" &&
    safeIdentifierPattern.test(value) &&
    !containsSensitive(value, sensitive)
    ? value
    : undefined;
}

export function createQueueAuditRecord(input: {
  durationMs: number;
  environment: NodeJS.ProcessEnv;
  expectedHead?: string;
  operation: WorkflowHostOperation;
  result: unknown;
  runId: string;
}): QueueAuditRecord {
  const result = isRecord(input.result) ? input.result : {};
  const sensitive = sensitiveValues(input.environment);
  const runId =
    runIdPattern.test(input.runId) &&
    !containsSensitive(input.runId, sensitive)
      ? input.runId
      : "unknown";
  const durationMs =
    Number.isFinite(input.durationMs) && input.durationMs >= 0
      ? Math.floor(input.durationMs)
      : 0;
  const status =
    typeof result.status === "string" &&
    auditStatuses.has(result.status) &&
    !containsSensitive(result.status, sensitive)
      ? result.status
      : "failure";
  const ticket =
    Number.isSafeInteger(result.ticket) && (result.ticket as number) > 0
      ? (result.ticket as number)
      : undefined;
  return {
    durationMs,
    operation: input.operation,
    runId,
    schemaVersion: 1,
    status,
    ...(ticket === undefined ? {} : { ticket }),
    ...(safeIdentifier(result.sessionId, sensitive) === undefined
      ? {}
      : { sessionId: safeIdentifier(result.sessionId, sensitive) }),
    ...(objectId(input.expectedHead, sensitive) === undefined
      ? {}
      : { expectedHead: objectId(input.expectedHead, sensitive) }),
    ...(objectId(result.beforeHead, sensitive) === undefined
      ? {}
      : { beforeHead: objectId(result.beforeHead, sensitive) }),
    ...(objectId(result.afterHead, sensitive) === undefined
      ? {}
      : { afterHead: objectId(result.afterHead, sensitive) }),
    ...(objectId(result.completionCommit, sensitive) === undefined
      ? {}
      : { completionCommit: objectId(result.completionCommit, sensitive) }),
    ...(objectId(result.integrationHead, sensitive) === undefined
      ? {}
      : { integrationHead: objectId(result.integrationHead, sensitive) }),
    ...(objectId(result.baseHead, sensitive) === undefined
      ? {}
      : { baseHead: objectId(result.baseHead, sensitive) }),
  };
}

export function operationAndAuditFailure(
  operationError: unknown,
  auditError: unknown,
): AggregateError {
  return new AggregateError(
    [operationError, auditError],
    "Queue operation failed and audit evidence could not be written.",
    { cause: operationError },
  );
}

export async function writeQueueAuditEvidence(
  record: QueueAuditRecord,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const artifactPath = environment.SANDCASTLE_AUDIT_PATH;
  const summaryPath = environment.GITHUB_STEP_SUMMARY;
  if (artifactPath) {
    if (!isAbsolute(artifactPath)) {
      throw new Error("SANDCASTLE_AUDIT_PATH must be absolute.");
    }
    await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
    await writeFile(artifactPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  if (summaryPath) {
    if (!isAbsolute(summaryPath)) {
      throw new Error("GITHUB_STEP_SUMMARY must be absolute.");
    }
    await mkdir(dirname(summaryPath), { recursive: true, mode: 0o700 });
    await appendFile(
      summaryPath,
      [
        "## Sandcastle Queue",
        "",
        `- Run: ${record.runId}`,
        `- Operation: ${record.operation}`,
        `- Status: ${record.status}`,
        ...(record.ticket === undefined
          ? []
          : [`- Ticket: #${record.ticket}`]),
        `- Duration: ${record.durationMs} ms`,
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
  }
}
