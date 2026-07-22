import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
  isExactNetworkHost,
  readProjectConfig,
  resolveModelRoles,
  type ProjectConfig,
} from "../config.js";
import { createHostGitEnvironment } from "../git/environment.js";
import { isGitObjectId } from "../git/object-id.js";
import { sha256 } from "../hash.js";
import { resolveRepositoryRoot } from "../git/repository.js";

const builtInRegistryHosts: Record<string, string[]> = {
  "go-module": ["proxy.golang.org", "storage.googleapis.com", "sum.golang.org"],
  "java-maven": ["repo.maven.apache.org"],
  "node-npm": ["registry.npmjs.org"],
  "python-pip": ["files.pythonhosted.org", "pypi.org"],
  "python-uv": ["files.pythonhosted.org", "pypi.org"],
  custom: [],
};
const forbiddenSandboxOptions = new Set([
  "--docker-socket",
  "--env",
  "--env-file",
  "--mount",
  "--network",
  "--privileged",
  "--use-api-socket",
  "--volume",
  "-v",
]);
const protectedSkillPrefixes = [
  ".agents/skills/code-review/",
  ".agents/skills/implement/",
  ".agents/skills/sandcastle-runtime/",
  ".agents/skills/tdd/",
];

export type SandboxStage = "agent" | "bootstrap" | "verification";

export interface SandboxMount {
  readOnly: boolean;
  source: string;
  target: "/sandcastle/input" | "/sandcastle/output";
}

export interface SandboxPlan {
  adapter: ProjectConfig["runtime"]["adapter"];
  command: string[];
  credentialBinding: string;
  image: string;
  mounts: SandboxMount[];
  mode: "preview";
  network: {
    allowedHosts: string[];
    internal: true;
    name: string;
    proxyAlias: "sandcastle-egress";
  };
  planHash: string;
  repository: string;
  schemaVersion: 1;
  session: {
    batchId: string;
    id: string;
    models: string[];
    scope: string;
  };
  stage: SandboxStage;
  user: string;
}

export interface SandboxExecutionResult {
  exitCode: number;
  mode: "executed";
  planHash: string;
  stage: SandboxStage;
}

export interface SandboxSkillReceipt {
  sequence: number;
  skill: "code-review" | "implement" | "tdd";
  toolCallId: string;
}

export interface SandboxAgentObservation {
  firstWorkspaceChangeSequence: number | null;
  skillReceipts: SandboxSkillReceipt[];
}

export interface ObservedSandboxExecution {
  observation: SandboxAgentObservation;
  result: SandboxExecutionResult;
}

export interface ProtectedPathResult {
  changedPaths: string[];
  protectedPaths: string[];
}

interface SandboxSessionEnvironment {
  baseUrl: string;
  batchId: string;
  scope: string;
  token: string;
}

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

export function assertSandboxCliOptions(
  arguments_: string[],
  allowConfirmation: boolean,
): void {
  const allowed = new Set([
    "--argv-json",
    "--config",
    "--image",
    "--session-id",
    "--stage",
    ...(allowConfirmation ? ["--confirm"] : []),
  ]);
  const seen = new Set<string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !option ||
      !option.startsWith("-") ||
      forbiddenSandboxOptions.has(option) ||
      !allowed.has(option) ||
      seen.has(option) ||
      value === undefined
    ) {
      throw configurationError(
        "SANDBOX_OVERRIDE_FORBIDDEN",
        "Sandbox Docker networking, mounts, environment, and privileges are host-controlled.",
      );
    }
    seen.add(option);
  }
}

