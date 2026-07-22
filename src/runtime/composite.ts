import { canonicalJson } from "../canonical-json.js";
import { ConfigurationError } from "../config.js";
import { sha256 } from "../hash.js";
import type { CompositeRuntimeProposal } from "./detect.js";
import {
  executeRuntimeAdapterPhase,
  prepareRuntimeAdapter,
  type RuntimeAdapterExecutionRecord,
  type RuntimeAdapterRuntime,
} from "./execute.js";

export type CompositeRuntimeExecutionOptions =
  | { mode: "bootstrap" }
  | { expectedEnvironmentHash: string; mode: "continuation" };

export interface CompositeComponentExecution {
  adapter: string;
  environmentHash: string;
  executions: RuntimeAdapterExecutionRecord[];
}

interface CompositeExecutionBase {
  components: CompositeComponentExecution[];
  environmentHash: string;
}

export type CompositeRuntimeExecutionResult =
  | (CompositeExecutionBase & { status: "completed" })
  | (CompositeExecutionBase & {
      expectedEnvironmentHash: string;
      status: "environment-drift";
    });

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "/runtime/composite" }]);
}

/** 按人工确认顺序准备所有子 adapter，再跨 adapter 执行 tests 与 verification。 */
export async function executeCompositeRuntime(
  proposal: CompositeRuntimeProposal,
  options: CompositeRuntimeExecutionOptions,
  runtime: RuntimeAdapterRuntime,
): Promise<CompositeRuntimeExecutionResult> {
  if (
    !Array.isArray(proposal?.components) ||
    proposal.components.length < 2 ||
    proposal.runtime?.adapter !== "composite" ||
    proposal.runtime.order.length !== proposal.components.length ||
    proposal.components.some(
      ({ adapterPlan, runtime: componentRuntime }, index) =>
        !adapterPlan ||
        componentRuntime.adapter !== proposal.runtime.order[index],
    ) ||
    typeof runtime?.run !== "function" ||
    (options.mode !== "bootstrap" && options.mode !== "continuation") ||
    (options.mode === "continuation" &&
      !/^[a-f0-9]{64}$/u.test(options.expectedEnvironmentHash))
  ) {
    throw configurationError(
      "COMPOSITE_EXECUTION_INVALID",
      "Composite execution requires an ordered proposal and environment identity.",
    );
  }

  const components: CompositeComponentExecution[] = [];
  for (const component of proposal.components) {
    const prepared = await prepareRuntimeAdapter(
      component,
      options.mode,
      runtime,
    );
    components.push({
      adapter: prepared.adapter,
      environmentHash: prepared.environmentHash,
      executions: prepared.executions,
    });
  }
  const environmentHash = sha256(
    canonicalJson({
      components: components.map(({ adapter, environmentHash }) => ({
        adapter,
        environmentHash,
      })),
      order: proposal.runtime.order,
    }),
  );
  if (
    options.mode === "continuation" &&
    environmentHash !== options.expectedEnvironmentHash
  ) {
    return {
      components,
      environmentHash,
      expectedEnvironmentHash: options.expectedEnvironmentHash,
      status: "environment-drift",
    };
  }

  for (const phase of ["tests", "verification"] as const) {
    for (const [index, component] of proposal.components.entries()) {
      await executeRuntimeAdapterPhase(
        component,
        phase,
        runtime,
        components[index]!.executions,
      );
    }
  }
  return { components, environmentHash, status: "completed" };
}
