import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import { ConfigurationError, InfrastructureError } from "../config.js";
import { sha256 } from "../hash.js";
import { VERSION } from "../version.js";
import {
  resolveRepositoryGitPath,
  resolveRepositoryRoot,
} from "./plan.js";

const remoteResourcesPreserved = [
  "audit-history",
  "environment",
  "environment-secrets",
  "labels",
] as const;

export interface UninstallConflict {
  currentSha256: string | null;
  guidance: string;
  path: string;
  recordedSha256: string;
}

export interface UninstallPreservedEntry {
  path: string;
  reason:
    | "audit-history"
    | "compliance"
    | "conflict-record"
    | "modified-managed"
    | "project-owned"
    | "required-skill";
}

export interface UninstallRemoval {
  path: string;
  sha256: string;
}

export interface UninstallPlan {
  conflicts: UninstallConflict[];
  installerVersion: string;
  manifestSha256: string;
  operation: "uninstall";
  planHash: string;
  preserved: UninstallPreservedEntry[];
  remoteResourcesPreserved: Array<(typeof remoteResourcesPreserved)[number]>;
  removals: UninstallRemoval[];
  schemaVersion: 1;
}

export interface UninstallPreview {
  conflicts: UninstallConflict[];
  mode: "preview";
  plan: UninstallPlan;
}

export interface UninstallResult {
  conflicts: UninstallConflict[];
  planHash: string;
  preserved: UninstallPreservedEntry[];
  remoteResourcesPreserved: UninstallPlan["remoteResourcesPreserved"];
  removed: string[];
}

interface InstallationManifest {
  managedAssets: Record<string, { sha256: string }>;
  projectAssets: string[];
  schemaVersion: 1;
}

function uninstallError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeRelativePath(path: string): boolean {
  const normalized = relative(".", path);
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    normalized !== ".." &&
    !normalized.startsWith(`..${sep}`)
  );
}

async function readManifest(
  root: string,
): Promise<{ contents: Buffer; manifest: InstallationManifest }> {
  const path = join(root, ".sandcastle", "installation.json");
  let contents: Buffer;
  let candidate: unknown;
  try {
    contents = await readFile(path);
    candidate = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw uninstallError(
      "INSTALLATION_MANIFEST_INVALID",
      "A valid managed installation manifest is required for uninstall.",
    );
  }
  if (
    !isRecord(candidate) ||
    candidate.schemaVersion !== 1 ||
    !isRecord(candidate.managedAssets) ||
    !Array.isArray(candidate.projectAssets) ||
    candidate.projectAssets.some(
      (path) => typeof path !== "string" || !isSafeRelativePath(path),
    )
  ) {
    throw uninstallError(
      "INSTALLATION_MANIFEST_INVALID",
      "A valid managed installation manifest is required for uninstall.",
    );
  }
  for (const [path, metadata] of Object.entries(candidate.managedAssets)) {
    if (
      !isSafeRelativePath(path) ||
      !isRecord(metadata) ||
      typeof metadata.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(metadata.sha256)
    ) {
      throw uninstallError(
        "INSTALLATION_MANIFEST_INVALID",
        "The managed installation manifest contains an invalid asset entry.",
      );
    }
  }
  return {
    contents,
    manifest: candidate as unknown as InstallationManifest,
  };
}