export function parseSandboxCommand(source: string | undefined): string[] {
  let candidate: unknown;
  try {
    candidate = source === undefined ? null : (JSON.parse(source) as unknown);
  } catch {
    throw configurationError(
      "SANDBOX_COMMAND_INVALID",
      "--argv-json must be a JSON array of direct command arguments.",
    );
  }
  if (
    !Array.isArray(candidate) ||
    candidate.length === 0 ||
    candidate.length > 256 ||
    !candidate.every(
      (argument) =>
        typeof argument === "string" &&
        argument.length > 0 &&
        argument.length <= 32_768 &&
        !/[\u0000\r\n]/u.test(argument),
    )
  ) {
    throw configurationError(
      "SANDBOX_COMMAND_INVALID",
      "--argv-json must be a bounded JSON array of direct command arguments.",
    );
  }
  return candidate;
}

function validImage(image: string): boolean {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u.test(
    image,
  );
}

function sessionEnvironment(
  environment: NodeJS.ProcessEnv,
): SandboxSessionEnvironment {
  const token = environment.SANDCASTLE_SESSION_TOKEN;
  const baseUrl = environment.SANDCASTLE_BROKER_BASE_URL;
  const batchId = environment.SANDCASTLE_BATCH_ID;
  const scope = environment.SANDCASTLE_SCOPE;
  if (!token || !baseUrl || !batchId || !scope) {
    throw configurationError(
      "SANDBOX_SESSION_MISSING",
      "Sandbox launch requires a broker session token, internal Base URL, Batch, and scope.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw configurationError(
      "SANDBOX_BROKER_URL_INVALID",
      "Sandbox broker Base URL is not a valid internal URL.",
    );
  }
  const match = parsed.pathname.match(/^\/batches\/([^/]+)\/scopes\/([^/]+)$/u);
  let pathBatch: string;
  let pathScope: string;
  try {
    pathBatch = decodeURIComponent(match?.[1] ?? "");
    pathScope = decodeURIComponent(match?.[2] ?? "");
  } catch {
    pathBatch = "";
    pathScope = "";
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "sandcastle-broker" ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    pathBatch !== batchId ||
    pathScope !== scope
  ) {
    throw configurationError(
      "SANDBOX_BROKER_URL_INVALID",
      "Sandbox broker Base URL must bind the declared Batch and scope on the internal broker alias.",
    );
  }
  return { baseUrl, batchId, scope, token };
}

