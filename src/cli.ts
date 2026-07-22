#!/usr/bin/env node

import { VERSION } from "./version.js";
import {
  ConfigurationError,
  InfrastructureError,
  readProjectConfig,
  resolveModelRoles,
} from "./config.js";
import {
  createInstallPlan,
  resumePendingInstallPlan,
  savePendingInstallPlan,
} from "./installer/plan.js";
import { applyInstallPlan, readInstallPlan } from "./installer/apply.js";
import { proposeRuntime } from "./runtime/detect.js";

const arguments_ = process.argv.slice(2);
const [command, option, configPath] = arguments_;

function optionValue(name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function writeJson(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  if (command === "version") {
    writeJson({ command: "version", ok: true, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "validate-config" && option === "--config" && configPath) {
    const config = await readProjectConfig(configPath);
    writeJson({
      command: "validate-config",
      ok: true,
      result: { configPath, schemaVersion: config.schemaVersion },
      version: VERSION,
    });
    process.exitCode = 0;
    return;
  }

  if (command === "validate-config") {
    writeJson({
      category: "configuration",
      code: "CLI_USAGE_ERROR",
      command,
      diagnostics: [
        {
          code: "MISSING_ARGUMENT",
          message: "validate-config requires --config <path>.",
        },
      ],
      ok: false,
      version: VERSION,
    });
    process.exitCode = 2;
    return;
  }

  if (command === "plan") {
    let plan;
    if (arguments_.includes("--resume-pending")) {
      plan = await resumePendingInstallPlan(process.cwd());
    } else {
      const planConfigPath = optionValue("--config");
      if (!planConfigPath) {
        throw new ConfigurationError([
          {
            code: "MISSING_ARGUMENT",
            message: "plan requires --config <path> or --resume-pending.",
            path: "",
          },
        ]);
      }
      const config = await readProjectConfig(planConfigPath);
      plan = await createInstallPlan(process.cwd(), config);
      if (arguments_.includes("--save-pending")) {
        await savePendingInstallPlan(process.cwd(), config, plan);
      }
    }
    writeJson({ command: "plan", ok: true, result: plan, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "install") {
    const planPath = optionValue("--plan");
    const confirmation = optionValue("--confirm");
    if (!planPath || !confirmation) {
      throw new ConfigurationError([
        {
          code: "MISSING_ARGUMENT",
          message: "install requires --plan <path> and --confirm <planHash>.",
          path: "",
        },
      ]);
    }
    const plan = await readInstallPlan(planPath);
    const result = await applyInstallPlan(process.cwd(), plan, confirmation);
    writeJson({ command: "install", ok: true, result, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "propose") {
    const result = await proposeRuntime(
      process.cwd(),
      optionValue("--confirm-runtime"),
    );
    writeJson({ command: "propose", ok: true, result, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "resolve-models" && option === "--config" && configPath) {
    const config = await readProjectConfig(configPath);
    const result = resolveModelRoles(config);
    writeJson({ command: "resolve-models", ok: true, result, version: VERSION });
    process.exitCode = 0;
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigurationError) {
    writeJson({
      category: "configuration",
      code: "CONFIG_INVALID",
      command: command ?? null,
      diagnostics: error.diagnostics,
      ok: false,
      version: VERSION,
    });
    process.exitCode = 2;
  } else if (error instanceof InfrastructureError) {
    writeJson({
      category: "infrastructure",
      code: "INFRASTRUCTURE_ERROR",
      command: command ?? null,
      diagnostics: error.diagnostics,
      ok: false,
      version: VERSION,
    });
    process.exitCode = 3;
  } else {
    throw error;
  }
}
