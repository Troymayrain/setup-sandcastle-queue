const objectIdPattern = /^[0-9a-f]{40}$/u;
const markerPrefix = "<!-- sandcastle-final-review\n";
const markerSuffix = "\n-->";

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
  return `${markerPrefix}${JSON.stringify(marker)}${markerSuffix}`;
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