function allowedHosts(config: ProjectConfig): string[] {
  const configured = config.runtime.networkHosts ?? [];
  if (configured.some((host) => !isExactNetworkHost(host))) {
    throw configurationError(
      "SANDBOX_HOST_INVALID",
      "Sandbox custom egress entries must be exact public DNS host names.",
    );
  }
  return [
    ...new Set([
      ...(builtInRegistryHosts[config.runtime.adapter] ?? []),
      ...configured,
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

function currentUser(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return `${uid}:${gid}`;
}

function planWithoutHash(plan: SandboxPlan): Omit<SandboxPlan, "planHash"> {
  const { planHash: _planHash, ...withoutHash } = plan;
  return withoutHash;
}

export async function createSandboxPlan(
  repositoryPath: string,
  configPath: string | undefined,
  stage: string | undefined,
  image: string | undefined,
  sessionId: string | undefined,
  command: string[],
  environment: NodeJS.ProcessEnv = process.env,
  mounts: SandboxMount[] = [],
): Promise<SandboxPlan> {
  if (stage !== "bootstrap" && stage !== "agent" && stage !== "verification") {
    throw configurationError(
      "SANDBOX_STAGE_INVALID",
      "Sandbox stage must be 'bootstrap', 'agent', or 'verification'.",
    );
  }
  const sandboxStage: SandboxStage = stage;
  if (!image || !validImage(image)) {
    throw configurationError(
      "SANDBOX_IMAGE_INVALID",
      "Sandbox image must use an exact sha256 digest.",
    );
  }
  if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sessionId)) {
    throw configurationError(
      "SANDBOX_SESSION_ID_INVALID",
      "Sandbox session ID is invalid.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  if (root.includes(",")) {
    throw configurationError(
      "SANDBOX_WORKSPACE_INVALID",
      "Sandbox workspace path cannot be represented safely as a Docker mount.",
    );
  }
  if (
    mounts.length > 2 ||
    new Set(mounts.map(({ target }) => target)).size !== mounts.length ||
    mounts.some(
      ({ readOnly, source, target }) =>
        typeof readOnly !== "boolean" ||
        !isAbsolute(source) ||
        source.includes(",") ||
        (target !== "/sandcastle/input" && target !== "/sandcastle/output") ||
        (target === "/sandcastle/input" && !readOnly) ||
        (target === "/sandcastle/output" && readOnly),
    )
  ) {
    throw configurationError(
      "SANDBOX_MOUNT_INVALID",
      "Sandbox session mounts must use the host-controlled input/output boundaries.",
    );
  }
  const [config, session] = await Promise.all([
    readProjectConfig(configPath ?? join(root, ".sandcastle", "config.json")),
    Promise.resolve(sessionEnvironment(environment)),
  ]);
  const withoutHash = {
    adapter: config.runtime.adapter,
    command,
    credentialBinding: sha256(
      `${session.token}\u0000${session.baseUrl}\u0000${session.batchId}\u0000${session.scope}`,
    ),
    image,
    mounts: mounts.map((mount) => ({ ...mount })),
    mode: "preview" as const,
    network: {
      allowedHosts: allowedHosts(config),
      internal: true as const,
      name: `sandcastle-${sha256(sessionId).slice(0, 16)}`,
      proxyAlias: "sandcastle-egress" as const,
    },
    repository: root,
    schemaVersion: 1 as const,
    session: {
      batchId: session.batchId,
      id: sessionId,
      models: [
        ...new Set(Object.values(resolveModelRoles(config).roles)),
      ].sort((left, right) => left.localeCompare(right)),
      scope: session.scope,
    },
    stage: sandboxStage,
    user: currentUser(),
  };
  return {
    ...withoutHash,
    planHash: sha256(canonicalJson(withoutHash)),
  };
}

function safeDockerEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "DOCKER_CERT_PATH",
      "DOCKER_CONFIG",
      "DOCKER_CONTEXT",
      "DOCKER_HOST",
      "DOCKER_TLS_VERIFY",
      "HOME",
      "PATH",
    ].flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]],
    ),
  );
}

function runCommand(
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      arguments_,
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stderr, stdout });
          return;
        }
        if (typeof error.code === "number") {
          resolve({ code: error.code, stderr, stdout });
          return;
        }
        reject(
          infrastructureError(
            "SANDBOX_DOCKER_UNAVAILABLE",
            "Unable to execute the Docker client for sandbox isolation.",
          ),
        );
      },
    );
  });
}

async function requireDockerSuccess(
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  code: string,
  message: string,
): Promise<void> {
  const result = await runCommand(executable, arguments_, environment);
  if (result.code !== 0) {
    throw infrastructureError(code, message);
  }
}

function commonContainerArguments(): string[] {
  return [
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "512",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=1g",
  ];
}

