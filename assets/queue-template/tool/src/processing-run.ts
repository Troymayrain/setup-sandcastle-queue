import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withoutExecutionCredentials } from "./credential-environment.js";
import type { DeadlineLifecycle } from "./deadline.js";
import {
  ensureIntegrationPullRequest,
  type DraftPullRequest,
  type IntegrationPullRequest,
} from "./integration-pull-request.js";
import type {
  CompletionMetadata,
  PublicationMarker,
} from "./publication-facts.js";
import {
  executeWorkUnit,
  type WorkUnitOptions,
  type WorkUnitResult,
} from "./work-unit.js";

const objectIdPattern = /^[0-9a-f]{40}$/u;

export interface CommandSpec {
  argv: string[];
}

export interface TicketHostBoundary {
  annotateCompletionCommit(metadata: CompletionMetadata): Promise<string>;
  checkoutIntegration(branch: string, head: string): Promise<void>;
  closeIssue(issue: number): Promise<void>;
  commitParents(commit: string): Promise<string[]>;
  createDraftPullRequest(input: {
    base: string;
    head: string;
    title: string;
  }): Promise<DraftPullRequest>;
  createIntegrationBranch(branch: string, head: string): Promise<string>;
  createPublicationMarker(
    issue: number,
    marker: PublicationMarker,
  ): Promise<{ id: number }>;
  isClean(): Promise<boolean>;
  listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]>;
  localHead(): Promise<string>;
  pushIntegration(branch: string, before: string, after: string): Promise<string>;
  remoteHead(branch: string): Promise<string | null>;
  runCommand(
    argv: string[],
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface ProcessingRunOptions {
  baseBranch: string;
  commands: {
    bootstrap: CommandSpec[];
    test: CommandSpec[];
    verification: CommandSpec[];
  };
  environment: NodeJS.ProcessEnv;
  integrationBranch: string;
  lifecycle?: DeadlineLifecycle;
  model: string;
  promptFile: string;
  repository: string;
  ticket: {
    body: string;
    number: number;
  };
}

export interface ProcessingRunResult {
  beforeHead: string;
  completionCommit: string;
  markerCommentId: number;
  pullRequest: DraftPullRequest;
  sessionId: string;
  status: "published";
  ticket: number;
}

type WorkUnitExecutor = (options: WorkUnitOptions) => Promise<WorkUnitResult>;

function assertObjectId(value: string | null, fact: string): asserts value is string {
  if (!value || !objectIdPattern.test(value)) {
    throw new Error(`A complete ${fact} commit is required.`);
  }
}

async function runCommands(
  commands: CommandSpec[],
  boundary: TicketHostBoundary,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  for (const { argv } of commands) {
    await boundary.runCommand([...argv], environment, signal);
  }
}

async function ticketPrompt(
  basePromptFile: string,
  ticket: ProcessingRunOptions["ticket"],
): Promise<{ path: string; remove(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "sandcastle-ticket-prompt-"));
  const path = join(directory, "ticket.md");
  const base = await readFile(basePromptFile, "utf8");
  await writeFile(
    path,
    `${base.trimEnd()}\n\n## Selected GitHub Ticket #${ticket.number}\n\n${ticket.body.trim()}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    path,
    remove: () => rm(directory, { force: true, recursive: true }),
  };
}

async function integrationHead(
  options: ProcessingRunOptions,
  boundary: TicketHostBoundary,
): Promise<string> {
  const baseHead = await boundary.remoteHead(options.baseBranch);
  assertObjectId(baseHead, "base HEAD");
  let head = await boundary.remoteHead(options.integrationBranch);
  if (head === null) {
    head = await boundary.createIntegrationBranch(
      options.integrationBranch,
      baseHead,
    );
    if (head !== baseHead) {
      throw new Error("The create-only Integration Branch was not created at the base HEAD.");
    }
  }
  assertObjectId(head, "Integration Branch HEAD");
  return head;
}

function validateAgentCompletion(
  beforeHead: string,
  afterHead: string,
  parents: string[],
  workUnit: WorkUnitResult,
  clean: boolean,
): void {
  if (
    !objectIdPattern.test(afterHead) ||
    afterHead === beforeHead ||
    workUnit.commits.length !== 1 ||
    workUnit.commits[0] !== afterHead ||
    parents.length !== 1 ||
    parents[0] !== beforeHead ||
    !clean
  ) {
    throw new Error(
      "Ticket completion must be one clean, attributable commit parented by before_head.",
    );
  }
}

export async function executeProcessingRun(
  options: ProcessingRunOptions,
  boundary: TicketHostBoundary,
  runWorkUnit: WorkUnitExecutor = executeWorkUnit,
): Promise<ProcessingRunResult> {
  const beforeHead = await integrationHead(options, boundary);
  options.lifecycle?.onBeforeHead(beforeHead);
  await boundary.checkoutIntegration(options.integrationBranch, beforeHead);

  const commandEnvironment = withoutExecutionCredentials(options.environment);
  await runCommands(
    options.commands.bootstrap,
    boundary,
    commandEnvironment,
    options.lifecycle?.signal,
  );

  const prompt = await ticketPrompt(options.promptFile, options.ticket);
  let workUnit: WorkUnitResult;
  try {
    workUnit = await runWorkUnit({
      cwd: options.repository,
      environment: options.environment,
      model: options.model,
      promptFile: prompt.path,
      role: "ticket",
      signal: options.lifecycle?.signal,
    });
  } finally {
    await prompt.remove();
  }

  await runCommands(
    options.commands.test,
    boundary,
    commandEnvironment,
    options.lifecycle?.signal,
  );
  await runCommands(
    options.commands.verification,
    boundary,
    commandEnvironment,
    options.lifecycle?.signal,
  );

  const afterHead = await boundary.localHead();
  const [parents, clean] = await Promise.all([
    boundary.commitParents(afterHead),
    boundary.isClean(),
  ]);
  validateAgentCompletion(beforeHead, afterHead, parents, workUnit, clean);
  if (options.lifecycle?.signal.aborted) {
    throw new Error("Ticket deadline reached before Host finalization.");
  }
  options.lifecycle?.onExecutionComplete();

  const runId = options.environment.GITHUB_RUN_ID;
  if (!runId) {
    throw new Error("GITHUB_RUN_ID is required for immutable publication metadata.");
  }
  const completionCommit = await boundary.annotateCompletionCommit({
    beforeHead,
    issue: options.ticket.number,
    runId,
    sessionId: workUnit.sessionId,
  });
  const [completionParents, completionClean] = await Promise.all([
    boundary.commitParents(completionCommit),
    boundary.isClean(),
  ]);
  if (
    !objectIdPattern.test(completionCommit) ||
    completionCommit === beforeHead ||
    completionParents.length !== 1 ||
    completionParents[0] !== beforeHead ||
    !completionClean
  ) {
    throw new Error("Host completion metadata changed the proven commit history.");
  }

  if ((await boundary.remoteHead(options.integrationBranch)) !== beforeHead) {
    throw new Error("The Integration Branch changed before publication.");
  }
  const visibleHead = await boundary.pushIntegration(
    options.integrationBranch,
    beforeHead,
    completionCommit,
  );
  if (visibleHead !== completionCommit) {
    throw new Error("Remote Integration Branch verification failed after push.");
  }

  const marker: PublicationMarker = {
    afterHead: completionCommit,
    beforeHead,
    integrationBranch: options.integrationBranch,
    issue: options.ticket.number,
    runId,
    schemaVersion: 1,
    sessionId: workUnit.sessionId,
    type: "sandcastle-ticket-publication",
  };
  const pullRequest = await ensureIntegrationPullRequest(options, boundary);
  if (!pullRequest) {
    throw new Error("The unique Integration pull request is not an open draft.");
  }
  const markerComment = await boundary.createPublicationMarker(
    options.ticket.number,
    marker,
  );
  await boundary.closeIssue(options.ticket.number);

  return {
    beforeHead,
    completionCommit,
    markerCommentId: markerComment.id,
    pullRequest,
    sessionId: workUnit.sessionId,
    status: "published",
    ticket: options.ticket.number,
  };
}
