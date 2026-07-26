const objectIdPattern = /^[0-9a-f]{40}$/u;
const markerPrefix = "<!-- sandcastle-final-review\n";
const markerSuffix = "\n-->";
const runIdPattern = /^(?:0|[1-9][0-9]*)$/u;
const sessionIdPattern = /^[A-Za-z0-9._:-]{1,200}$/u;
const findingPathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,240}$/u;
const findingTextPattern = /^[^\u0000-\u001f\u007f-\u009f]{1,500}$/u;

export interface ReviewFinding {
  line: number;
  path: string;
  problem: string;
  requiredFix: string;
}

export interface ReviewOutput {
  findings: ReviewFinding[];
  schemaVersion: 1;
  verdict: "needs-fix" | "pass";
}

export interface FinalReviewMarker {
  baseHead: string;
  findings: ReviewFinding[];
  integrationHead: string;
  runId: string;
  schemaVersion: 2;
  type: "sandcastle-final-review";
  verdict: "needs-fix" | "pass";
}

export interface FinalFixMarker {
  afterHead: string;
  beforeHead: string;
  reviewRunId: string;
  runId: string;
  schemaVersion: 1;
  sessionId: string;
  type: "sandcastle-final-fix";
}

export interface FinalRereviewMarker {
  baseHead: string;
  findings: ReviewFinding[];
  fixRunId: string;
  integrationHead: string;
  runId: string;
  schemaVersion: 2;
  type: "sandcastle-final-rereview";
  verdict: "needs-fix" | "pass";
}

function exactKeys(candidate: object, expected: string[]): boolean {
  return (
    Object.keys(candidate).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function validReviewFinding(candidate: unknown): candidate is ReviewFinding {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    exactKeys(candidate, ["line", "path", "problem", "requiredFix"]) &&
    Number.isSafeInteger((candidate as ReviewFinding).line) &&
    (candidate as ReviewFinding).line >= 1 &&
    (candidate as ReviewFinding).line <= 10_000_000 &&
    typeof (candidate as ReviewFinding).path === "string" &&
    findingPathPattern.test((candidate as ReviewFinding).path) &&
    typeof (candidate as ReviewFinding).problem === "string" &&
    findingTextPattern.test((candidate as ReviewFinding).problem) &&
    typeof (candidate as ReviewFinding).requiredFix === "string" &&
    findingTextPattern.test((candidate as ReviewFinding).requiredFix)
  );
}

export function validateReviewOutput(candidate: unknown): ReviewOutput {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !exactKeys(candidate, ["findings", "schemaVersion", "verdict"])
  ) {
    throw new Error("Review output must be a structured review verdict.");
  }
  const output = candidate as ReviewOutput;
  if (
    output.schemaVersion !== 1 ||
    (output.verdict !== "pass" && output.verdict !== "needs-fix") ||
    !Array.isArray(output.findings) ||
    output.findings.length > 8 ||
    !output.findings.every(validReviewFinding) ||
    (output.verdict === "pass" && output.findings.length !== 0) ||
    (output.verdict === "needs-fix" && output.findings.length === 0)
  ) {
    throw new Error("Review output must be a structured review verdict.");
  }
  return output;
}

export function parseReviewOutput(source: string): ReviewOutput {
  let candidate: unknown;
  try {
    candidate = JSON.parse(source);
  } catch {
    throw new Error("Review output must be a structured review verdict.");
  }
  return validateReviewOutput(candidate);
}

export function renderFinalReviewMarker(marker: FinalReviewMarker): string {
  validateReviewOutput({
    findings: marker.findings,
    schemaVersion: 1,
    verdict: marker.verdict,
  });
  if (
    !objectIdPattern.test(marker.baseHead) ||
    !objectIdPattern.test(marker.integrationHead) ||
    !runIdPattern.test(marker.runId) ||
    marker.schemaVersion !== 2 ||
    marker.type !== "sandcastle-final-review" ||
    (marker.verdict !== "pass" && marker.verdict !== "needs-fix")
  ) {
    throw new Error("Final Review Marker is invalid.");
  }
  return `${markerPrefix}${JSON.stringify(marker)}${markerSuffix}`;
}