function agentObservation(source: string): SandboxAgentObservation {
  const pending = new Map<
    string,
    { sequence: number; skill: SandboxSkillReceipt["skill"] }
  >();
  const skillReceipts: SandboxSkillReceipt[] = [];
  let firstWorkspaceChangeSequence: number | null = null;
  let sequence = 0;
  for (const line of source.split(/\r?\n/u)) {
    if (!line) continue;
    let candidate: unknown;
    try {
      candidate = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const message = (candidate as { message?: unknown }).message;
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block === null || typeof block !== "object" || Array.isArray(block)) {
        continue;
      }
      const event = block as Record<string, unknown>;
      sequence += 1;
      if (
        event.type === "tool_use" &&
        typeof event.id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(event.id) &&
        event.name === "Skill" &&
        event.input !== null &&
        typeof event.input === "object" &&
        !Array.isArray(event.input)
      ) {
        const skill = (event.input as { skill?: unknown }).skill;
        if (
          skill === "implement" ||
          skill === "tdd" ||
          skill === "code-review"
        ) {
          pending.set(event.id, { sequence, skill });
        }
      } else if (
        event.type === "tool_use" &&
        event.name !== "Skill" &&
        !new Set(["Glob", "Grep", "Read", "Task", "WebFetch", "WebSearch"])
          .has(String(event.name)) &&
        firstWorkspaceChangeSequence === null
      ) {
        firstWorkspaceChangeSequence = sequence;
      } else if (
        event.type === "tool_result" &&
        typeof event.tool_use_id === "string" &&
        event.is_error !== true
      ) {
        const observed = pending.get(event.tool_use_id);
        if (observed) {
          skillReceipts.push({
            sequence: observed.sequence,
            skill: observed.skill,
            toolCallId: event.tool_use_id,
          });
          pending.delete(event.tool_use_id);
        }
      }
    }
  }
  return {
    firstWorkspaceChangeSequence,
    skillReceipts: skillReceipts.sort(
      (left, right) => left.sequence - right.sequence,
    ),
  };
}

