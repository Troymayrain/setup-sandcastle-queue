import { DefaultArtifactClient } from "@actions/artifact";
import { dirname } from "node:path";

import { InfrastructureError } from "../config.js";

export interface WorkflowArtifactRequest {
  name: string;
  path: string;
  retentionDays: number;
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

/** Upload one host-produced file with the current GitHub Actions run identity. */
export async function uploadWorkflowArtifact(
  request: WorkflowArtifactRequest,
): Promise<{ artifactId: string }> {
  let response: Awaited<ReturnType<DefaultArtifactClient["uploadArtifact"]>>;
  try {
    response = await new DefaultArtifactClient().uploadArtifact(
      request.name,
      [request.path],
      dirname(request.path),
      {
        compressionLevel: 9,
        retentionDays: request.retentionDays,
      },
    );
  } catch {
    throw infrastructureError(
      "ACTIONS_ARTIFACT_UPLOAD_FAILED",
      "GitHub Actions rejected the host-produced artifact upload.",
    );
  }
  if (!Number.isSafeInteger(response.id) || (response.id ?? 0) <= 0) {
    throw infrastructureError(
      "ACTIONS_ARTIFACT_UPLOAD_INVALID",
      "GitHub Actions returned an invalid artifact identity.",
    );
  }
  return { artifactId: String(response.id) };
}
