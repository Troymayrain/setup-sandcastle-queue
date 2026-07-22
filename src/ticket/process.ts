import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
  readProjectConfig,
  type CommandSpec,
} from "../config.js";
import {
  readSpecSnapshot,
  type TicketSpecSnapshot,
} from "../github/frontier.js";
import { createHostGitEnvironment } from "../git/environment.js";
import { isGitObjectId } from "../git/object-id.js";
import { sha256 } from "../hash.js";
import { readBoundedJsonFile } from "../json.js";
import { resolveRepositoryRoot } from "../git/repository.js";
import {
  checkProtectedPaths,
  createSandboxPlan,
  executeObservedSandboxPlan,
  type SandboxAgentObservation,
  type SandboxMount,
} from "../sandbox/policy.js";

interface TestingSeam {
  confirmed: true;
  description: string;
  schemaVersion: 1;
}

interface SkillToolEvent {
  kind: "skill-tool-result";
  ok: true;
  sequence: number;
  skill: "code-review" | "implement" | "tdd";
  toolCallId: string;
}

interface WorkspaceChangeEvent {
  kind: "workspace-change";
  sequence: number;
}

type RuntimeEvent = SkillToolEvent | WorkspaceChangeEvent;

interface ImplementationResult {
  events: RuntimeEvent[];
  head: string;
  phase: "implementation";
  schemaVersion: 1;
  sessionId: string;
  status: "implemented" | "no-change";
  ticket: number;
}

export interface TicketReviewFinding {
  axis: "Spec" | "Standards";
  code: string;
  message: string;
  path?: string;
}

interface ReviewResult {
  events: RuntimeEvent[];
  findings: TicketReviewFinding[];
  fixedPoint: string;
  head: string;
  phase: "review";
  schemaVersion: 1;
  sessionId: string;
  ticket: number;
  verificationHash: string;
}

interface VerificationRecord {
  argvSha256: string;
  exitCode: number;
  group: "tests" | "verification";
  index: number;
}

interface TicketContract {
  batchId: string;
  beforeHead: string;
  phase: "implementation" | "review";
  requiredSkills: ["implement", "tdd", "code-review"];
  review: null | {
    fixedPoint: string;
    head: string;
    verificationHash: string;
  };
  schemaVersion: 1;
  sessionId: string;
  specification: TicketSpecSnapshot;
  testingSeam: TestingSeam;
  ticket: number;
}

export interface TicketProcessingResult {
  beforeHead: string;
  findings: TicketReviewFinding[];
  head: string;
  sessionId: string;
  status: "reviewed";
  ticket: number;
  toolCalls: {
    codeReview: string;
    implement: string;
    tdd: string;
  };
  verificationHash: string;
}

export interface TicketNoChangeResult {
  beforeHead: string;
  head: string;
  sessionId: string;
  status: "waiting-no-change";
  ticket: number;
  toolCalls: {
    implement: string;
    tdd: string;
  };
}

export type TicketProcessingOutcome =
  | TicketNoChangeResult
  | TicketProcessingResult;

export interface ProcessTicketOptions {
  agentDriver: string[];
  beforeHead: string;
  configPath: string;
  image: string;
  seamPath: string;
  snapshotPath: string;
  ticket: number;
}