export function renderFinalFixMarker(marker: FinalFixMarker): string {
  if (
    !objectIdPattern.test(marker.afterHead) ||
    !objectIdPattern.test(marker.beforeHead) ||
    !runIdPattern.test(marker.reviewRunId) ||
    !runIdPattern.test(marker.runId) ||
    !sessionIdPattern.test(marker.sessionId) ||
    marker.schemaVersion !== 1 ||
    marker.type !== "sandcastle-final-fix"
  ) {
    throw new Error("Final Fix Marker is invalid.");
  }
  return `<!-- sandcastle-final-fix\n${JSON.stringify(marker)}${markerSuffix}`;
}

export function parseFinalFixMarker(body: string): FinalFixMarker | null {
  const prefix = "<!-- sandcastle-final-fix\n";
  if (!body.includes("<!-- sandcastle-final-fix")) return null;
  if (!body.startsWith(prefix) || !body.endsWith(markerSuffix)) {
    throw new Error("Final Fix Marker encoding is invalid.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(body.slice(prefix.length, -markerSuffix.length));
  } catch {
    throw new Error("Final Fix Marker encoding is invalid.");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !exactKeys(candidate, [
      "afterHead",
      "beforeHead",
      "reviewRunId",
      "runId",
      "schemaVersion",
      "sessionId",
      "type",
    ])
  ) {
    throw new Error("Final Fix Marker facts are invalid.");
  }
  const marker = candidate as FinalFixMarker;
  renderFinalFixMarker(marker);
  return marker;
}

export function renderFinalRereviewMarker(
  marker: FinalRereviewMarker,
): string {
  validateReviewOutput({
    findings: marker.findings,
    schemaVersion: 1,
    verdict: marker.verdict,
  });
  if (
    !objectIdPattern.test(marker.baseHead) ||
    !objectIdPattern.test(marker.integrationHead) ||
    !runIdPattern.test(marker.fixRunId) ||
    !runIdPattern.test(marker.runId) ||
    marker.schemaVersion !== 2 ||
    marker.type !== "sandcastle-final-rereview" ||
    (marker.verdict !== "pass" && marker.verdict !== "needs-fix")
  ) {
    throw new Error("Final Rereview Marker is invalid.");
  }
  return `<!-- sandcastle-final-rereview\n${JSON.stringify(marker)}${markerSuffix}`;
}

export function parseFinalRereviewMarker(
  body: string,
): FinalRereviewMarker | null {
  const prefix = "<!-- sandcastle-final-rereview\n";
  if (!body.includes("<!-- sandcastle-final-rereview")) return null;
  if (!body.startsWith(prefix) || !body.endsWith(markerSuffix)) {
    throw new Error("Final Rereview Marker encoding is invalid.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(body.slice(prefix.length, -markerSuffix.length));
  } catch {
    throw new Error("Final Rereview Marker encoding is invalid.");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !exactKeys(candidate, [
      "baseHead",
      "findings",
      "fixRunId",
      "integrationHead",
      "runId",
      "schemaVersion",
      "type",
      "verdict",
    ])
  ) {
    throw new Error("Final Rereview Marker facts are invalid.");
  }
  const marker = candidate as FinalRereviewMarker;
  renderFinalRereviewMarker(marker);
  return marker;
}

export function parseFinalReviewMarker(
  body: string,
): FinalReviewMarker | null {
  if (!body.includes("<!-- sandcastle-final-review")) return null;
  if (!body.startsWith(markerPrefix) || !body.endsWith(markerSuffix)) {
    throw new Error("Final Review Marker encoding is invalid.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      body.slice(markerPrefix.length, -markerSuffix.length),
    );
  } catch {
    throw new Error("Final Review Marker encoding is invalid.");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !exactKeys(candidate, [
      "baseHead",
      "findings",
      "integrationHead",
      "runId",
      "schemaVersion",
      "type",
      "verdict",
    ])
  ) {
    throw new Error("Final Review Marker facts are invalid.");
  }
  const marker = candidate as FinalReviewMarker;
  renderFinalReviewMarker(marker);
  return marker;
}
