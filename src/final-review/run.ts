import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  InfrastructureError,
  readProjectConfig,
  type CommandSpec,
} from "../config.js";
import { sha256 } from "../hash.js";
import { resolveRepositoryRoot } from "../installer/plan.js";

const batchIdPattern = /^p([1-9][0-9]*)-[a-f0-9]{12}-r[1-9][0-9]*$/u;
const gitShaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const sessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export interface FinalReviewTicketState {
  number: number;
  state: "closed" | "open";
}

export interface FinalReviewState {
  batchHead: string;
  batchId: string;
  parent: number;
  pullRequest: {
    draft: boolean;
    number: number;
  };
  targetBase: string;
  tickets: FinalReviewTicketState[];
}

export interface FinalReviewDispatchInput {
  batchHead: string;
  batchId: string;
  pullRequest: number;
  targetBase: string;
}

export interface FinalReviewDispatchRuntime {
  dispatch: (input: FinalReviewDispatchInput) => Promise<void> | void;
  readState: (
    repositoryPath: string,
    batchId: string,
  ) => Promise<FinalReviewState>;
}

export interface CumulativeReviewSpecification {
  content: string;
  marker: "sandcastle-final-review-spec";
  parent: number;
  schemaVersion: 1;
  specHash: string;
  tickets: number[];
}

export type FinalReviewAxis = "Spec" | "Standards";

export interface FinalReviewFinding {
  actionable: boolean;
  code: string;
  message: string;
  path?: string;
}

export interface FinalReviewAxisInput {
  axis: FinalReviewAxis;
  batchHead: string;
  batchId: string;
  reviewedHead: string;
  specification: CumulativeReviewSpecification;
  targetBase: string;
  verificationHash: string;
  workspacePath: string;
}

export interface FinalReviewAxisResult {
  axis: FinalReviewAxis;
  findings: FinalReviewFinding[];
  marker: "sandcastle-final-review-result";
  reviewedHead: string;
  schemaVersion: 1;
  sessionId: string;
  skill: {
    ok: true;
    receiptId: string;
  };
  specificationHash: string;
  verificationHash: string;
}

export interface FinalReviewOptions extends FinalReviewDispatchInput {
  configPath: string;
  specification: CumulativeReviewSpecification;
}

export interface MarkPullRequestReadyInput extends FinalReviewDispatchInput {
  reviewedHead: string;
  verificationHash: string;
}

export interface FinalReviewRuntime {
  markPullRequestReady: (
    input: MarkPullRequestReadyInput,
  ) => Promise<void> | void;
  readState: (
    repositoryPath: string,
    batchId: string,
  ) => Promise<FinalReviewState>;
  reviewAxis: (
    input: FinalReviewAxisInput,
  ) => Promise<FinalReviewAxisResult>;
}

interface FinalReviewCompletedResult {
  axes: {
    Spec: FinalReviewAxisResult;
    Standards: FinalReviewAxisResult;
  };
  batchHead: string;
  batchId: string;
  pullRequest: number;
  reviewedHead: string;
  targetBase: string;
  verificationHash: string;
}

export type FinalReviewResult =
  | (FinalReviewCompletedResult & {
      actionableFindings: FinalReviewFinding[];
      status: "findings";
    })
  | (FinalReviewCompletedResult & { status: "passed" })
  | {
      batchId: string;
      openTickets: number[];
      status: "tickets-changed";
    };

interface CommandResult {
  exitCode: number;
  stdout: string;
}

interface VerificationRecord {
  argvSha256: string;
  exitCode: number;
  group: "tests" | "verification";
  index: number;
}

export type FinalReviewDispatchResult =
  | (FinalReviewDispatchInput & { status: "dispatched" })
  | {
      batchId: string;
      openTickets: number[];
      status: "waiting-for-tickets";
    };

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactShape(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validateState(state: FinalReviewState, batchId: string): void {
  const match = batchId.match(batchIdPattern);
  if (
    !match ||
    !isRecord(state) ||
    state.batchId !== batchId ||
    state.parent !== Number(match[1]) ||
    !gitShaPattern.test(state.batchHead) ||
    !gitShaPattern.test(state.targetBase) ||
    state.pullRequest === null ||
    typeof state.pullRequest !== "object" ||
    state.pullRequest.draft !== true ||
    !Number.isSafeInteger(state.pullRequest.number) ||
    state.pullRequest.number <= 0 ||
    !Array.isArray(state.tickets) ||
    state.tickets.length === 0 ||
    !state.tickets.every(
      (ticket) =>
        isRecord(ticket) &&
        Number.isSafeInteger(ticket.number) &&
        (ticket.number as number) > 0 &&
        (ticket.state === "closed" || ticket.state === "open"),
    ) ||
    new Set(state.tickets.map(({ number }) => number)).size !== state.tickets.length
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_STATE_INVALID",
      "Authoritative Batch state is invalid for final review.",
    );
  }
}