interface CommandResult {
  stdout: string;
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function git(repository: string, arguments_: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      arguments_,
      {
        cwd: repository,
        encoding: "utf8",
        env: createHostGitEnvironment(),
        maxBuffer: 32 * 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error) {
          reject(
            infrastructureError(
              "TICKET_REPOSITORY_INSPECTION_FAILED",
              "Unable to inspect Ticket repository state.",
            ),
          );
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

async function currentHead(repository: string): Promise<string> {
  return (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
}

async function repositoryFingerprint(repository: string): Promise<string> {
  const [head, status, diff] = await Promise.all([
    git(repository, ["rev-parse", "HEAD"]),
    git(repository, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    git(repository, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "HEAD",
      "--",
    ]),
  ]);
  return sha256(`${head.stdout}\u0000${status.stdout}\u0000${diff.stdout}`);
}

async function readTestingSeam(path: string): Promise<TestingSeam> {
  const result = await readBoundedJsonFile(path, 1024 * 1024);
  if (!result.ok) {
    throw configurationError(
      "TESTING_SEAM_INVALID",
      "Unable to read a valid pre-confirmed testing seam.",
    );
  }
  const candidate = result.value;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).sort().join("\u0000") !==
      ["confirmed", "description", "schemaVersion"].sort().join("\u0000")
  ) {
    throw configurationError(
      "TESTING_SEAM_INVALID",
      "Testing seam has an unsupported shape.",
    );
  }
  const seam = candidate as Partial<TestingSeam>;
  if (
    seam.schemaVersion !== 1 ||
    seam.confirmed !== true ||
    typeof seam.description !== "string" ||
    seam.description.trim().length < 8 ||
    seam.description.length > 2_000
  ) {
    throw configurationError(
      "TESTING_SEAM_INVALID",
      "Testing seam must be explicitly confirmed and described.",
    );
  }
  return seam as TestingSeam;
}

function validHead(value: unknown): value is string {
  return isGitObjectId(value);
}

function validToolEvent(candidate: unknown): candidate is SkillToolEvent {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const event = candidate as Partial<SkillToolEvent>;
  return (
    event.kind === "skill-tool-result" &&
    event.ok === true &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    (event.skill === "implement" ||
      event.skill === "tdd" ||
      event.skill === "code-review") &&
    typeof event.toolCallId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(event.toolCallId)
  );
}

function validWorkspaceEvent(candidate: unknown): candidate is WorkspaceChangeEvent {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const event = candidate as Partial<WorkspaceChangeEvent>;
  return (
    event.kind === "workspace-change" &&
    typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0
  );
}

function validEvents(candidate: unknown): candidate is RuntimeEvent[] {
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    !candidate.every(
      (event) => validToolEvent(event) || validWorkspaceEvent(event),
    )
  ) {
    return false;
  }
  const sequences = candidate.map(({ sequence }) => sequence);
  return (
    new Set(sequences).size === sequences.length &&
    sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!)
  );
}

async function readRuntimeResult(path: string): Promise<unknown> {
  const result = await readBoundedJsonFile(path, 1024 * 1024);
  if (!result.ok && result.reason === "unavailable") {
    throw configurationError(
      "TICKET_EVIDENCE_MISSING",
      "Agent runtime did not produce machine-readable evidence.",
    );
  }
  if (!result.ok && result.reason === "too-large") {
    throw configurationError(
      "TICKET_EVIDENCE_INVALID",
      "Agent runtime evidence exceeds the supported size.",
    );
  }
  if (!result.ok) {
    throw configurationError(
      "TICKET_EVIDENCE_INVALID",
      "Agent runtime evidence is not valid JSON.",
    );
  }
  return result.value;
}

function implementationEvidence(
  candidate: unknown,
  ticket: number,
  sessionId: string,
  head: string,
  observation: SandboxAgentObservation,
): { implement: string; status: "implemented" | "no-change"; tdd: string } {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw configurationError(
      "TICKET_EVIDENCE_INVALID",
      "Implementation evidence has an unsupported shape.",
    );
  }
  const result = candidate as Partial<ImplementationResult>;
  if (
    result.schemaVersion !== 1 ||
    result.phase !== "implementation" ||
    (result.status !== "implemented" && result.status !== "no-change") ||
    result.ticket !== ticket ||
    result.sessionId !== sessionId ||
    result.head !== head ||
    !validHead(result.head) ||
    !validEvents(result.events)
  ) {
    throw configurationError(
      "TICKET_EVIDENCE_INVALID",
      "Implementation evidence does not match the active Ticket session and HEAD.",
    );
  }
  const implement = result.events.find(
    (event): event is SkillToolEvent =>
      validToolEvent(event) && event.skill === "implement",
  );
  const tdd = result.events.find(
    (event): event is SkillToolEvent => validToolEvent(event) && event.skill === "tdd",
  );
  const firstChange = result.events.find(validWorkspaceEvent);
  const observedImplement = observation.skillReceipts.find(
    ({ skill, toolCallId }) =>
      skill === "implement" && toolCallId === implement?.toolCallId,
  );
  const observedTdd = observation.skillReceipts.find(
    ({ skill, toolCallId }) => skill === "tdd" && toolCallId === tdd?.toolCallId,
  );
  if (
    !implement ||
    !tdd ||
    !observedImplement ||
    !observedTdd ||
    observedImplement.sequence >= observedTdd.sequence ||
    implement.sequence >= tdd.sequence ||
    (result.status === "implemented" &&
      (!firstChange ||
        observation.firstWorkspaceChangeSequence === null ||
        observedTdd.sequence >= observation.firstWorkspaceChangeSequence)) ||
    (result.status === "no-change" &&
      (firstChange !== undefined ||
        observation.firstWorkspaceChangeSequence !== null))
  ) {
    throw configurationError(
      observedImplement && observedTdd
        ? "TICKET_SKILL_PROTOCOL_INVALID"
        : "TICKET_SKILL_RECEIPT_MISSING",
      observedImplement && observedTdd
        ? "Ticket runtime must enter implement and complete tdd before the first host-observed workspace change."
        : "Agent-authored evidence does not match host-observed Skill tool results.",
    );
  }
  return {
    implement: implement.toolCallId,
    status: result.status,
    tdd: tdd.toolCallId,
  };
}

