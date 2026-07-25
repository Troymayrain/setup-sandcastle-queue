import {
  orchestrateProcessingRun,
  processingRunInputError,
  type ContinuationBoundary,
  type ProcessingRunInvocation,
} from "./continuation.js";
import { runWithTicketDeadline } from "./deadline.js";
import {
  orchestrateFinalFix,
  type FinalFixBoundary,
} from "./final-fix.js";
import {
  orchestrateFinalRereview,
  type FinalRereviewBoundary,
} from "./final-rereview.js";
import {
  orchestrateFirstFinalReview,
  type FinalReviewBoundary,
} from "./final-review.js";
import {
  nextFinalOperation,
  type FinalOperationBoundary,
} from "./finalization.js";
import {
  activateAndSelectFrontier,
  type FrontierGitHub,
} from "./frontier.js";
import {
  executeProcessingRun,
  type CommandSpec,
  type TicketHostBoundary,
} from "./processing-run.js";
import {
  inspectPublicationAtDeadline,
  reconcilePublication,
  type ReconciliationBoundary,
} from "./reconciliation.js";
import type {
  WorkUnitOptions,
  WorkUnitResult,
} from "./work-unit.js";

export interface WorkflowHostConfig {
  commands: {
    bootstrap: CommandSpec[];
    test: CommandSpec[];
    verification: CommandSpec[];
  };
  execution: {
    hostFinalizationReserveMinutes: number;
  };
  queue: {
    ownershipLabel: string;
    readyLabel: string;
  };
  repository: {
    baseBranch: string;
    integrationBranch: string;
  };
  models: {
    finalFix: string;
    finalReview: string;
    ticket: string;
  };
}

export type WorkflowHostOperation =
  | "start"
  | "continue"
  | "resume"
  | "final-review"
  | "final-fix"
  | "final-rereview";

export interface WorkflowHostRequest {
  config: WorkflowHostConfig;
  environment: NodeJS.ProcessEnv;
  expectedHead?: string;
  operation: WorkflowHostOperation;
  predecessorRunId?: string;
  promptFiles: {
    finalFix: string;
    finalReview: string;
    ticket: string;
  };
  repository: string;
}

type GitHubBoundary = ContinuationBoundary &
  FinalOperationBoundary &
  FrontierGitHub &
  ReconciliationBoundary;

type IntegrationHostBoundary = FinalFixBoundary & TicketHostBoundary;
type ReviewHostBoundary = FinalRereviewBoundary & FinalReviewBoundary;
type WorkUnitExecutor = (
  options: WorkUnitOptions,
) => Promise<WorkUnitResult>;

export interface WorkflowHostBindings {
  finalReviewHost: ReviewHostBoundary;
  github: GitHubBoundary;
  integrationHost: IntegrationHostBoundary;
  runWorkUnit: WorkUnitExecutor;
}

export type WorkflowHostBindingsSource =
  | WorkflowHostBindings
  | (() => WorkflowHostBindings);

function resolveBindings(
  source: WorkflowHostBindingsSource,
): WorkflowHostBindings {
  return typeof source === "function" ? source() : source;
}

function selectFrontier(
  request: WorkflowHostRequest,
  github: FrontierGitHub,
  activate: boolean,
) {
  return activateAndSelectFrontier(
    github,
    {
      ownership: request.config.queue.ownershipLabel,
      ready: request.config.queue.readyLabel,
    },
    activate,
  );
}

export async function executeWorkflowHostOperation(
  request: WorkflowHostRequest,
  bindingsSource: WorkflowHostBindingsSource,
) {
  const { config, environment } = request;
  const expectedHead = request.expectedHead ?? "";
  const predecessorRunId = request.predecessorRunId ?? "";

  if (request.operation === "final-review") {
    const bindings = resolveBindings(bindingsSource);
    return orchestrateFirstFinalReview(
      {
        baseBranch: config.repository.baseBranch,
        commands: config.commands,
        environment,
        expectedHead,
        integrationBranch: config.repository.integrationBranch,
        model: config.models.finalReview,
        predecessorRunId,
        promptFile: request.promptFiles.finalReview,
      },
      bindings.finalReviewHost,
      () => selectFrontier(request, bindings.github, false),
      bindings.runWorkUnit,
    );
  }

  if (request.operation === "final-fix") {
    const bindings = resolveBindings(bindingsSource);
    return orchestrateFinalFix(
      {
        baseBranch: config.repository.baseBranch,
        commands: config.commands,
        environment,
        expectedHead,
        integrationBranch: config.repository.integrationBranch,
        model: config.models.finalFix,
        predecessorRunId,
        promptFile: request.promptFiles.finalFix,
        repository: request.repository,
      },
      bindings.integrationHost,
      () => selectFrontier(request, bindings.github, false),
      bindings.runWorkUnit,
    );
  }

  if (request.operation === "final-rereview") {
    const bindings = resolveBindings(bindingsSource);
    return orchestrateFinalRereview(
      {
        baseBranch: config.repository.baseBranch,
        commands: config.commands,
        environment,
        expectedHead,
        integrationBranch: config.repository.integrationBranch,
        model: config.models.finalReview,
        predecessorRunId,
        promptFile: request.promptFiles.finalReview,
      },
      bindings.finalReviewHost,
      () => selectFrontier(request, bindings.github, false),
      bindings.runWorkUnit,
    );
  }

  const invocation: ProcessingRunInvocation = {
    baseBranch: config.repository.baseBranch,
    expectedHead: request.expectedHead,
    integrationBranch: config.repository.integrationBranch,
    operation: request.operation,
    predecessorRunId: request.predecessorRunId,
    runId: environment.GITHUB_RUN_ID ?? "",
  };
  const inputError = processingRunInputError(invocation);
  if (inputError) {
    return { reason: inputError, status: "conflict" as const };
  }
  const hardDeadlineAtMs = Number(
    environment.SANDCASTLE_JOB_HARD_DEADLINE_MS,
  );
  if (!Number.isFinite(hardDeadlineAtMs) || hardDeadlineAtMs <= 0) {
    return {
      reason: "invalid-job-hard-deadline",
      status: "conflict" as const,
    };
  }
  const bindings = resolveBindings(bindingsSource);

  return orchestrateProcessingRun(
    invocation,
    bindings.github,
    {
      finalize: () =>
        nextFinalOperation(
          {
            baseBranch: config.repository.baseBranch,
            integrationBranch: config.repository.integrationBranch,
          },
          bindings.github,
        ),
      process: (ticket) =>
        runWithTicketDeadline(
          {
            hardDeadlineAtMs,
            reserveMinutes:
              config.execution.hostFinalizationReserveMinutes,
            ticket: ticket.number,
          },
          (lifecycle) =>
            executeProcessingRun(
              {
                baseBranch: config.repository.baseBranch,
                commands: config.commands,
                environment,
                integrationBranch: config.repository.integrationBranch,
                lifecycle,
                model: config.models.ticket,
                promptFile: request.promptFiles.ticket,
                repository: request.repository,
                ticket,
              },
              bindings.integrationHost,
              bindings.runWorkUnit,
            ),
          ({ beforeHead, ticket: expectedTicket }) =>
            inspectPublicationAtDeadline(
              {
                beforeHead,
                integrationBranch: config.repository.integrationBranch,
                ticket: expectedTicket,
              },
              bindings.github,
            ),
        ),
      reconcile: () =>
        reconcilePublication(
          {
            baseBranch: config.repository.baseBranch,
            integrationBranch: config.repository.integrationBranch,
          },
          bindings.github,
        ),
      select: (activate) =>
        selectFrontier(request, bindings.github, activate),
    },
  );
}