function validateSpecification(
  specification: CumulativeReviewSpecification,
  state: FinalReviewState,
): void {
  const expectedTickets = state.tickets
    .map(({ number }) => number)
    .sort((left, right) => left - right);
  if (
    !hasExactShape(specification, [
      "content",
      "marker",
      "parent",
      "schemaVersion",
      "specHash",
      "tickets",
    ]) ||
    specification.schemaVersion !== 1 ||
    specification.marker !== "sandcastle-final-review-spec" ||
    specification.parent !== state.parent ||
    typeof specification.content !== "string" ||
    specification.content.length === 0 ||
    specification.content.length > 2 * 1024 * 1024 ||
    typeof specification.specHash !== "string" ||
    specification.specHash !== sha256(specification.content) ||
    !Array.isArray(specification.tickets) ||
    !specification.tickets.every(
      (ticket) => Number.isSafeInteger(ticket) && ticket > 0,
    ) ||
    canonicalJson([...specification.tickets].sort((left, right) => left - right)) !==
      canonicalJson(expectedTickets)
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_SPEC_INVALID",
      "Cumulative final review requires a complete trusted specification marker.",
    );
  }
}

function validateOptions(options: FinalReviewOptions): void {
  if (
    !batchIdPattern.test(options.batchId) ||
    !gitShaPattern.test(options.batchHead) ||
    !gitShaPattern.test(options.targetBase) ||
    !Number.isSafeInteger(options.pullRequest) ||
    options.pullRequest <= 0 ||
    typeof options.configPath !== "string" ||
    options.configPath.length === 0
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_INPUT_INVALID",
      "Final review run inputs are invalid.",
    );
  }
}

function assertFixedState(state: FinalReviewState, options: FinalReviewOptions): void {
  if (
    state.batchHead !== options.batchHead ||
    state.targetBase !== options.targetBase ||
    state.pullRequest.number !== options.pullRequest
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_STATE_STALE",
      "Final review inputs no longer match authoritative Batch state.",
    );
  }
}

function command(
  executable: string,
  arguments_: string[],
  cwd: string,
  options: {
    allowFailure?: boolean;
    environment?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      arguments_,
      {
        cwd,
        encoding: "utf8",
        env: options.environment,
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeout ?? 30_000,
      },
      (error, stdout) => {
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        if (error && !options.allowFailure) {
          reject(
            infrastructureError(
              "FINAL_REVIEW_COMMAND_FAILED",
              "A host command failed during cumulative final review.",
            ),
          );
          return;
        }
        resolve({ exitCode, stdout });
      },
    );
  });
}

function commitMergeTree(
  workspacePath: string,
  tree: string,
  targetBase: string,
  batchHead: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["commit-tree", tree, "-p", targetBase, "-p", batchHead],
      {
        cwd: workspacePath,
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_AUTHOR_EMAIL: "sandcastle@example.invalid",
          GIT_AUTHOR_NAME: "Sandcastle Final Review",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_EMAIL: "sandcastle@example.invalid",
          GIT_COMMITTER_NAME: "Sandcastle Final Review",
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.on("error", () =>
      reject(
        infrastructureError(
          "FINAL_REVIEW_MERGE_FAILED",
          "Unable to create the temporary final review merge commit.",
        ),
      ),
    );
    child.on("close", (status) => {
      const reviewedHead = stdout.trim();
      if (status !== 0 || !gitShaPattern.test(reviewedHead)) {
        reject(
          infrastructureError(
            "FINAL_REVIEW_MERGE_FAILED",
            "Unable to create the temporary final review merge commit.",
          ),
        );
        return;
      }
      resolve(reviewedHead);
    });
    child.stdin.end("Sandcastle cumulative final review\n");
  });
}

