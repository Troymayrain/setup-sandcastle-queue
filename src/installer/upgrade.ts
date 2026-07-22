import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  readProjectConfig,
  type ProjectConfig,
} from "../config.js";
import { sha256 } from "../hash.js";
import { VERSION } from "../version.js";
import {
  createInstallPlan,
  resolveRepositoryRoot,
  type InstallPlan,
  type ConfigSchemaMigration,
  type UpgradeConflict,
  type UpgradePlanMetadata,
} from "./plan.js";
import {
  renderCandidateAssets,
  RUNTIME_WRAPPER_CONTENT,
} from "./templates.js";

export interface UpgradePreview {
  conflicts: UpgradeConflict[];
  mode: "preview";
  plan: InstallPlan;
  preservedProjectPaths: string[];
  updates: Array<{
    fromSha256: string | null;
    path: string;
    toSha256: string;
  }>;
}

export type RollbackPreview = UpgradePreview;

interface InstalledManifest {
  installerVersion: string;
  managedAssets: Record<string, { sha256: string }>;
  schemaVersion: 1;
}

function upgradeError(code: string, message: string, path = ""): ConfigurationError {
  return new ConfigurationError([{ code, message, path }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readManifest(root: string): Promise<InstalledManifest> {
  const path = join(root, ".sandcastle", "installation.json");
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw upgradeError(
      "INSTALLATION_MANIFEST_INVALID",
      "A valid managed installation manifest is required for upgrade.",
      ".sandcastle/installation.json",
    );
  }
  if (
    !isRecord(candidate) ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.installerVersion !== "string" ||
    !isRecord(candidate.managedAssets)
  ) {
    throw upgradeError(
      "INSTALLATION_MANIFEST_INVALID",
      "A valid managed installation manifest is required for upgrade.",
      ".sandcastle/installation.json",
    );
  }
  for (const metadata of Object.values(candidate.managedAssets)) {
    if (
      !isRecord(metadata) ||
      typeof metadata.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(metadata.sha256)
    ) {
      throw upgradeError(
        "INSTALLATION_MANIFEST_INVALID",
        "The managed installation manifest contains an invalid asset hash.",
        ".sandcastle/installation.json",
      );
    }
  }
  return candidate as unknown as InstalledManifest;
}

async function currentHash(path: string): Promise<string | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      return null;
    }
    return sha256(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function targetRuntimeWrapper(
  root: string,
  manifest: InstalledManifest,
): Promise<string> {
  const path = join(
    root,
    ".agents",
    "skills",
    "sandcastle-runtime",
    "SKILL.md",
  );
  let current: string;
  try {
    current = await readFile(path, "utf8");
  } catch {
    return RUNTIME_WRAPPER_CONTENT;
  }
  const wrapperPath = ".agents/skills/sandcastle-runtime/SKILL.md";
  if (sha256(current) !== manifest.managedAssets[wrapperPath]?.sha256) {
    return RUNTIME_WRAPPER_CONTENT;
  }
  const marker = "## Adopted legacy Sandcastle extensions";
  const markerIndex = current.indexOf(marker);
  if (markerIndex < 0) {
    return RUNTIME_WRAPPER_CONTENT;
  }
  return `${RUNTIME_WRAPPER_CONTENT.trimEnd()}\n\n${current.slice(markerIndex).trim()}\n`;
}

function assertExactTargetRelease(targetRelease: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(targetRelease)) {
    throw upgradeError(
      "TARGET_RELEASE_INVALID",
      "upgrade requires an exact SemVer target release.",
    );
  }
  if (targetRelease !== VERSION) {
    throw upgradeError(
      "TARGET_RELEASE_UNAVAILABLE",
      "The requested target release is not available in this exact CLI package.",
    );
  }
}

async function inspectTargetAssets(
  root: string,
  config: ProjectConfig,
  manifest: InstalledManifest,
  runtimeWrapper: string,
): Promise<{
  conflicts: UpgradeConflict[];
  preservedProjectPaths: string[];
  updates: UpgradePreview["updates"];
}> {
  const conflicts: UpgradeConflict[] = [];
  const preservedProjectPaths: string[] = [];
  const updates: UpgradePreview["updates"] = [];
  const targetAssets = renderCandidateAssets(config, { runtimeWrapper });
  for (const asset of targetAssets) {
    const actualSha256 = await currentHash(join(root, asset.path));
    const targetSha256 = sha256(asset.content);
    if (asset.ownership === "project") {
      if (actualSha256 !== null) {
        preservedProjectPaths.push(asset.path);
      }
      continue;
    }
    if (asset.ownership === "installer-state") {
      continue;
    }
    const installedSha256 = manifest.managedAssets[asset.path]?.sha256 ?? null;
    if (actualSha256 === targetSha256) {
      continue;
    }
    if (installedSha256 !== null && actualSha256 === installedSha256) {
      updates.push({
        fromSha256: actualSha256,
        path: asset.path,
        toSha256: targetSha256,
      });
    } else {
      conflicts.push({
        currentSha256: actualSha256,
        installedSha256,
        path: asset.path,
        targetSha256,
      });
    }
  }
  return {
    conflicts: conflicts.sort((left, right) => left.path.localeCompare(right.path)),
    preservedProjectPaths: preservedProjectPaths.sort(),
    updates: updates.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function createReleaseTransitionPreview(
  repository: string,
  targetRelease: string,
  targetConfigPath?: string,
  operation: "rollback" | "upgrade" = "upgrade",
): Promise<UpgradePreview> {
  assertExactTargetRelease(targetRelease);
  const root = await resolveRepositoryRoot(repository);
  const installedConfigPath = join(root, ".sandcastle", "config.json");
  const [manifest, config, installedConfig] = await Promise.all([
    readManifest(root),
    readProjectConfig(targetConfigPath ?? installedConfigPath),
    readFile(installedConfigPath),
  ]);
  const runtimeWrapper = await targetRuntimeWrapper(root, manifest);
  const targetConfig = Buffer.from(canonicalJson(config));
  const installedConfigSha256 = sha256(installedConfig);
  const targetConfigSha256 = sha256(targetConfig);
  const configMigration: ConfigSchemaMigration | null =
    targetConfigPath && installedConfigSha256 !== targetConfigSha256
      ? {
          fromSha256: installedConfigSha256,
          toSha256: targetConfigSha256,
        }
      : null;
  const inspection = await inspectTargetAssets(
    root,
    config,
    manifest,
    runtimeWrapper,
  );
  const transition: UpgradePlanMetadata = {
    configMigration,
    conflicts: inspection.conflicts,
    fromInstallerVersion: manifest.installerVersion,
    runtimeWrapper,
    schemaVersion: 1,
    targetRelease,
  };
  const plan = await createInstallPlan(root, config, {
    overwrittenProjectPaths: configMigration
      ? [".sandcastle/config.json"]
      : [],
    preserveExistingProjectAssets: true,
    ...(operation === "upgrade"
      ? { upgrade: transition }
      : { rollback: transition }),
  });
  if (plan.installationState !== "managed") {
    throw upgradeError(
      "MANAGED_INSTALLATION_REQUIRED",
      `${operation} requires an existing managed Sandcastle installation.`,
    );
  }
  return {
    ...inspection,
    mode: "preview",
    plan,
    preservedProjectPaths: configMigration
      ? inspection.preservedProjectPaths.filter(
          (path) => path !== ".sandcastle/config.json",
        )
      : inspection.preservedProjectPaths,
  };
}

export async function createUpgradePreview(
  repository: string,
  targetRelease: string,
  targetConfigPath?: string,
): Promise<UpgradePreview> {
  return createReleaseTransitionPreview(
    repository,
    targetRelease,
    targetConfigPath,
    "upgrade",
  );
}

export async function createRollbackPreview(
  repository: string,
  targetRelease: string,
  targetConfigPath?: string,
): Promise<RollbackPreview> {
  return createReleaseTransitionPreview(
    repository,
    targetRelease,
    targetConfigPath,
    "rollback",
  );
}
