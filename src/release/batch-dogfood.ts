import { readFile } from "node:fs/promises";

import { ConfigurationError } from "../config.js";

const sha1Pattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const exactSemverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const opaqueIdPattern = /^[1-9][0-9]{0,19}$/u;
const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const gateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const repositoryPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const maximumInputBytes = 1024 * 1024;
const maximumRunSeconds = 6 * 60 * 60;

type ActorPermission = "admin" | "maintain" | "read" | "triage" | "write";

export interface BatchDogfoodPrerequisite {
  reportSha256: string;
  runId: string;
}

export interface BatchDogfoodChecks {
  auditTimelineComplete: true;
  cumulativeFinalReview: true;
  manualEnrollment: true;
  nativeDependencies: true;
  newParentPrd: true;
  noDuplicateImplementation: true;
  noDuplicatePublication: true;
  processing: true;
  recoverySemantics: true;
}

export interface BatchDogfoodTicketEvidence {
  contextId: string;
  dependencies: number[];
  implementationCount: 1;
  issueNumber: number;
  order: number;
  publicationCount: 1;
  publishedCommit: string;
  runId: string;
  sessionId: string;
  skills: {
    "code-review": string;
    implement: string;
    tdd: string;
  };
}

export interface BatchDogfoodAuditEvidence {
  artifactId: string;
  commentId: string;
  containsRawTranscript: false;
  containsSecrets: false;
  eventCount: number;
  links: {
    commits: number;
    issues: number;
    pullRequests: number;
    runs: number;
    sessions: number;
    skills: number;
  };
  sanitized: true;
  timelineSha256: string;
}

export interface BatchDogfoodContinuationEvidence {
  checkpointElapsedSeconds: number;
  continuationRunId: string;
  predecessorRunId: string;
  stateSha256: string;
  verified: true;
}

export interface BatchDogfoodFinalReviewEvidence {
  cumulative: true;
  findingsAfterPath: 0;
  findingsBeforePath: number;
  path: "final-fix" | "human-review-only";
  pathCommit: string;
  pathRunId: string;
  pullRequestNumber: number;
  readyHead: string;
  reviewedHead: string;
  specEvidenceSha256: string;
  standardsEvidenceSha256: string;
}

export interface BatchDogfoodRecoveryEvidence {
  firstTicket: {
    failureRunId: string;
    implementationCount: 1;
    publicationCount: 1;
    recoveryRunId: string;
    strategy: "equivalent" | "resume";
    ticket: number;
  };
  pushBeforeClosure: {
    closureCount: 1;
    implementationCount: 1;
    publicationCount: 1;
    publishedCommit: string;
    recoveryRunId: string;
    ticket: number;
  };
}

export interface BatchDogfoodEvidence {
  audit: BatchDogfoodAuditEvidence;
  baseSha: string;
  candidateSha: string;
  checks: BatchDogfoodChecks;
  continuation: BatchDogfoodContinuationEvidence;
  finalReview: BatchDogfoodFinalReviewEvidence;
  gateId: string;
  parentIssue: number;
  prerequisite: {
    legacyDogfoodReportSha256: string;
    legacyDogfoodRunId: string;
  };
  recoveries: BatchDogfoodRecoveryEvidence;
  releaseVersion: string;
  repository: string;
  run: {
    conclusion: "success";
    event: "workflow_dispatch";
    id: string;
    url: string;
  };
  schemaVersion: 1;
  tickets: BatchDogfoodTicketEvidence[];
}

export interface BatchDogfoodGateInput {
  actorPermission: ActorPermission;
  baseSha: string;
  candidateSha: string;
  evidence: unknown;
  gateId: string;
  legacyDogfood: BatchDogfoodPrerequisite;
  parentIssue: number;
  releaseVersion: string;
  repository: string;
  tickets: number[];
}

export interface BatchDogfoodGateDiagnostic {
  code: string;
  message: string;
}

