import {
  finalizeBatch,
  type FinalizeBatchResult,
  type FinalizeBatchState,
} from "../batch/finalize.js";
import { ConfigurationError, InfrastructureError } from "../config.js";
import { isGitObjectId } from "../git/object-id.js";
import { executeWorkflowCapability } from "./security.js";
import { WorkflowGitHubClient } from "./github.js";

const activeRefPath = "heads/sandcastle%2Factive";

interface GitHubPullRequest {
  head?: { ref?: string; sha?: string };
  merged?: boolean;
  number?: number;
  state?: string;
}

interface GitHubReference {
  object?: { sha?: string };
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

async function readFinalizeState(
  client: WorkflowGitHubClient,
  pullRequest: number,
): Promise<FinalizeBatchState> {
  const [pull, active] = await Promise.all([
    client.get<GitHubPullRequest>(
      `/repos/${client.repository}/pulls/${pullRequest}`,
    ),
    client.get<GitHubReference>(
      `/repos/${client.repository}/git/ref/${activeRefPath}`,
      [200, 404],
    ),
  ]);
  const activeHead = active.status === 404 ? null : active.data?.object?.sha;
  if (activeHead !== null && !isGitObjectId(activeHead)) {
    throw infrastructureError(
      "BATCH_FINALIZE_STATE_INVALID",
      "GitHub returned an invalid active Batch ref during finalization.",
    );
  }
  return {
    activeHead,
    pullRequest: {
      head: pull.data?.head?.sha ?? "",
      headBranch: pull.data?.head?.ref ?? "",
      merged: pull.data?.merged ?? false,
      number: pull.data?.number ?? 0,
      state: pull.data?.state === "closed" ? "closed" : "open",
    },
  };
}

async function releaseActiveBatch(
  client: WorkflowGitHubClient,
  expectedHead: string,
): Promise<"already-released" | "released"> {
  const active = await client.get<GitHubReference>(
    `/repos/${client.repository}/git/ref/${activeRefPath}`,
    [200, 404],
  );
  if (active.status === 404) return "already-released";
  if (active.data?.object?.sha !== expectedHead) {
    throw configurationError(
      "BATCH_FINALIZE_ACTIVE_REF_MISMATCH",
      "The active Batch ref belongs to a different Batch HEAD.",
    );
  }
  await executeWorkflowCapability(
    {
      boundary: "host",
      capability: "release-batch",
      operation: "finalize-batch",
    },
    () =>
      client.delete(
        `/repos/${client.repository}/git/refs/${activeRefPath}`,
      ),
  );
  return "released";
}

export interface RunWorkflowFinalizeBatchOptions {
  batchId: string;
  environment: NodeJS.ProcessEnv;
  expectedHead: string;
  pullRequest: number;
}

export async function runWorkflowFinalizeBatch(
  options: RunWorkflowFinalizeBatchOptions,
): Promise<FinalizeBatchResult> {
  const client = new WorkflowGitHubClient(options.environment);
  return finalizeBatch(
    {
      batchId: options.batchId,
      expectedHead: options.expectedHead,
      pullRequest: options.pullRequest,
    },
    {
      readState: () => readFinalizeState(client, options.pullRequest),
      releaseActiveBatch: (expectedHead) =>
        releaseActiveBatch(client, expectedHead),
    },
  );
}