async function fileHash(path: string): Promise<string | null> {
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

function preservationReason(
  path: string,
): UninstallPreservedEntry["reason"] | null {
  if (
    path.startsWith(".agents/skills/code-review/") ||
    path.startsWith(".agents/skills/implement/") ||
    path.startsWith(".agents/skills/tdd/") ||
    path === "skills-lock.json"
  ) {
    return "required-skill";
  }
  if (
    path === ".sandcastle/THIRD_PARTY_NOTICES.md" ||
    path === ".sandcastle/skill-provenance.json"
  ) {
    return "compliance";
  }
  return null;
}

function planWithoutHash(plan: UninstallPlan): Omit<UninstallPlan, "planHash"> {
  const { planHash: _planHash, ...rest } = plan;
  return rest;
}

export async function createUninstallPreview(
  repository: string,
): Promise<UninstallPreview> {
  const root = await resolveRepositoryRoot(repository);
  const { contents: manifestContents, manifest } = await readManifest(root);
  const conflicts: UninstallConflict[] = [];
  const preserved: UninstallPreservedEntry[] = [];
  const removals: UninstallRemoval[] = [];

  for (const projectPath of manifest.projectAssets) {
    preserved.push({ path: projectPath, reason: "project-owned" });
  }
  if (!manifest.projectAssets.includes(".sandcastle/config.json")) {
    preserved.push({
      path: ".sandcastle/config.json",
      reason: "project-owned",
    });
  }
  preserved.push(
    { path: ".sandcastle/audit", reason: "audit-history" },
    { path: ".sandcastle/custom-adapters", reason: "project-owned" },
  );

  for (const [path, recorded] of Object.entries(manifest.managedAssets).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const reason = preservationReason(path);
    if (reason) {
      preserved.push({ path, reason });
      continue;
    }
    const currentSha256 = await fileHash(join(root, path));
    if (currentSha256 === recorded.sha256) {
      removals.push({ path, sha256: recorded.sha256 });
    } else {
      conflicts.push({
        currentSha256,
        guidance:
          "Preserved because the managed file no longer matches its manifest hash; review and remove it manually if appropriate.",
        path,
        recordedSha256: recorded.sha256,
      });
      preserved.push({ path, reason: "modified-managed" });
    }
  }

  const manifestSha256 = sha256(manifestContents);
  if (conflicts.length === 0) {
    removals.push({
      path: ".sandcastle/installation.json",
      sha256: manifestSha256,
    });
  } else {
    preserved.push({
      path: ".sandcastle/installation.json",
      reason: "conflict-record",
    });
  }
  removals.sort((left, right) => left.path.localeCompare(right.path));
  preserved.sort((left, right) =>
    `${left.path}\u0000${left.reason}`.localeCompare(
      `${right.path}\u0000${right.reason}`,
    ),
  );
  const planBase = {
    conflicts,
    installerVersion: VERSION,
    manifestSha256,
    operation: "uninstall" as const,
    preserved,
    remoteResourcesPreserved: [...remoteResourcesPreserved],
    removals,
    schemaVersion: 1 as const,
  };
  const plan: UninstallPlan = {
    ...planBase,
    planHash: sha256(canonicalJson(planBase)),
  };
  return { conflicts, mode: "preview", plan };
}

function assertUninstallPlan(candidate: unknown): asserts candidate is UninstallPlan {
  if (!isRecord(candidate)) {
    throw uninstallError("UNINSTALL_PLAN_INVALID", "Uninstall plan has an invalid shape.");
  }
  const expectedKeys = [
    "conflicts",
    "installerVersion",
    "manifestSha256",
    "operation",
    "planHash",
    "preserved",
    "remoteResourcesPreserved",
    "removals",
    "schemaVersion",
  ];
  if (
    Object.keys(candidate).sort().join("\u0000") !==
      expectedKeys.join("\u0000") ||
    candidate.operation !== "uninstall" ||
    candidate.schemaVersion !== 1 ||
    candidate.installerVersion !== VERSION ||
    typeof candidate.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.manifestSha256) ||
    typeof candidate.planHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.planHash) ||
    !Array.isArray(candidate.conflicts) ||
    !Array.isArray(candidate.preserved) ||
    !Array.isArray(candidate.removals) ||
    canonicalJson(candidate.remoteResourcesPreserved) !==
      canonicalJson(remoteResourcesPreserved)
  ) {
    throw uninstallError("UNINSTALL_PLAN_INVALID", "Uninstall plan has an invalid shape.");
  }
  let previousPath = "";
  for (const removal of candidate.removals) {
    if (
      !isRecord(removal) ||
      Object.keys(removal).sort().join("\u0000") !== "path\u0000sha256" ||
      typeof removal.path !== "string" ||
      !isSafeRelativePath(removal.path) ||
      removal.path <= previousPath ||
      typeof removal.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(removal.sha256)
    ) {
      throw uninstallError(
        "UNINSTALL_PLAN_INVALID",
        "Uninstall plan contains an invalid removal.",
      );
    }
    previousPath = removal.path;
  }
  const typed = candidate as unknown as UninstallPlan;
  if (sha256(canonicalJson(planWithoutHash(typed))) !== candidate.planHash) {
    throw uninstallError(
      "UNINSTALL_PLAN_HASH_MISMATCH",
      "Uninstall plan content does not match its plan hash.",
    );
  }
}

