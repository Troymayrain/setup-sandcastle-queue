const objectIdPattern = /^[0-9a-f]{40}$/u;
const markerPrefix = "<!-- sandcastle-ticket-publication\n";
const markerSuffix = "\n-->";
const reservedTrailerPattern =
  /^Sandcastle-(?:Ticket|Session|Before-Head|Run-Id):/mu;

export interface CompletionMetadata {
  beforeHead: string;
  issue: number;
  runId: string;
  sessionId: string;
}

export interface PublicationMarker extends CompletionMetadata {
  afterHead: string;
  integrationBranch: string;
  schemaVersion: 1;
  type: "sandcastle-ticket-publication";
}

export interface FinalReviewMarker {
  baseHead: string;
  integrationHead: string;
  runId: string;
  schemaVersion: 1;
  type: "sandcastle-final-review";
  verdict: "needs-fix" | "pass";
}

function exactKeys(candidate: object, expected: string[]): boolean {
  return (
    Object.keys(candidate).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function validMetadata(candidate: Partial<CompletionMetadata>): boolean {
  return (
    objectIdPattern.test(candidate.beforeHead ?? "") &&
    Number.isSafeInteger(candidate.issue) &&
    (candidate.issue ?? 0) > 0 &&
    /^(?:0|[1-9][0-9]*)$/u.test(candidate.runId ?? "") &&
    /^[A-Za-z0-9._:-]{1,200}$/u.test(candidate.sessionId ?? "")
  );
}

export function completionMessage(
  original: string,
  metadata: CompletionMetadata,
): string {
  if (
    !validMetadata(metadata) ||
    original.length > 64 * 1024 ||
    reservedTrailerPattern.test(original)
  ) {
    throw new Error("Completion commit metadata is invalid or already present.");
  }
  return `${original.trimEnd()}

Sandcastle-Ticket: ${metadata.issue}
Sandcastle-Session: ${metadata.sessionId}
Sandcastle-Before-Head: ${metadata.beforeHead}
Sandcastle-Run-Id: ${metadata.runId}
`;
}

export function parseCompletionMetadata(
  message: string,
): CompletionMetadata | null {
  const match = message.match(
    /\n\nSandcastle-Ticket: ([1-9][0-9]*)\nSandcastle-Session: ([A-Za-z0-9._:-]{1,200})\nSandcastle-Before-Head: ([0-9a-f]{40})\nSandcastle-Run-Id: (0|[1-9][0-9]*)\n?$/u,
  );
  if (
    !match ||
    match.index === undefined ||
    reservedTrailerPattern.test(message.slice(0, match.index))
  ) {
    return null;
  }
  const candidate: Partial<CompletionMetadata> = {
    beforeHead: match[3],
    issue: Number(match[1]),
    runId: match[4],
    sessionId: match[2],
  };
  return validMetadata(candidate) ? (candidate as CompletionMetadata) : null;
}

export function renderPublicationMarker(marker: PublicationMarker): string {
  if (!validPublicationMarker(marker)) {
    throw new Error("Ticket Publication Marker is invalid.");
  }
  const normalized: PublicationMarker = {
    afterHead: marker.afterHead,
    beforeHead: marker.beforeHead,
    integrationBranch: marker.integrationBranch,
    issue: marker.issue,
    runId: marker.runId,
    schemaVersion: 1,
    sessionId: marker.sessionId,
    type: "sandcastle-ticket-publication",
  };
  return `${markerPrefix}${JSON.stringify(normalized)}${markerSuffix}`;
}

export function parsePublicationMarker(
  body: string,
): PublicationMarker | null {
  if (!body.includes("<!-- sandcastle-ticket-publication")) return null;
  if (!body.startsWith(markerPrefix) || !body.endsWith(markerSuffix)) {
    throw new Error("Ticket Publication Marker encoding is invalid.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(
      body.slice(markerPrefix.length, -markerSuffix.length),
    );
  } catch {
    throw new Error("Ticket Publication Marker encoding is invalid.");
  }
  if (!validPublicationMarker(candidate)) {
    throw new Error("Ticket Publication Marker facts are invalid.");
  }
  return candidate;
}

export function validPublicationMarker(
  candidate: unknown,
): candidate is PublicationMarker {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !exactKeys(candidate, [
      "afterHead",
      "beforeHead",
      "integrationBranch",
      "issue",
      "runId",
      "schemaVersion",
      "sessionId",
      "type",
    ])
  ) {
    return false;
  }
  const marker = candidate as Partial<PublicationMarker>;
  return (
    validMetadata(marker) &&
    objectIdPattern.test(marker.afterHead ?? "") &&
    typeof marker.integrationBranch === "string" &&
    marker.integrationBranch.length > 0 &&
    marker.schemaVersion === 1 &&
    marker.type === "sandcastle-ticket-publication"
  );
}

export function renderFinalReviewMarker(marker: FinalReviewMarker): string {
  if (
    !objectIdPattern.test(marker.baseHead) ||
    !objectIdPattern.test(marker.integrationHead) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(marker.runId) ||
    marker.schemaVersion !== 1 ||
    marker.type !== "sandcastle-final-review" ||
    (marker.verdict !== "pass" && marker.verdict !== "needs-fix")
  ) {
    throw new Error("Final Review Marker is invalid.");
  }
  return `<!-- sandcastle-final-review\n${JSON.stringify(marker)}\n-->`;
}

export function parseFinalReviewMarker(
  body: string,
): FinalReviewMarker | null {
  const prefix = "<!-- sandcastle-final-review\n";
  if (!body.includes("<!-- sandcastle-final-review")) return null;
  if (!body.startsWith(prefix) || !body.endsWith(markerSuffix)) {
    throw new Error("Final Review Marker encoding is invalid.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(body.slice(prefix.length, -markerSuffix.length));
  } catch {
    throw new Error("Final Review Marker encoding is invalid.");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !exactKeys(candidate, [
      "baseHead",
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