function validFinding(candidate: unknown): candidate is TicketReviewFinding {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return false;
  }
  const finding = candidate as Partial<TicketReviewFinding>;
  return (
    (finding.axis === "Spec" || finding.axis === "Standards") &&
    typeof finding.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/u.test(finding.code) &&
    typeof finding.message === "string" &&
    finding.message.length > 0 &&
    finding.message.length <= 4_000 &&
    (finding.path === undefined ||
      (typeof finding.path === "string" && finding.path.length > 0))
  );
}

function reviewEvidence(
  candidate: unknown,
  expected: {
    fixedPoint: string;
    head: string;
    sessionId: string;
    ticket: number;
    verificationHash: string;
  },
  observation: SandboxAgentObservation,
): { codeReview: string; findings: TicketReviewFinding[] } {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw configurationError(
      "TICKET_REVIEW_INVALID",
      "Ticket review evidence has an unsupported shape.",
    );
  }
  const result = candidate as Partial<ReviewResult>;
  if (
    result.schemaVersion !== 1 ||
    result.phase !== "review" ||
    result.ticket !== expected.ticket ||
    result.sessionId !== expected.sessionId ||
    result.head !== expected.head ||
    result.fixedPoint !== expected.fixedPoint ||
    result.verificationHash !== expected.verificationHash ||
    !validEvents(result.events) ||
    !Array.isArray(result.findings) ||
    !result.findings.every(validFinding)
  ) {
    throw configurationError(
      "TICKET_REVIEW_INVALID",
      "Ticket review evidence does not match the fixed point, HEAD, or host verification.",
    );
  }
  const codeReview = result.events.find(
    (event): event is SkillToolEvent =>
      validToolEvent(event) && event.skill === "code-review",
  );
  if (!codeReview) {
    throw configurationError(
      "TICKET_REVIEW_INVALID",
      "Ticket review lacks a successful code-review tool result.",
    );
  }
  if (
    !observation.skillReceipts.some(
      ({ skill, toolCallId }) =>
        skill === "code-review" && toolCallId === codeReview.toolCallId,
    )
  ) {
    throw configurationError(
      "TICKET_SKILL_RECEIPT_MISSING",
      "Agent-authored review evidence does not match a host-observed code-review tool result.",
    );
  }
  return { codeReview: codeReview.toolCallId, findings: result.findings };
}

async function writeContract(path: string, contract: TicketContract): Promise<void> {
  await chmod(path, 0o600).catch(() => undefined);
  await writeFile(path, canonicalJson(contract), { mode: 0o400 });
  await chmod(path, 0o400);
}

async function runSandboxCommand(
  repository: string,
  configPath: string,
  stage: "agent" | "verification",
  image: string,
  sessionId: string,
  command: string[],
  environment: NodeJS.ProcessEnv,
  mounts: SandboxMount[] = [],
): Promise<{
  exitCode: number;
  observation: SandboxAgentObservation;
}> {
  const plan = await createSandboxPlan(
    repository,
    configPath,
    stage,
    image,
    sessionId,
    command,
    environment,
    mounts,
  );
  const executed = await executeObservedSandboxPlan(
    plan,
    plan.planHash,
    environment,
  );
  return {
    exitCode: executed.result.exitCode,
    observation: executed.observation,
  };
}