async function createMergeWorkspace(
  repositoryPath: string,
  targetBase: string,
  batchHead: string,
): Promise<{ reviewedHead: string; root: string; workspacePath: string }> {
  const repositoryRoot = await resolveRepositoryRoot(repositoryPath);
  const root = await mkdtemp(join(tmpdir(), "sandcastle-final-review-"));
  const workspacePath = join(root, "repository");
  try {
    await command(
      "git",
      ["clone", "--quiet", "--no-checkout", "--local", repositoryRoot, workspacePath],
      root,
    );
    await command("git", ["checkout", "--quiet", "--detach", targetBase], workspacePath);
    const merge = await command(
      "git",
      ["merge", "--quiet", "--no-commit", "--no-ff", batchHead],
      workspacePath,
      { allowFailure: true },
    );
    if (merge.exitCode !== 0) {
      throw infrastructureError(
        "FINAL_REVIEW_MERGE_CONFLICT",
        "The fixed Batch HEAD does not merge cleanly with the target base.",
      );
    }
    const tree = (await command("git", ["write-tree"], workspacePath)).stdout.trim();
    if (!gitShaPattern.test(tree)) {
      throw infrastructureError(
        "FINAL_REVIEW_MERGE_FAILED",
        "Unable to write the temporary final review merge tree.",
      );
    }
    const reviewedHead = await commitMergeTree(
      workspacePath,
      tree,
      targetBase,
      batchHead,
    );
    await command("git", ["reset", "--quiet", "--hard", reviewedHead], workspacePath);
    return { reviewedHead, root, workspacePath };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

function completionEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "ANTHROPIC_AUTH_TOKEN",
    "GITHUB_TOKEN",
    "SANDCASTLE_SESSION_TOKEN",
  ]) {
    delete environment[name];
  }
  return environment;
}

async function runCompletionCommands(
  workspacePath: string,
  commands: { tests: CommandSpec[]; verification: CommandSpec[] },
  timeoutMinutes: number,
): Promise<VerificationRecord[]> {
  const records: VerificationRecord[] = [];
  for (const group of ["tests", "verification"] as const) {
    for (const [index, spec] of commands[group].entries()) {
      const result = await command(spec.argv[0]!, spec.argv.slice(1), workspacePath, {
        allowFailure: true,
        environment: completionEnvironment(),
        timeout: timeoutMinutes * 60_000,
      });
      const record: VerificationRecord = {
        argvSha256: sha256(canonicalJson(spec.argv)),
        exitCode: result.exitCode,
        group,
        index,
      };
      records.push(record);
      if (result.exitCode !== 0) {
        throw infrastructureError(
          "FINAL_REVIEW_VERIFICATION_FAILED",
          "A configured final review completion command failed.",
        );
      }
    }
  }
  return records;
}

function validFinding(value: unknown): value is FinalReviewFinding {
  return (
    hasExactShape(value, ["actionable", "code", "message"], ["path"]) &&
    typeof value.actionable === "boolean" &&
    typeof value.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,127}$/u.test(value.code) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 4_000 &&
    (value.path === undefined ||
      (typeof value.path === "string" && value.path.length <= 1_024))
  );
}

function validateAxisResult(
  result: FinalReviewAxisResult,
  input: FinalReviewAxisInput,
): void {
  if (
    !hasExactShape(result, [
      "axis",
      "findings",
      "marker",
      "reviewedHead",
      "schemaVersion",
      "sessionId",
      "skill",
      "specificationHash",
      "verificationHash",
    ]) ||
    result.schemaVersion !== 1 ||
    result.marker !== "sandcastle-final-review-result" ||
    result.axis !== input.axis ||
    result.reviewedHead !== input.reviewedHead ||
    result.specificationHash !== input.specification.specHash ||
    result.verificationHash !== input.verificationHash ||
    typeof result.sessionId !== "string" ||
    !sessionIdPattern.test(result.sessionId) ||
    !hasExactShape(result.skill, ["ok", "receiptId"]) ||
    result.skill.ok !== true ||
    typeof result.skill.receiptId !== "string" ||
    !opaqueIdPattern.test(result.skill.receiptId) ||
    !Array.isArray(result.findings) ||
    !result.findings.every(validFinding)
  ) {
    throw infrastructureError(
      "FINAL_REVIEW_RESULT_INVALID",
      "A final review axis returned an invalid or mismatched result marker.",
    );
  }
}

function ticketNumbers(state: FinalReviewState): number[] {
  return state.tickets
    .map(({ number }) => number)
    .sort((left, right) => left - right);
}

function ticketsChanged(
  before: FinalReviewState,
  after: FinalReviewState,
): boolean {
  return (
    after.tickets.some(({ state }) => state === "open") ||
    canonicalJson(ticketNumbers(before)) !== canonicalJson(ticketNumbers(after))
  );
}

