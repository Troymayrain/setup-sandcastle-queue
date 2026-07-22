import { ConfigurationError, InfrastructureError } from "../config.js";
import { isGitObjectId } from "../git/object-id.js";
import { hasExactShape } from "../json.js";

const batchIdPattern = /^p[1-9][0-9]*-[a-f0-9]{12}-r[1-9][0-9]*$/u;

export interface FinalizeBatchOptions {
  batchId: string;
  expectedHead: string;
  pullRequest: number;
}

export interface FinalizeBatchState {
  activeHead: string | null;
  pullRequest: {
    head: string;
    headBranch: string;
    merged: boolean;
    number: number;
    state: "closed" | "open";
  };
}

export interface FinalizeBatchRuntime {
  readState: () => Promise<FinalizeBatchState>;
  releaseActiveBatch: (
    expectedHead: string,
  ) => Promise<"already-released" | "released">;
}

export interface FinalizeBatchResult {
  batchId: string;
  head: string;
  pullRequest: number;
  status: "already-finalized" | "finalized";
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function validateState(
  state: FinalizeBatchState,
  options: FinalizeBatchOptions,
): void {
  if (
    !hasExactShape(state, ["activeHead", "pullRequest"]) ||
    (state.activeHead !== null && !isGitObjectId(state.activeHead)) ||
    !hasExactShape(state.pullRequest, [
      "head",
      "headBranch",
      "merged",
      "number",
      "state",
    ]) ||
    state.pullRequest.head !== options.expectedHead ||
    state.pullRequest.headBranch !== `sandcastle/${options.batchId}` ||
    state.pullRequest.merged !== true ||
    state.pullRequest.number !== options.pullRequest ||
    state.pullRequest.state !== "closed"
  ) {
    throw infrastructureError(
      "BATCH_FINALIZE_STATE_INVALID",
      "Batch finalization requires the exact closed and merged Batch pull request.",
    );
  }
  if (
    state.activeHead !== null &&
    state.activeHead !== options.expectedHead
  ) {
    throw configurationError(
      "BATCH_FINALIZE_ACTIVE_REF_MISMATCH",
      "The active Batch ref belongs to a different Batch HEAD.",
    );
  }
}

export async function finalizeBatch(
  options: FinalizeBatchOptions,
  runtime: FinalizeBatchRuntime,
): Promise<FinalizeBatchResult> {
  if (
    !batchIdPattern.test(options.batchId) ||
    !isGitObjectId(options.expectedHead) ||
    !Number.isSafeInteger(options.pullRequest) ||
    options.pullRequest <= 0
  ) {
    throw configurationError(
      "BATCH_FINALIZE_INPUT_INVALID",
      "Batch finalization requires a canonical Batch, HEAD, and pull request.",
    );
  }
  const state = await runtime.readState();
  validateState(state, options);
  const released = await runtime.releaseActiveBatch(options.expectedHead);
  if (released !== "already-released" && released !== "released") {
    throw infrastructureError(
      "BATCH_FINALIZE_RELEASE_INVALID",
      "Batch finalization returned an invalid active-ref release result.",
    );
  }
  return {
    batchId: options.batchId,
    head: options.expectedHead,
    pullRequest: options.pullRequest,
    status: released === "released" ? "finalized" : "already-finalized",
  };
}