async function verifyCommands(
  repository: string,
  configPath: string,
  image: string,
  sessionId: string,
  environment: NodeJS.ProcessEnv,
  commands: { tests: CommandSpec[]; verification: CommandSpec[] },
): Promise<VerificationRecord[]> {
  const records: VerificationRecord[] = [];
  for (const group of ["tests", "verification"] as const) {
    for (const [index, command] of commands[group].entries()) {
      const { exitCode } = await runSandboxCommand(
        repository,
        configPath,
        "verification",
        image,
        sessionId,
        command.argv,
        environment,
      );
      records.push({
        argvSha256: sha256(canonicalJson(command.argv)),
        exitCode,
        group,
        index,
      });
      if (exitCode !== 0) {
        throw configurationError(
          "TICKET_VERIFICATION_FAILED",
          "A host-enforced completion command failed; Ticket review was not started.",
        );
      }
    }
  }
  return records;
}

export async function processTicket(
  repositoryPath: string,
  options: ProcessTicketOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TicketProcessingOutcome> {
  if (!Number.isSafeInteger(options.ticket) || options.ticket <= 0) {
    throw configurationError(
      "TICKET_NUMBER_INVALID",
      "Ticket number must be a positive safe integer.",
    );
  }
  if (!isGitObjectId(options.beforeHead)) {
    throw configurationError(
      "TICKET_BASE_INVALID",
      "Ticket processing requires a complete before-HEAD SHA.",
    );
  }
  if (
    options.agentDriver.length !== 2 ||
    options.agentDriver[0] !== "sandcastle-queue" ||
    options.agentDriver[1] !== "agent-driver"
  ) {
    throw configurationError(
      "TICKET_AGENT_DRIVER_INVALID",
      "Ticket processing requires the pinned Sandcastle agent driver.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  const [snapshot, testingSeam, config, head, initialStatus] = await Promise.all([
    readSpecSnapshot(options.snapshotPath),
    readTestingSeam(options.seamPath),
    readProjectConfig(options.configPath),
    currentHead(root),
    git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
  ]);
  if (snapshot.ticket.number !== options.ticket) {
    throw configurationError(
      "TICKET_SPEC_MISMATCH",
      "Spec snapshot does not belong to the requested Ticket.",
    );
  }
  if (head !== options.beforeHead) {
    throw configurationError(
      "TICKET_BASE_MISMATCH",
      "Current HEAD does not match the fixed Ticket processing point.",
    );
  }
  if (initialStatus.stdout.length > 0) {
    throw configurationError(
      "TICKET_WORKTREE_DIRTY",
      "Ticket processing requires a clean initial worktree.",
    );
  }
  const expectedScope = `ticket:${options.ticket}`;
  if (
    environment.SANDCASTLE_SCOPE !== expectedScope ||
    !environment.SANDCASTLE_BATCH_ID
  ) {
    throw configurationError(
      "TICKET_SESSION_MISMATCH",
      "Broker session scope does not match the requested Ticket.",
    );
  }

  const sessionId = randomUUID();
  const sessionRoot = await mkdtemp(join(tmpdir(), "sandcastle-ticket-session-"));
  const inputDirectory = join(sessionRoot, "input");
  const outputDirectory = join(sessionRoot, "output");
  const contractPath = join(inputDirectory, "contract.json");
  await Promise.all([
    mkdir(inputDirectory, { mode: 0o700 }),
    mkdir(outputDirectory, { mode: 0o700 }),
  ]);
  const mounts: SandboxMount[] = [
    { readOnly: true, source: inputDirectory, target: "/sandcastle/input" },
    { readOnly: false, source: outputDirectory, target: "/sandcastle/output" },
  ];
  const baseContract: TicketContract = {
    batchId: environment.SANDCASTLE_BATCH_ID,
    beforeHead: options.beforeHead,
    phase: "implementation",
    requiredSkills: ["implement", "tdd", "code-review"],
    review: null,
    schemaVersion: 1,
    sessionId,
    specification: snapshot,
    testingSeam,
    ticket: options.ticket,
  };
  try {
    await writeContract(contractPath, baseContract);
    const implementationOutput = "/sandcastle/output/implementation.json";
    const implementationExecution = await runSandboxCommand(
      root,
      options.configPath,
      "agent",
      options.image,
      sessionId,
      [
        ...options.agentDriver,
        "--sandcastle-phase",
        "implementation",
        "--contract",
        "/sandcastle/input/contract.json",
        "--output",
        implementationOutput,
      ],
      environment,
      mounts,
    );
    if (implementationExecution.exitCode !== 0) {
      throw configurationError(
        "TICKET_AGENT_FAILED",
        "Ticket implementation Agent exited unsuccessfully.",
      );
    }
    const implementationHead = await currentHead(root);
    const toolCalls = implementationEvidence(
      await readRuntimeResult(join(outputDirectory, "implementation.json")),
      options.ticket,
      sessionId,
      implementationHead,
      implementationExecution.observation,
    );
    const [changed, postImplementationStatus] = await Promise.all([
      git(root, [
        "diff",
        "--name-only",
        "--no-ext-diff",
        "--no-renames",
        "--no-textconv",
        options.beforeHead,
        "--",
      ]),
      git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    ]);
    const hasTicketDiff =
      changed.stdout.trim().length > 0 ||
      postImplementationStatus.stdout.length > 0;
    if (!hasTicketDiff) {
      if (
        toolCalls.status !== "no-change" ||
        implementationHead !== options.beforeHead
      ) {
        throw configurationError(
          "TICKET_NO_CHANGE_EVIDENCE_INVALID",
          "A zero-diff Ticket requires explicit no-change evidence at the original HEAD.",
        );
      }
      await checkProtectedPaths(root, options.beforeHead);
      return {
        beforeHead: options.beforeHead,
        head: implementationHead,
        sessionId,
        status: "waiting-no-change",
        ticket: options.ticket,
        toolCalls: {
          implement: toolCalls.implement,
          tdd: toolCalls.tdd,
        },
      };
    }
    if (toolCalls.status !== "implemented") {
      throw configurationError(
        "TICKET_NO_CHANGE_EVIDENCE_INVALID",
        "Agent no-change evidence cannot accompany repository changes.",
      );
    }
    await checkProtectedPaths(root, options.beforeHead);

    const beforeVerification = await repositoryFingerprint(root);
    const verificationRecords = await verifyCommands(
      root,
      options.configPath,
      options.image,
      sessionId,
      environment,
      config.commands,
    );
    const afterVerification = await repositoryFingerprint(root);
    if (afterVerification !== beforeVerification) {
      throw configurationError(
        "TICKET_VERIFICATION_MUTATED_WORKTREE",
        "Host verification changed the Ticket worktree.",
      );
    }
    const reviewedHead = await currentHead(root);
    const verificationHash = sha256(
      canonicalJson({ head: reviewedHead, records: verificationRecords }),
    );
    const reviewContract: TicketContract = {
      ...baseContract,
      phase: "review",
      review: {
        fixedPoint: options.beforeHead,
        head: reviewedHead,
        verificationHash,
      },
    };
    await writeContract(contractPath, reviewContract);
    const beforeReview = await repositoryFingerprint(root);
    const reviewExecution = await runSandboxCommand(
      root,
      options.configPath,
      "agent",
      options.image,
      sessionId,
      [
        ...options.agentDriver,
        "--sandcastle-phase",
        "review",
        "--contract",
        "/sandcastle/input/contract.json",
        "--output",
        "/sandcastle/output/review.json",
      ],
      environment,
      mounts,
    );
    if (reviewExecution.exitCode !== 0) {
      throw configurationError(
        "TICKET_REVIEW_FAILED",
        "Ticket review Agent exited unsuccessfully.",
      );
    }
    const afterReview = await repositoryFingerprint(root);
    if (afterReview !== beforeReview) {
      throw configurationError(
        "TICKET_REVIEW_MUTATED_WORKTREE",
        "Ticket-level review must not modify the reviewed worktree.",
      );
    }
    const review = reviewEvidence(
      await readRuntimeResult(join(outputDirectory, "review.json")),
      {
        fixedPoint: options.beforeHead,
        head: reviewedHead,
        sessionId,
        ticket: options.ticket,
        verificationHash,
      },
      reviewExecution.observation,
    );
    await checkProtectedPaths(root, options.beforeHead);
    if (review.findings.length > 0) {
      throw configurationError(
        "TICKET_REVIEW_FINDINGS",
        "Ticket-level review reported actionable findings.",
      );
    }
    return {
      beforeHead: options.beforeHead,
      findings: review.findings,
      head: reviewedHead,
      sessionId,
      status: "reviewed",
      ticket: options.ticket,
      toolCalls: {
        codeReview: review.codeReview,
        implement: toolCalls.implement,
        tdd: toolCalls.tdd,
      },
      verificationHash,
    };
  } finally {
    await rm(sessionRoot, { force: true, recursive: true });
  }
}