export interface BatchDogfoodGateResult {
  audit: BatchDogfoodAuditEvidence | null;
  baseSha: string | null;
  candidateSha: string | null;
  continuation: BatchDogfoodContinuationEvidence | null;
  diagnostics: BatchDogfoodGateDiagnostic[];
  finalReview: BatchDogfoodFinalReviewEvidence | null;
  gateId: string | null;
  legacyDogfood: BatchDogfoodPrerequisite | null;
  ok: boolean;
  parentIssue: number | null;
  recoveries: BatchDogfoodRecoveryEvidence | null;
  releaseVersion: string | null;
  repository: string | null;
  run: { id: string; url: string } | null;
  schemaVersion: 1;
  tickets: BatchDogfoodTicketEvidence[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactShape(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validPrerequisite(value: unknown): value is BatchDogfoodPrerequisite {
  return (
    hasExactShape(value, ["reportSha256", "runId"]) &&
    typeof value.reportSha256 === "string" &&
    sha256Pattern.test(value.reportSha256) &&
    typeof value.runId === "string" &&
    opaqueIdPattern.test(value.runId)
  );
}

function validTicketNumbers(value: unknown, parentIssue: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(positiveInteger) &&
    new Set(value).size === value.length &&
    !value.includes(parentIssue)
  );
}

function validChecks(value: unknown): value is BatchDogfoodChecks {
  const keys = [
    "auditTimelineComplete",
    "cumulativeFinalReview",
    "manualEnrollment",
    "nativeDependencies",
    "newParentPrd",
    "noDuplicateImplementation",
    "noDuplicatePublication",
    "processing",
    "recoverySemantics",
  ] as const;
  return hasExactShape(value, keys) && keys.every((key) => value[key] === true);
}

function validSkills(
  value: unknown,
): value is BatchDogfoodTicketEvidence["skills"] {
  return (
    hasExactShape(value, ["code-review", "implement", "tdd"]) &&
    typeof value["code-review"] === "string" &&
    sha256Pattern.test(value["code-review"]) &&
    typeof value.implement === "string" &&
    sha256Pattern.test(value.implement) &&
    typeof value.tdd === "string" &&
    sha256Pattern.test(value.tdd)
  );
}

function validTicketEvidence(
  value: unknown,
  issueNumber: number,
  order: number,
  precedingTickets: readonly number[],
): value is BatchDogfoodTicketEvidence {
  if (
    !hasExactShape(value, [
      "contextId",
      "dependencies",
      "implementationCount",
      "issueNumber",
      "order",
      "publicationCount",
      "publishedCommit",
      "runId",
      "sessionId",
      "skills",
    ]) ||
    value.issueNumber !== issueNumber ||
    value.order !== order ||
    typeof value.contextId !== "string" ||
    !stableIdPattern.test(value.contextId) ||
    typeof value.sessionId !== "string" ||
    !stableIdPattern.test(value.sessionId) ||
    value.contextId === value.sessionId ||
    value.implementationCount !== 1 ||
    value.publicationCount !== 1 ||
    typeof value.publishedCommit !== "string" ||
    !sha1Pattern.test(value.publishedCommit) ||
    typeof value.runId !== "string" ||
    !opaqueIdPattern.test(value.runId) ||
    !validSkills(value.skills) ||
    !Array.isArray(value.dependencies) ||
    !value.dependencies.every(positiveInteger) ||
    new Set(value.dependencies).size !== value.dependencies.length ||
    !value.dependencies.every((dependency) =>
      precedingTickets.includes(dependency),
    )
  ) {
    return false;
  }
  return order === 1
    ? value.dependencies.length === 0
    : value.dependencies.length > 0;
}

function validTicketsEvidence(
  value: unknown,
  tickets: readonly number[],
): value is BatchDogfoodTicketEvidence[] {
  if (!Array.isArray(value) || value.length !== tickets.length) {
    return false;
  }
  const accepted = value.filter((ticket, index) =>
    validTicketEvidence(ticket, tickets[index]!, index + 1, tickets.slice(0, index)),
  );
  if (accepted.length !== tickets.length) {
    return false;
  }
  const edgeCount = accepted.reduce(
    (count, ticket) => count + ticket.dependencies.length,
    0,
  );
  return (
    edgeCount >= 2 &&
    new Set(accepted.map(({ contextId }) => contextId)).size === 3 &&
    new Set(accepted.map(({ sessionId }) => sessionId)).size === 3 &&
    new Set(accepted.map(({ publishedCommit }) => publishedCommit)).size === 3 &&
    new Set(accepted.map(({ runId }) => runId)).size === 3
  );
}

function validAudit(value: unknown): value is BatchDogfoodAuditEvidence {
  return (
    hasExactShape(value, [
      "artifactId",
      "commentId",
      "containsRawTranscript",
      "containsSecrets",
      "eventCount",
      "links",
      "sanitized",
      "timelineSha256",
    ]) &&
    typeof value.artifactId === "string" &&
    opaqueIdPattern.test(value.artifactId) &&
    typeof value.commentId === "string" &&
    opaqueIdPattern.test(value.commentId) &&
    value.containsRawTranscript === false &&
    value.containsSecrets === false &&
    positiveInteger(value.eventCount) &&
    value.sanitized === true &&
    typeof value.timelineSha256 === "string" &&
    sha256Pattern.test(value.timelineSha256) &&
    hasExactShape(value.links, [
      "commits",
      "issues",
      "pullRequests",
      "runs",
      "sessions",
      "skills",
    ]) &&
    positiveInteger(value.links.commits) &&
    value.links.commits >= 3 &&
    positiveInteger(value.links.issues) &&
    value.links.issues >= 4 &&
    positiveInteger(value.links.pullRequests) &&
    positiveInteger(value.links.runs) &&
    value.links.runs >= 6 &&
    value.links.sessions === 3 &&
    positiveInteger(value.links.skills) &&
    value.links.skills >= 9
  );
}

function validContinuation(
  value: unknown,
): value is BatchDogfoodContinuationEvidence {
  return (
    hasExactShape(value, [
      "checkpointElapsedSeconds",
      "continuationRunId",
      "predecessorRunId",
      "stateSha256",
      "verified",
    ]) &&
    positiveInteger(value.checkpointElapsedSeconds) &&
    value.checkpointElapsedSeconds < maximumRunSeconds &&
    typeof value.continuationRunId === "string" &&
    opaqueIdPattern.test(value.continuationRunId) &&
    typeof value.predecessorRunId === "string" &&
    opaqueIdPattern.test(value.predecessorRunId) &&
    value.continuationRunId !== value.predecessorRunId &&
    typeof value.stateSha256 === "string" &&
    sha256Pattern.test(value.stateSha256) &&
    value.verified === true
  );
}

function validFinalReview(
  value: unknown,
): value is BatchDogfoodFinalReviewEvidence {
  if (
    !hasExactShape(value, [
      "cumulative",
      "findingsAfterPath",
      "findingsBeforePath",
      "path",
      "pathCommit",
      "pathRunId",
      "pullRequestNumber",
      "readyHead",
      "reviewedHead",
      "specEvidenceSha256",
      "standardsEvidenceSha256",
    ]) ||
    value.cumulative !== true ||
    value.findingsAfterPath !== 0 ||
    !nonnegativeInteger(value.findingsBeforePath) ||
    (value.path !== "final-fix" && value.path !== "human-review-only") ||
    (value.path === "final-fix" && value.findingsBeforePath === 0) ||
    typeof value.pathCommit !== "string" ||
    !sha1Pattern.test(value.pathCommit) ||
    typeof value.pathRunId !== "string" ||
    !opaqueIdPattern.test(value.pathRunId) ||
    !positiveInteger(value.pullRequestNumber) ||
    typeof value.readyHead !== "string" ||
    !sha1Pattern.test(value.readyHead) ||
    value.readyHead !== value.pathCommit ||
    typeof value.reviewedHead !== "string" ||
    !sha1Pattern.test(value.reviewedHead) ||
    value.reviewedHead === value.readyHead ||
    typeof value.specEvidenceSha256 !== "string" ||
    !sha256Pattern.test(value.specEvidenceSha256) ||
    typeof value.standardsEvidenceSha256 !== "string" ||
    !sha256Pattern.test(value.standardsEvidenceSha256)
  ) {
    return false;
  }
  return true;
}

function validRecoveries(
  value: unknown,
  tickets: readonly BatchDogfoodTicketEvidence[],
): value is BatchDogfoodRecoveryEvidence {
  if (
    !hasExactShape(value, ["firstTicket", "pushBeforeClosure"]) ||
    !hasExactShape(value.firstTicket, [
      "failureRunId",
      "implementationCount",
      "publicationCount",
      "recoveryRunId",
      "strategy",
      "ticket",
    ]) ||
    value.firstTicket.ticket !== tickets[0]!.issueNumber ||
    typeof value.firstTicket.failureRunId !== "string" ||
    !opaqueIdPattern.test(value.firstTicket.failureRunId) ||
    typeof value.firstTicket.recoveryRunId !== "string" ||
    !opaqueIdPattern.test(value.firstTicket.recoveryRunId) ||
    value.firstTicket.failureRunId === value.firstTicket.recoveryRunId ||
    value.firstTicket.strategy !== "resume" &&
      value.firstTicket.strategy !== "equivalent"
  ) {
    return false;
  }
  if (
    value.firstTicket.implementationCount !== 1 ||
    value.firstTicket.publicationCount !== 1 ||
    !hasExactShape(value.pushBeforeClosure, [
      "closureCount",
      "implementationCount",
      "publicationCount",
      "publishedCommit",
      "recoveryRunId",
      "ticket",
    ]) ||
    !positiveInteger(value.pushBeforeClosure.ticket) ||
    typeof value.pushBeforeClosure.recoveryRunId !== "string" ||
    !opaqueIdPattern.test(value.pushBeforeClosure.recoveryRunId) ||
    value.pushBeforeClosure.closureCount !== 1 ||
    value.pushBeforeClosure.implementationCount !== 1 ||
    value.pushBeforeClosure.publicationCount !== 1 ||
    typeof value.pushBeforeClosure.publishedCommit !== "string" ||
    !sha1Pattern.test(value.pushBeforeClosure.publishedCommit)
  ) {
    return false;
  }
  const firstTicket = value.firstTicket;
  const pushBeforeClosure = value.pushBeforeClosure;
  const publicationTicket = tickets.find(
    ({ issueNumber }) => issueNumber === pushBeforeClosure.ticket,
  );
  return (
    publicationTicket !== undefined &&
    publicationTicket.publishedCommit === pushBeforeClosure.publishedCommit &&
    ![firstTicket.failureRunId, firstTicket.recoveryRunId].includes(
      pushBeforeClosure.recoveryRunId,
    )
  );
}

function validEvidence(
  value: unknown,
  input: BatchDogfoodGateInput,
): value is BatchDogfoodEvidence {
  if (
    !hasExactShape(value, [
      "audit",
      "baseSha",
      "candidateSha",
      "checks",
      "continuation",
      "finalReview",
      "gateId",
      "parentIssue",
      "prerequisite",
      "recoveries",
      "releaseVersion",
      "repository",
      "run",
      "schemaVersion",
      "tickets",
    ]) ||
    value.schemaVersion !== 1 ||
    value.baseSha !== input.baseSha ||
    value.candidateSha !== input.candidateSha ||
    value.gateId !== input.gateId ||
    value.parentIssue !== input.parentIssue ||
    value.releaseVersion !== input.releaseVersion ||
    value.repository !== input.repository ||
    !validChecks(value.checks) ||
    !validAudit(value.audit) ||
    !validContinuation(value.continuation) ||
    !validFinalReview(value.finalReview) ||
    !hasExactShape(value.prerequisite, [
      "legacyDogfoodReportSha256",
      "legacyDogfoodRunId",
    ]) ||
    value.prerequisite.legacyDogfoodReportSha256 !==
      input.legacyDogfood.reportSha256 ||
    value.prerequisite.legacyDogfoodRunId !== input.legacyDogfood.runId ||
    !validTicketsEvidence(value.tickets, input.tickets) ||
    !hasExactShape(value.run, ["conclusion", "event", "id", "url"]) ||
    value.run.conclusion !== "success" ||
    value.run.event !== "workflow_dispatch" ||
    typeof value.run.id !== "string" ||
    !opaqueIdPattern.test(value.run.id) ||
    value.run.url !==
      `https://github.com/${input.repository}/actions/runs/${value.run.id}`
  ) {
    return false;
  }
  return validRecoveries(value.recoveries, value.tickets);
}

function report(
  input: Partial<BatchDogfoodGateInput>,
  diagnostics: BatchDogfoodGateDiagnostic[],
  evidence?: BatchDogfoodEvidence,
): BatchDogfoodGateResult {
  return {
    audit: evidence?.audit ?? null,
    baseSha:
      typeof input.baseSha === "string" && sha1Pattern.test(input.baseSha)
        ? input.baseSha
        : null,
    candidateSha:
      typeof input.candidateSha === "string" &&
      sha1Pattern.test(input.candidateSha)
        ? input.candidateSha
        : null,
    continuation: evidence?.continuation ?? null,
    diagnostics,
    finalReview: evidence?.finalReview ?? null,
    gateId:
      typeof input.gateId === "string" && gateIdPattern.test(input.gateId)
        ? input.gateId
        : null,
    legacyDogfood: validPrerequisite(input.legacyDogfood)
      ? input.legacyDogfood
      : null,
    ok: diagnostics.length === 0 && evidence !== undefined,
    parentIssue: positiveInteger(input.parentIssue) ? input.parentIssue : null,
    recoveries: evidence?.recoveries ?? null,
    releaseVersion:
      typeof input.releaseVersion === "string" &&
      exactSemverPattern.test(input.releaseVersion)
        ? input.releaseVersion
        : null,
    repository:
      typeof input.repository === "string" &&
      repositoryPattern.test(input.repository)
        ? input.repository
        : null,
    run: evidence ? { id: evidence.run.id, url: evidence.run.url } : null,
    schemaVersion: 1,
    tickets: evidence?.tickets ?? [],
  };
}

/**
 * 校验真实三票 Batch 产生的脱敏 processing、recovery 与 Final Review 证据。
 * 无效 payload 只产生稳定诊断，不保留目标 workflow 的任意文本。
 */
export function evaluateBatchDogfoodGate(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): BatchDogfoodGateResult {
  const safeInput = isRecord(input) ? input : {};
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_JOB !== "batch-dogfood-gate" ||
    !environment.GITHUB_RUN_ID ||
    !opaqueIdPattern.test(environment.GITHUB_RUN_ID)
  ) {
    return report(safeInput, [
      {
        code: "BATCH_DOGFOOD_CONTEXT_INVALID",
        message:
          "The Batch dogfood gate runs only in its dedicated manual GitHub Actions job.",
      },
    ]);
  }

  if (
    !hasExactShape(input, [
      "actorPermission",
      "baseSha",
      "candidateSha",
      "evidence",
      "gateId",
      "legacyDogfood",
      "parentIssue",
      "releaseVersion",
      "repository",
      "tickets",
    ]) ||
    typeof input.actorPermission !== "string" ||
    !["admin", "maintain", "read", "triage", "write"].includes(
      input.actorPermission,
    ) ||
    typeof input.baseSha !== "string" ||
    !sha1Pattern.test(input.baseSha) ||
    typeof input.candidateSha !== "string" ||
    !sha1Pattern.test(input.candidateSha) ||
    typeof input.gateId !== "string" ||
    !gateIdPattern.test(input.gateId) ||
    !validPrerequisite(input.legacyDogfood) ||
    !positiveInteger(input.parentIssue) ||
    typeof input.releaseVersion !== "string" ||
    !exactSemverPattern.test(input.releaseVersion) ||
    typeof input.repository !== "string" ||
    !repositoryPattern.test(input.repository) ||
    !validTicketNumbers(input.tickets, input.parentIssue)
  ) {
    return report(safeInput, [
      {
        code: "BATCH_DOGFOOD_INPUT_INVALID",
        message: "The Batch dogfood gate input is invalid.",
      },
    ]);
  }

  if (
    input.actorPermission !== "admin" &&
    input.actorPermission !== "maintain"
  ) {
    return report(input, [
      {
        code: "BATCH_DOGFOOD_MAINTAINER_REQUIRED",
        message: "Only a repository maintainer may run the Batch dogfood gate.",
      },
    ]);
  }

  const gateInput = input as unknown as BatchDogfoodGateInput;
  if (!validEvidence(gateInput.evidence, gateInput)) {
    return report(gateInput, [
      {
        code: "BATCH_DOGFOOD_EVIDENCE_INVALID",
        message:
          "Batch dogfood evidence is incomplete, unsafe, duplicated, or bound to different gate inputs.",
      },
    ]);
  }
  return report(gateInput, [], gateInput.evidence);
}

export async function readBatchDogfoodGateInput(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new ConfigurationError([
      {
        code: "BATCH_DOGFOOD_INPUT_UNAVAILABLE",
        message: "Unable to read the Batch dogfood gate input.",
        path: "",
      },
    ]);
  }
  if (Buffer.byteLength(source, "utf8") > maximumInputBytes) {
    throw new ConfigurationError([
      {
        code: "BATCH_DOGFOOD_INPUT_TOO_LARGE",
        message: "The Batch dogfood gate input exceeds the size limit.",
        path: "",
      },
    ]);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ConfigurationError([
      {
        code: "BATCH_DOGFOOD_INPUT_INVALID_JSON",
        message: "The Batch dogfood gate input is not valid JSON.",
        path: "",
      },
    ]);
  }
}