export async function dispatchFinalReview(
  repositoryPath: string,
  batchId: string,
  runtime: FinalReviewDispatchRuntime,
): Promise<FinalReviewDispatchResult> {
  const state = await runtime.readState(repositoryPath, batchId);
  validateState(state, batchId);
  const openTickets = state.tickets
    .filter(({ state: ticketState }) => ticketState === "open")
    .map(({ number }) => number)
    .sort((left, right) => left - right);
  if (openTickets.length > 0) {
    return {
      batchId,
      openTickets,
      status: "waiting-for-tickets",
    };
  }

  const input: FinalReviewDispatchInput = {
    batchHead: state.batchHead,
    batchId,
    pullRequest: state.pullRequest.number,
    targetBase: state.targetBase,
  };
  await runtime.dispatch(input);
  return { ...input, status: "dispatched" };
}

export async function runFinalReview(
  repositoryPath: string,
  options: FinalReviewOptions,
  runtime: FinalReviewRuntime,
): Promise<FinalReviewResult> {
  validateOptions(options);
  const initialState = await runtime.readState(repositoryPath, options.batchId);
  validateState(initialState, options.batchId);
  assertFixedState(initialState, options);
  const initiallyOpen = initialState.tickets
    .filter(({ state }) => state === "open")
    .map(({ number }) => number)
    .sort((left, right) => left - right);
  if (initiallyOpen.length > 0) {
    return {
      batchId: options.batchId,
      openTickets: initiallyOpen,
      status: "tickets-changed",
    };
  }
  validateSpecification(options.specification, initialState);
  const config = await readProjectConfig(options.configPath);
  const merge = await createMergeWorkspace(
    repositoryPath,
    options.targetBase,
    options.batchHead,
  );
  try {
    const verification = await runCompletionCommands(
      merge.workspacePath,
      config.commands,
      config.execution.ticketTimeoutMinutes,
    );
    const verificationHash = sha256(
      canonicalJson({
        batchHead: options.batchHead,
        commands: verification,
        reviewedHead: merge.reviewedHead,
        specificationHash: options.specification.specHash,
        targetBase: options.targetBase,
      }),
    );
    const axisInput = (axis: FinalReviewAxis): FinalReviewAxisInput => ({
      axis,
      batchHead: options.batchHead,
      batchId: options.batchId,
      reviewedHead: merge.reviewedHead,
      specification: options.specification,
      targetBase: options.targetBase,
      verificationHash,
      workspacePath: merge.workspacePath,
    });
    const [standardsExecution, specExecution] = await Promise.allSettled([
      runtime.reviewAxis(axisInput("Standards")),
      runtime.reviewAxis(axisInput("Spec")),
    ]);
    if (
      standardsExecution.status === "rejected" ||
      specExecution.status === "rejected"
    ) {
      throw infrastructureError(
        "FINAL_REVIEW_EXECUTION_FAILED",
        "A required final review axis did not complete.",
      );
    }
    const standards = standardsExecution.value;
    const spec = specExecution.value;
    validateAxisResult(standards, axisInput("Standards"));
    validateAxisResult(spec, axisInput("Spec"));
    if (
      standards.sessionId === spec.sessionId ||
      standards.skill.receiptId === spec.skill.receiptId
    ) {
      throw infrastructureError(
        "FINAL_REVIEW_EXECUTION_INVALID",
        "Final review axes must use independent sessions and skill executions.",
      );
    }

    const currentState = await runtime.readState(repositoryPath, options.batchId);
    validateState(currentState, options.batchId);
    assertFixedState(currentState, options);
    if (ticketsChanged(initialState, currentState)) {
      return {
        batchId: options.batchId,
        openTickets: currentState.tickets
          .filter(({ state }) => state === "open")
          .map(({ number }) => number)
          .sort((left, right) => left - right),
        status: "tickets-changed",
      };
    }

    const completed: FinalReviewCompletedResult = {
      axes: { Spec: spec, Standards: standards },
      batchHead: options.batchHead,
      batchId: options.batchId,
      pullRequest: options.pullRequest,
      reviewedHead: merge.reviewedHead,
      targetBase: options.targetBase,
      verificationHash,
    };
    const actionableFindings = [standards, spec]
      .flatMap(({ findings }) => findings)
      .filter(({ actionable }) => actionable);
    if (actionableFindings.length > 0) {
      return {
        ...completed,
        actionableFindings,
        status: "findings",
      };
    }

    await runtime.markPullRequestReady({
      batchHead: options.batchHead,
      batchId: options.batchId,
      pullRequest: options.pullRequest,
      reviewedHead: merge.reviewedHead,
      targetBase: options.targetBase,
      verificationHash,
    });
    return { ...completed, status: "passed" };
  } finally {
    await rm(merge.root, { force: true, recursive: true });
  }
}
