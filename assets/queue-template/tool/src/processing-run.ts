import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withoutExecutionCredentials } from "./credential-environment.js";
import {
  executeWorkUnit,
  type WorkUnitOptions,
  type WorkUnitResult,
} from "./work-unit.js";

const objectIdPattern = /^[0-9a-f]{40}$/u;

export interface CommandSpec {
  argv: string[];
}

export interface PublicationMarker {
  afterHead: string;
  beforeHead: string;
  integrationBranch: string;
  issue: number;
  runId: string;
  schemaVersion: 1;
  sessionId: string;
  type: "sandcastle-ticket-publication";
}

export interface IntegrationPullRequest {
  draft: boolean;
  number: number;
  state?: string;
  url: string;
}

export interface DraftPullRequest extends IntegrationPullRequest {
  draft: true;
}

export interface TicketHostBoundary {
  checkoutIntegration(branch: string, head: string): Promise<void>;
  closeIssue(issue: number): Promise<void>;
  commitParents(commit: string): Promise<string[]>;
  createDraftPullRequest(input: {
    base: string;
    head: string;
    title: string;
  }): Promise<DraftPullRequest>;
  createIntegrationBranch(branch: string, head: string): Promise<void>;
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
  pushIntegration(branch: string, before: string, after: string): Promise<void>;
  remoteHead(branch: string): Promise<string | null>;
  runCommand(argv: string[], environment: NodeJS.ProcessEnv): Promise<void>;
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
): Promise<void> {
  for (const { argv } of commands) {
    await boundary.runCommand([...argv], environment);
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
    await boundary.createIntegrationBranch(options.integrationBranch, baseHead);
    head = await boundary.remoteHead(options.integrationBranch);
    if (head !== baseHead) {
      throw new Error("The create-only Integration Branch is not visible at the base HEAD.");
    }
  }
  assertObjectId(head, "Integration Branch HEAD");
  return head;
}

function validateCompletion(
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

async function ensureDraftPullRequest(
  options: ProcessingRunOptions,
  boundary: TicketHostBoundary,
): Promise<DraftPullRequest> {
  const input = {
    base: options.baseBranch,
    head: options.integrationBranch,
  };
  const existing = await boundary.listIntegrationPullRequests(input);
  if (existing.length > 1) {
    throw new Error("More than one Integration pull request exists.");
  }
  if (existing[0]) {
    if (existing[0].draft !== true || existing[0].state === "closed") {
      throw new Error("The Integration pull request is not a draft.");
    }
    return { ...existing[0], draft: true };
  }
  const created = await boundary.createDraftPullRequest({
    ...input,
    title: "Sandcastle Queue integration",
  });
  if (created.draft !== true) {
    throw new Error("GitHub did not create a draft Integration pull request.");
  }
  return created;
}

export async function executeProcessingRun(
  options: ProcessingRunOptions,
  boundary: TicketHostBoundary,
  runWorkUnit: WorkUnitExecutor = executeWorkUnit,
): Promise<ProcessingRunResult> {
  const beforeHead = await integrationHead(options, boundary);
  await boundary.checkoutIntegration(options.integrationBranch, beforeHead);

  const commandEnvironment = withoutExecutionCredentials(options.environment);
  await runCommands(options.commands.bootstrap, boundary, commandEnvironment);

  const prompt = await ticketPrompt(options.promptFile, options.ticket);
  let workUnit: WorkUnitResult;
  try {
    workUnit = await runWorkUnit({
      cwd: options.repository,
      environment: options.environment,
      model: options.model,
      promptFile: prompt.path,
      role: "ticket",
    });
  } finally {
    await prompt.remove();
  }

  await runCommands(options.commands.test, boundary, commandEnvironment);
  await runCommands(options.commands.verification, boundary, commandEnvironment);

  const afterHead = await boundary.localHead();
  const [parents, clean] = await Promise.all([
    boundary.commitParents(afterHead),
    boundary.isClean(),
  ]);
  validateCompletion(beforeHead, afterHead, parents, workUnit, clean);

  if ((await boundary.remoteHead(options.integrationBranch)) !== beforeHead) {
    throw new Error("The Integration Branch changed before publication.");
  }
  await boundary.pushIntegration(
    options.integrationBranch,
    beforeHead,
    afterHead,
  );
  const visibleHead = await boundary.remoteHead(options.integrationBranch);
  if (visibleHead !== afterHead) {
    throw new Error("Remote Integration Branch verification failed after push.");
  }

  const runId = options.environment.GITHUB_RUN_ID;
  if (!runId) {
    throw new Error("GITHUB_RUN_ID is required for immutable publication metadata.");
  }
  const marker: PublicationMarker = {
    afterHead,
    beforeHead,
    integrationBranch: options.integrationBranch,
    issue: options.ticket.number,
    runId,
    schemaVersion: 1,
    sessionId: workUnit.sessionId,
    type: "sandcastle-ticket-publication",
  };
  const markerComment = await boundary.createPublicationMarker(
    options.ticket.number,
    marker,
  );
  const pullRequest = await ensureDraftPullRequest(options, boundary);
  await boundary.closeIssue(options.ticket.number);

  return {
    beforeHead,
    completionCommit: afterHead,
    markerCommentId: markerComment.id,
    pullRequest,
    sessionId: workUnit.sessionId,
    status: "published",
    ticket: options.ticket.number,
  };
}
