import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
  type CommandSpec,
} from "../config.js";
import { sha256 } from "../hash.js";
import type { BuiltInAdapter, RuntimeProposal } from "./detect.js";

export type RuntimeAdapterPhase =
  | "bootstrap"
  | "environment"
  | "tests"
  | "verification";

export interface RuntimeAdapterCommandResult {
  exitCode: number;
  stdout: string;
}

export interface RuntimeAdapterRuntime {
  run: (
    command: CommandSpec,
    phase: RuntimeAdapterPhase,
    index: number,
  ) => Promise<RuntimeAdapterCommandResult>;
}

export type RuntimeAdapterExecutionOptions =
  | { mode: "bootstrap" }
  | { expectedEnvironmentHash: string; mode: "continuation" };

export interface RuntimeAdapterExecutionRecord {
  argvSha256: string;
  exitCode: 0;
  index: number;
  phase: RuntimeAdapterPhase;
}

interface RuntimeAdapterExecutionBase {
  adapter: BuiltInAdapter;
  environmentHash: string;
  executions: RuntimeAdapterExecutionRecord[];
}

export type RuntimeAdapterExecutionResult =
  | (RuntimeAdapterExecutionBase & { status: "completed" })
  | (RuntimeAdapterExecutionBase & {
      expectedEnvironmentHash: string;
      status: "environment-drift";
    });

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "/runtime" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

const phaseFailures: Record<RuntimeAdapterPhase, [string, string]> = {
  bootstrap: [
    "RUNTIME_BOOTSTRAP_FAILED",
    "The runtime adapter bootstrap command failed.",
  ],
  environment: [
    "RUNTIME_ENVIRONMENT_PROBE_FAILED",
    "The runtime adapter environment probe failed.",
  ],
  tests: ["RUNTIME_TEST_FAILED", "A runtime adapter test command failed."],
  verification: [
    "RUNTIME_VERIFICATION_FAILED",
    "A runtime adapter verification command failed.",
  ],
};

async function executeCommand(
  command: CommandSpec,
  phase: RuntimeAdapterPhase,
  index: number,
  runtime: RuntimeAdapterRuntime,
  executions: RuntimeAdapterExecutionRecord[],
): Promise<string> {
  let result: RuntimeAdapterCommandResult;
  try {
    result = await runtime.run(
      { argv: [...command.argv] },
      phase,
      index,
    );
  } catch {
    const [code, message] = phaseFailures[phase];
    throw infrastructureError(code, message);
  }
  if (
    result === null ||
    typeof result !== "object" ||
    !Number.isInteger(result.exitCode) ||
    typeof result.stdout !== "string" ||
    result.exitCode !== 0
  ) {
    const [code, message] = phaseFailures[phase];
    throw infrastructureError(code, message);
  }
  executions.push({
    argvSha256: sha256(canonicalJson(command.argv)),
    exitCode: 0,
    index,
    phase,
  });
  return result.stdout;
}

function normalizedPipEnvironment(source: string): string[] {
  const packages = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const match = line.match(
        /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*)$/u,
      );
      if (!match?.[1] || !match[2]) return null;
      return `${match[1].toLowerCase().replace(/[._]+/gu, "-")}==${match[2]}`;
    });
  if (
    packages.length === 0 ||
    packages.some((entry) => entry === null) ||
    new Set(packages).size !== packages.length
  ) {
    throw infrastructureError(
      "RUNTIME_ENVIRONMENT_EVIDENCE_INVALID",
      "The runtime adapter returned invalid resolved environment evidence.",
    );
  }
  return (packages as string[]).sort((left, right) => left.localeCompare(right));
}

async function captureEnvironment(
  proposal: RuntimeProposal,
  runtime: RuntimeAdapterRuntime,
  executions: RuntimeAdapterExecutionRecord[],
): Promise<string> {
  const plan = proposal.adapterPlan!;
  let resolved: string[] | null = null;
  if (plan.environment.probe) {
    const source = await executeCommand(
      plan.environment.probe,
      "environment",
      0,
      runtime,
      executions,
    );
    resolved = normalizedPipEnvironment(source);
  }
  return sha256(
    canonicalJson({
      adapter: proposal.runtime.adapter,
      inputs: plan.environment.inputs,
      resolved,
      runtimeVersion: proposal.runtime.version,
    }),
  );
}

function assertExecutionInput(
  proposal: RuntimeProposal,
  options: RuntimeAdapterExecutionOptions,
  runtime: RuntimeAdapterRuntime,
): void {
  if (
    !proposal.adapterPlan ||
    typeof runtime?.run !== "function" ||
    (options.mode !== "bootstrap" && options.mode !== "continuation") ||
    (options.mode === "continuation" &&
      !/^[a-f0-9]{64}$/u.test(options.expectedEnvironmentHash))
  ) {
    throw configurationError(
      "RUNTIME_ADAPTER_EXECUTION_INVALID",
      "Runtime adapter execution requires a complete plan and continuation environment identity.",
    );
  }
}

/**
 * 执行 adapter 的可审计阶段；continuation 会在任何测试前核验已记录的 resolved environment。
 */
export async function executeRuntimeAdapter(
  proposal: RuntimeProposal,
  options: RuntimeAdapterExecutionOptions,
  runtime: RuntimeAdapterRuntime,
): Promise<RuntimeAdapterExecutionResult> {
  assertExecutionInput(proposal, options, runtime);
  const plan = proposal.adapterPlan!;
  const executions: RuntimeAdapterExecutionRecord[] = [];

  if (options.mode === "bootstrap") {
    for (const [index, command] of plan.bootstrap.entries()) {
      await executeCommand(command, "bootstrap", index, runtime, executions);
    }
  }

  const environmentHash = await captureEnvironment(
    proposal,
    runtime,
    executions,
  );
  if (
    options.mode === "continuation" &&
    environmentHash !== options.expectedEnvironmentHash
  ) {
    return {
      adapter: proposal.runtime.adapter,
      environmentHash,
      executions,
      expectedEnvironmentHash: options.expectedEnvironmentHash,
      status: "environment-drift",
    };
  }

  for (const phase of ["tests", "verification"] as const) {
    for (const [index, command] of proposal.commands[phase].entries()) {
      await executeCommand(command, phase, index, runtime, executions);
    }
  }
  return {
    adapter: proposal.runtime.adapter,
    environmentHash,
    executions,
    status: "completed",
  };
}
