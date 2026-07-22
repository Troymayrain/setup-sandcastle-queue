import { execFile } from "node:child_process";

import { ConfigurationError, InfrastructureError } from "../config.js";
import { resolveRepositoryRoot } from "../installer/plan.js";
import {
  dispatchBatchContinuation,
  readBatchRunState,
} from "./github-run.js";
import type {
  BatchRunState,
  BatchTicketExecution,
  RunBatchRuntime,
} from "./run.js";

export interface HostBatchRuntimeOptions {
  configPath: string;
  ticketDriver: string[];
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function runTicketDriver(
  repository: string,
  command: string[],
  arguments_: string[],
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<BatchTicketExecution> {
  return new Promise((resolve, reject) => {
    execFile(
      command[0] as string,
      [...command.slice(1), ...arguments_],
      {
        cwd: repository,
        encoding: "utf8",
        env: environment,
        maxBuffer: 1024 * 1024,
        signal,
      },
      (error, stdout) => {
        if (error) {
          reject(
            infrastructureError(
              "TICKET_DRIVER_FAILED",
              "The host Ticket driver exited unsuccessfully.",
            ),
          );
          return;
        }
        let candidate: unknown;
        try {
          const parsed = JSON.parse(stdout) as unknown;
          candidate =
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed) &&
            "result" in parsed
              ? (parsed as { result: unknown }).result
              : parsed;
        } catch {
          reject(
            configurationError(
              "TICKET_DRIVER_RESULT_INVALID",
              "The host Ticket driver did not return machine-readable JSON.",
            ),
          );
          return;
        }
        resolve(candidate as BatchTicketExecution);
      },
    );
  });
}

export async function createHostBatchRuntime(
  repositoryPath: string,
  options: HostBatchRuntimeOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RunBatchRuntime> {
  if (!Array.isArray(options.ticketDriver) || options.ticketDriver.length === 0) {
    throw configurationError(
      "TICKET_DRIVER_INVALID",
      "Batch processing requires a direct host Ticket driver command.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  let currentState: BatchRunState | undefined;
  return {
    async dispatchContinuation(input) {
      if (!currentState) {
        throw configurationError(
          "CONTINUATION_STATE_MISSING",
          "A continuation cannot be dispatched before GitHub state is read.",
        );
      }
      await dispatchBatchContinuation(root, currentState, input, environment);
    },
    async processTicket({ batchId, beforeHead, number, signal }) {
      return runTicketDriver(
        root,
        options.ticketDriver,
        [
          "--batch-id",
          batchId,
          "--ticket",
          String(number),
          "--before-head",
          beforeHead,
        ],
        signal,
        environment,
      );
    },
    async readState(_repositoryPath, batchId) {
      currentState = await readBatchRunState(
        root,
        batchId,
        options.configPath,
        environment,
      );
      return currentState;
    },
  };
}
