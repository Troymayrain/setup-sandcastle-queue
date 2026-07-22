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
import {
  applyAdoptPlan,
  applyInstallPlan,
  applyRollbackPlan,
  applyUpgradePlan,
  readInstallPlan,
} from "./installer/apply.js";
import { proposeRuntime } from "./runtime/detect.js";
import {
  applyGitHubConfiguration,
  previewGitHubConfiguration,
} from "./github/configure.js";
import { doctor } from "./doctor.js";
import {
  createAdoptionPreview,
  inspectLegacyQuiescence,
  parseLegacyPullRequestOptOut,
} from "./installer/adopt.js";
import {
  createRollbackPreview,
  createUpgradePreview,
} from "./installer/upgrade.js";
import {
  applyUninstallPlan,
  createUninstallPreview,
  readUninstallPlan,
} from "./installer/uninstall.js";
import {
  computeTicketFrontier,
  readSpecSnapshot,
  verifySpecSnapshot,
} from "./github/frontier.js";
import {
  applyBatchStart,
  createBatchStartPreview,
  initializeBatch,
  parseEnrollmentSelection,
} from "./batch/start.js";

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
    return;
  }

  if (command === "adopt") {
    const adoptionPlanPath = optionValue("--plan");
    const adoptionConfirmation = optionValue("--confirm");
    if (adoptionPlanPath || adoptionConfirmation) {
      if (!adoptionPlanPath || !adoptionConfirmation) {
        throw new ConfigurationError([
          {
            code: "MISSING_ARGUMENT",
            message: "adopt apply requires --plan <path> and --confirm <planHash>.",
            path: "",
          },
        ]);
      }
      const plan = await readInstallPlan(adoptionPlanPath);
      if (!plan.adoption) {
        throw new ConfigurationError([
          {
            code: "ADOPTION_PLAN_INVALID",
            message: "The confirmed plan is not an adoption plan.",
            path: "",
          },
        ]);
      }
      const quiescence = await inspectLegacyQuiescence(
        process.cwd(),
        plan.adoption.integrationPullRequestOptOut,
      );
      const result = await applyAdoptPlan(
        process.cwd(),
        plan,
        adoptionConfirmation,
      );
      writeJson({
        command: "adopt",
        ok: true,
        result: { ...result, quiescence },
        version: VERSION,
      });
      process.exitCode = 0;
      return;
    }
    const adoptionConfigPath = optionValue("--config");
    if (!adoptionConfigPath) {
      throw new ConfigurationError([
        {
          code: "MISSING_ARGUMENT",
          message: "adopt requires --config <path>.",
          path: "",
        },
      ]);
    }
    const config = await readProjectConfig(adoptionConfigPath);
    const result = await createAdoptionPreview(
      process.cwd(),
      config,
      parseLegacyPullRequestOptOut(optionValue("--confirm-pr-opt-out")),
    );
    writeJson({ command: "adopt", ok: true, result, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "upgrade") {
    const upgradePlanPath = optionValue("--plan");
    const upgradeConfirmation = optionValue("--confirm");
    if (upgradePlanPath || upgradeConfirmation) {
      if (!upgradePlanPath || !upgradeConfirmation) {
        throw new ConfigurationError([
          {
            code: "MISSING_ARGUMENT",
            message: "upgrade apply requires --plan <path> and --confirm <planHash>.",
            path: "",
          },
        ]);
      }
      const plan = await readInstallPlan(upgradePlanPath);
      const result = await applyUpgradePlan(
        process.cwd(),
        plan,
        upgradeConfirmation,
      );
      writeJson({ command: "upgrade", ok: true, result, version: VERSION });
      process.exitCode = 0;
      return;
    }
    const targetRelease = optionValue("--target");
    if (!targetRelease) {
      throw new ConfigurationError([
        {
          code: "MISSING_ARGUMENT",
          message: "upgrade requires --target <exact-release>.",
          path: "",
        },
      ]);
    }
    const result = await createUpgradePreview(
      process.cwd(),
      targetRelease,
      optionValue("--config"),
    );
    writeJson({ command: "upgrade", ok: true, result, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "rollback") {
    const rollbackPlanPath = optionValue("--plan");
    const rollbackConfirmation = optionValue("--confirm");
    if (rollbackPlanPath || rollbackConfirmation) {
      if (!rollbackPlanPath || !rollbackConfirmation) {
        throw new ConfigurationError([
          {
            code: "MISSING_ARGUMENT",
            message: "rollback apply requires --plan <path> and --confirm <planHash>.",
            path: "",
          },
        ]);
      }
      const plan = await readInstallPlan(rollbackPlanPath);
      const result = await applyRollbackPlan(
        process.cwd(),
        plan,
        rollbackConfirmation,
      );
      writeJson({ command: "rollback", ok: true, result, version: VERSION });
      process.exitCode = 0;
      return;
    }
    const targetRelease = optionValue("--target");
    if (!targetRelease) {
      throw new ConfigurationError([
        {
          code: "MISSING_ARGUMENT",
          message: "rollback requires --target <exact-release>.",
          path: "",
        },
      ]);
    }
    const result = await createRollbackPreview(
      process.cwd(),
      targetRelease,
      optionValue("--config"),
    );
    writeJson({ command: "rollback", ok: true, result, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "uninstall") {
    const uninstallPlanPath = optionValue("--plan");
    const uninstallConfirmation = optionValue("--confirm");
    if (uninstallPlanPath || uninstallConfirmation) {
      if (!uninstallPlanPath || !uninstallConfirmation) {
        throw new ConfigurationError([
          {
            code: "MISSING_ARGUMENT",
            message: "uninstall apply requires --plan <path> and --confirm <planHash>.",
            path: "",
          },
        ]);
      }
      const plan = await readUninstallPlan(uninstallPlanPath);
      const result = await applyUninstallPlan(
        process.cwd(),
        plan,
        uninstallConfirmation,
      );
      writeJson({ command: "uninstall", ok: true, result, version: VERSION });
      process.exitCode = 0;
      return;
    }
    const result = await createUninstallPreview(process.cwd());
    writeJson({ command: "uninstall", ok: true, result, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "status") {
    const parent = optionValue("--parent");
    if (!parent || !/^[1-9][0-9]*$/u.test(parent)) {
      throw new ConfigurationError([
        {
          code: "MISSING_ARGUMENT",
          message: "status requires --parent <issue-number>.",
          path: "",
        },
      ]);
    }
    const result = await computeTicketFrontier(
      process.cwd(),
      Number(parent),
      optionValue("--config"),
    );
    writeJson({ command: "status", ok: true, result, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "start") {
    const parent = optionValue("--parent");
    if (!parent || !/^[1-9][0-9]*$/u.test(parent)) {
      throw new ConfigurationError([
        {
          code: "MISSING_ARGUMENT",
          message: "start requires --parent <issue-number>.",
          path: "",
        },
      ]);
    }
    const config = optionValue("--config");
    const selection = parseEnrollmentSelection(optionValue("--enroll"));
    const preview = await createBatchStartPreview(
      process.cwd(),
      Number(parent),
      config,
      selection,
    );
    const confirmation = optionValue("--confirm");
    const result = confirmation
      ? await applyBatchStart(preview, confirmation)
      : preview;
    writeJson({ command: "start", ok: true, result, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "initialize-batch") {
    const parent = optionValue("--parent");
    const baseSha = optionValue("--base-sha");
    const runId = optionValue("--run-id");
    if (!parent || !baseSha || !runId || !/^[1-9][0-9]*$/u.test(parent)) {
      throw new ConfigurationError([
        {
          code: "MISSING_ARGUMENT",
          message:
            "initialize-batch requires --parent, --base-sha, and --run-id.",
          path: "",
        },
      ]);
    }
    const result = await initializeBatch(
      process.cwd(),
      Number(parent),
      baseSha,
      runId,
      optionValue("--config"),
    );
    writeJson({
      command: "initialize-batch",
      ok: true,
      result,
      version: VERSION,
    });
    process.exitCode = 0;
    return;
  }

  if (command === "verify-spec") {
    const snapshotPath = optionValue("--snapshot");
    if (!snapshotPath) {
      throw new ConfigurationError([
        {
          code: "MISSING_ARGUMENT",
          message: "verify-spec requires --snapshot <path>.",
          path: "",
        },
      ]);
    }
    const snapshot = await readSpecSnapshot(snapshotPath);
    const result = await verifySpecSnapshot(process.cwd(), snapshot);
    writeJson({ command: "verify-spec", ok: true, result, version: VERSION });
    process.exitCode = 0;
    return;
  }

  if (command === "doctor") {
    const result = await doctor(
      process.cwd(),
      optionValue("--config"),
    );
    writeJson({ command: "doctor", ok: result.ok, result, version: VERSION });
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  if (command === "configure-github" && option === "--config" && configPath) {
    const config = await readProjectConfig(configPath);
    const preview = await previewGitHubConfiguration(process.cwd(), config);
    const result = arguments_.includes("--confirm-resources")
      ? await applyGitHubConfiguration(
          preview,
          optionValue("--confirm-resources"),
        )
      : preview;
    writeJson({ command: "configure-github", ok: true, result, version: VERSION });
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