export async function readUninstallPlan(path: string): Promise<UninstallPlan> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw uninstallError(
      "UNINSTALL_PLAN_READ_FAILED",
      "Unable to read a valid uninstall plan.",
    );
  }
  assertUninstallPlan(candidate);
  return candidate;
}

function safeTarget(root: string, path: string): string {
  if (!isSafeRelativePath(path)) {
    throw uninstallError(
      "UNINSTALL_PLAN_INVALID",
      "Uninstall plan contains an unsafe path.",
    );
  }
  const target = join(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw uninstallError(
      "UNINSTALL_PLAN_INVALID",
      "Uninstall plan contains an unsafe path.",
    );
  }
  return target;
}

export async function applyUninstallPlan(
  repository: string,
  plan: UninstallPlan,
  confirmation: string,
): Promise<UninstallResult> {
  assertUninstallPlan(plan);
  if (confirmation !== plan.planHash) {
    throw uninstallError(
      "PLAN_NOT_CONFIRMED",
      "Uninstall requires explicit confirmation of the exact plan hash.",
    );
  }
  const root = await resolveRepositoryRoot(repository);
  const currentPreview = await createUninstallPreview(root);
  if (canonicalJson(currentPreview.plan) !== canonicalJson(plan)) {
    throw uninstallError(
      "PLAN_STALE",
      "Uninstall targets changed after the plan was created.",
    );
  }
  const manifestPath = join(root, ".sandcastle", "installation.json");
  if ((await fileHash(manifestPath)) !== plan.manifestSha256) {
    throw uninstallError(
      "PLAN_STALE",
      "Installation state changed after the uninstall plan was created.",
    );
  }
  for (const removal of plan.removals) {
    if ((await fileHash(safeTarget(root, removal.path))) !== removal.sha256) {
      throw uninstallError(
        "PLAN_STALE",
        "A removal target changed after the uninstall plan was created.",
      );
    }
  }

  const transactionParent = await resolveRepositoryGitPath(
    root,
    "sandcastle/transactions",
  );
  await mkdir(transactionParent, { mode: 0o700, recursive: true });
  const transactionRoot = await mkdtemp(join(transactionParent, "uninstall-"));
  const moved: Array<{ backup: string; target: string }> = [];
  try {
    for (const removal of plan.removals) {
      const target = safeTarget(root, removal.path);
      const backup = join(transactionRoot, "backup", removal.path);
      await mkdir(dirname(backup), { mode: 0o700, recursive: true });
      await rename(target, backup);
      moved.push({ backup, target });
    }
  } catch {
    let rolledBack = true;
    for (const entry of [...moved].reverse()) {
      try {
        await rename(entry.backup, entry.target);
      } catch {
        rolledBack = false;
      }
    }
    throw new InfrastructureError([
      {
        code: rolledBack ? "UNINSTALL_FAILED" : "UNINSTALL_ROLLBACK_FAILED",
        message: rolledBack
          ? "Uninstall failed and every removed file was restored."
          : "Uninstall failed and rollback could not restore every file.",
      },
    ]);
  }
  await rm(transactionRoot, { force: true, recursive: true });
  return {
    conflicts: plan.conflicts,
    planHash: plan.planHash,
    preserved: plan.preserved,
    remoteResourcesPreserved: plan.remoteResourcesPreserved,
    removed: plan.removals.map(({ path }) => path),
  };
}