async function executeSandboxPlanInternal(
  plan: SandboxPlan,
  confirmation: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ObservedSandboxExecution> {
  const expectedHash = sha256(canonicalJson(planWithoutHash(plan)));
  if (confirmation !== plan.planHash || expectedHash !== plan.planHash) {
    throw configurationError(
      "SANDBOX_PLAN_NOT_CONFIRMED",
      "Sandbox execution requires confirmation of the exact policy plan.",
    );
  }
  const session = sessionEnvironment(environment);
  const credentialBinding = sha256(
    `${session.token}\u0000${session.baseUrl}\u0000${session.batchId}\u0000${session.scope}`,
  );
  if (
    credentialBinding !== plan.credentialBinding ||
    session.batchId !== plan.session.batchId ||
    session.scope !== plan.session.scope
  ) {
    throw configurationError(
      "SANDBOX_SESSION_CHANGED",
      "Sandbox session credentials changed after policy confirmation.",
    );
  }

  const docker = environment.SANDCASTLE_DOCKER_BIN ?? "docker";
  const hostEnvironment = safeDockerEnvironment(environment);
  const proxyEnvironment = {
    ...hostEnvironment,
    SANDCASTLE_EGRESS_ALLOWLIST: plan.network.allowedHosts.join(","),
  };
  const providerToken = environment.ANTHROPIC_AUTH_TOKEN;
  const providerBaseUrl = environment.ANTHROPIC_BASE_URL;
  if (!providerToken || !providerBaseUrl) {
    throw configurationError(
      "SANDBOX_BROKER_CREDENTIAL_MISSING",
      "Sandbox execution requires host-only provider credentials for its broker sidecar.",
    );
  }
  const brokerEnvironment = {
    ...hostEnvironment,
    ANTHROPIC_AUTH_TOKEN: providerToken,
    ANTHROPIC_BASE_URL: providerBaseUrl,
    SANDCASTLE_BROKER_BATCH_ID: session.batchId,
    SANDCASTLE_BROKER_HOST: "0.0.0.0",
    SANDCASTLE_BROKER_MODELS: JSON.stringify(plan.session.models),
    SANDCASTLE_BROKER_PORT: "8081",
    SANDCASTLE_BROKER_SCOPE: session.scope,
    SANDCASTLE_BROKER_SESSION_TOKEN: session.token,
  };
  const stageEnvironment = {
    ...hostEnvironment,
    ANTHROPIC_AUTH_TOKEN: session.token,
    ANTHROPIC_BASE_URL: session.baseUrl,
    HTTP_PROXY: "http://sandcastle-egress:8080",
    HTTPS_PROXY: "http://sandcastle-egress:8080",
    NO_PROXY: "sandcastle-broker",
    SANDCASTLE_BATCH_ID: session.batchId,
    SANDCASTLE_SCOPE: session.scope,
  };
  const proxyName = `${plan.network.name}-egress`;
  const brokerName = `${plan.network.name}-broker`;
  let networkCreated = false;
  let proxyCreated = false;
  let brokerCreated = false;
  let primaryError: unknown;
  let stageResult: CommandResult | null = null;
  try {
    await requireDockerSuccess(
      docker,
      ["network", "create", "--driver", "bridge", "--internal", plan.network.name],
      hostEnvironment,
      "SANDBOX_NETWORK_CREATE_FAILED",
      "Unable to create the required internal Docker network.",
    );
    networkCreated = true;
    await requireDockerSuccess(
      docker,
      [
        "run",
        "--detach",
        "--name",
        brokerName,
        "--network",
        "bridge",
        ...commonContainerArguments(),
        "--env",
        "ANTHROPIC_AUTH_TOKEN",
        "--env",
        "ANTHROPIC_BASE_URL",
        "--env",
        "SANDCASTLE_BROKER_BATCH_ID",
        "--env",
        "SANDCASTLE_BROKER_HOST",
        "--env",
        "SANDCASTLE_BROKER_MODELS",
        "--env",
        "SANDCASTLE_BROKER_PORT",
        "--env",
        "SANDCASTLE_BROKER_SCOPE",
        "--env",
        "SANDCASTLE_BROKER_SESSION_TOKEN",
        "--user",
        "65532:65532",
        plan.image,
        "credential-broker",
      ],
      brokerEnvironment,
      "SANDBOX_BROKER_START_FAILED",
      "Unable to start the scoped credential broker sidecar.",
    );
    brokerCreated = true;
    await requireDockerSuccess(
      docker,
      [
        "network",
        "connect",
        "--alias",
        "sandcastle-broker",
        plan.network.name,
        brokerName,
      ],
      hostEnvironment,
      "SANDBOX_BROKER_ATTACH_FAILED",
      "Unable to attach the credential broker to the internal network.",
    );
    await requireDockerSuccess(
      docker,
      [
        "run",
        "--detach",
        "--name",
        proxyName,
        "--network",
        "bridge",
        ...commonContainerArguments(),
        "--env",
        "SANDCASTLE_EGRESS_ALLOWLIST",
        "--user",
        "65532:65532",
        plan.image,
        "egress-proxy",
      ],
      proxyEnvironment,
      "SANDBOX_PROXY_START_FAILED",
      "Unable to start the restricted egress proxy.",
    );
    proxyCreated = true;
    await requireDockerSuccess(
      docker,
      [
        "network",
        "connect",
        "--alias",
        plan.network.proxyAlias,
        plan.network.name,
        proxyName,
      ],
      hostEnvironment,
      "SANDBOX_PROXY_ATTACH_FAILED",
      "Unable to attach the egress proxy to the internal network.",
    );
    stageResult = await runCommand(
      docker,
      [
        "run",
        "--rm",
        "--init",
        "--network",
        plan.network.name,
        ...commonContainerArguments(),
        "--env",
        "ANTHROPIC_AUTH_TOKEN",
        "--env",
        "ANTHROPIC_BASE_URL",
        "--env",
        "HTTP_PROXY",
        "--env",
        "HTTPS_PROXY",
        "--env",
        "NO_PROXY",
        "--env",
        "SANDCASTLE_BATCH_ID",
        "--env",
        "SANDCASTLE_SCOPE",
        "--env",
        "HOME=/tmp/sandcastle-home",
        ...plan.mounts.flatMap(({ readOnly, source, target }) => [
          "--mount",
          `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`,
        ]),
        "--mount",
        `type=bind,src=${plan.repository},dst=/workspace`,
        "--mount",
        `type=bind,src=${join(plan.repository, ".git")},dst=/workspace/.git,readonly`,
        "--user",
        plan.user,
        "--workdir",
        "/workspace",
        "--entrypoint",
        plan.command[0] as string,
        plan.image,
        ...plan.command.slice(1),
      ],
      stageEnvironment,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    let cleanupFailed = false;
    if (proxyCreated) {
      const result = await runCommand(
        docker,
        ["rm", "--force", proxyName],
        hostEnvironment,
      );
      cleanupFailed ||= result.code !== 0;
    }
    if (brokerCreated) {
      const result = await runCommand(
        docker,
        ["rm", "--force", brokerName],
        hostEnvironment,
      );
      cleanupFailed ||= result.code !== 0;
    }
    if (networkCreated) {
      const result = await runCommand(
        docker,
        ["network", "rm", plan.network.name],
        hostEnvironment,
      );
      cleanupFailed ||= result.code !== 0;
    }
    if (!primaryError && cleanupFailed) {
      primaryError = infrastructureError(
        "SANDBOX_CLEANUP_FAILED",
        "Sandbox isolation resources could not be removed cleanly.",
      );
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  if (!stageResult) {
    throw infrastructureError(
      "SANDBOX_EXECUTION_FAILED",
      "Sandbox stage did not produce an exit status.",
    );
  }
  return {
    observation: agentObservation(stageResult.stdout),
    result: {
      exitCode: stageResult.code,
      mode: "executed",
      planHash: plan.planHash,
      stage: plan.stage,
    },
  };
}

export async function executeObservedSandboxPlan(
  plan: SandboxPlan,
  confirmation: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ObservedSandboxExecution> {
  return executeSandboxPlanInternal(plan, confirmation, environment);
}

export async function executeSandboxPlan(
  plan: SandboxPlan,
  confirmation: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SandboxExecutionResult> {
  return (await executeSandboxPlanInternal(plan, confirmation, environment)).result;
}

function git(
  repository: string,
  arguments_: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      arguments_,
      {
        cwd: repository,
        encoding: "utf8",
        env: createHostGitEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error) {
          reject(
            infrastructureError(
              "PROTECTED_PATH_INSPECTION_FAILED",
              "Unable to inspect repository changes before publication.",
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function nulPaths(source: string): string[] {
  return source.split("\u0000").filter(Boolean);
}

export function isProtectedControlPlanePath(path: string): boolean {
  return (
    path === ".gitattributes" ||
    path.endsWith("/.gitattributes") ||
    path === ".github/workflows/sandcastle.yml" ||
    path === "skills-lock.json" ||
    path.startsWith(".github/actions/sandcastle/") ||
    path.startsWith(".sandcastle/") ||
    protectedSkillPrefixes.some((prefix) => path.startsWith(prefix))
  );
}

export async function checkProtectedPaths(
  repositoryPath: string,
  beforeHead: string,
): Promise<ProtectedPathResult> {
  if (!isGitObjectId(beforeHead)) {
    throw configurationError(
      "PROTECTED_BASE_INVALID",
      "Protected-path inspection requires a complete fixed commit SHA.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  await git(root, ["cat-file", "-e", `${beforeHead}^{commit}`]);
  const [tracked, untracked] = await Promise.all([
    git(root, [
      "diff",
      "--name-only",
      "--no-ext-diff",
      "--no-renames",
      "--no-textconv",
      "-z",
      beforeHead,
      "--",
    ]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
  ]);
  const changedPaths = [
    ...new Set([...nulPaths(tracked), ...nulPaths(untracked)]),
  ].sort((left, right) => left.localeCompare(right));
  const protectedPaths = changedPaths.filter(isProtectedControlPlanePath);
  if (protectedPaths.length > 0) {
    throw new ConfigurationError(
      protectedPaths.map((path) => ({
        code: "PROTECTED_PATH_MODIFIED",
        message: "Agent changes to protected Sandcastle control-plane paths cannot be published.",
        path,
      })),
    );
  }
  return { changedPaths, protectedPaths };
}
