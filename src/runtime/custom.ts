import {
  ConfigurationError,
  validateProjectConfig,
  type ProjectConfig,
} from "../config.js";
import type { RuntimeProposal } from "./detect.js";

/** 从已校验的 versioned project config 构造 custom adapter 执行合同。 */
export function createCustomRuntimeProposal(
  config: ProjectConfig,
): RuntimeProposal {
  const validated = validateProjectConfig(config);
  if (validated.runtime.adapter !== "custom" || !validated.runtime.custom) {
    throw new ConfigurationError([
      {
        code: "CUSTOM_ADAPTER_REQUIRED",
        message: "A validated custom adapter configuration is required.",
        path: "/runtime/custom",
      },
    ]);
  }
  return {
    adapterPlan: {
      bootstrap: validated.runtime.custom.bootstrap.map(({ argv }) => ({
        argv: [...argv],
      })),
      environment: { inputs: [] },
      networkHosts: [...(validated.runtime.networkHosts ?? [])],
    },
    commands: {
      tests: validated.commands.tests.map(({ argv }) => ({ argv: [...argv] })),
      verification: validated.commands.verification.map(({ argv }) => ({
        argv: [...argv],
      })),
    },
    runtime: {
      adapter: "custom",
      confirmed: true,
      signals: [".sandcastle/config.json#runtime.custom"],
      version: validated.runtime.version,
    },
  };
}
