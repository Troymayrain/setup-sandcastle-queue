import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
  validateProjectConfig,
} from "../config.js";
import { sha256 } from "../hash.js";
import { VERSION } from "../version.js";
import {
  readAssetPrecondition,
  resolveRepositoryGitPath,
  resolveRepositoryRoot,
  type AssetPrecondition,
  type InstallPlan,
} from "./plan.js";
import {
  renderCandidateAssets,
  RUNTIME_WRAPPER_CONTENT,
  TEMPLATE_VERSION,
  type CandidateAsset,
} from "./templates.js";

export interface InstallResult {
  changed: boolean;
  filesWritten: string[];
  planHash: string;
}

interface AppliedEntry {
  backup: string;
  backedUp: boolean;
  installed: boolean;
  target: string;
}

function planError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function planWithoutHash(plan: Record<string, unknown>): Record<string, unknown> {
  const { planHash: _planHash, ...rest } = plan;
  return rest;
}

function assertAdoptionMetadata(candidate: unknown): void {
  if (!isRecord(candidate)) {
    throw planError("ADOPTION_PLAN_INVALID", "Adoption metadata has an invalid shape.");
  }
  const expectedKeys = [
    "integrationPullRequestOptOut",
    "runtimeWrapper",
    "schemaVersion",
    "skillExtensions",
  ];
  if (
    Object.keys(candidate).sort().join("\u0000") !==
      expectedKeys.join("\u0000") ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.runtimeWrapper !== "string" ||
    !candidate.runtimeWrapper.startsWith(RUNTIME_WRAPPER_CONTENT.trimEnd()) ||
    !Array.isArray(candidate.integrationPullRequestOptOut) ||
    !Array.isArray(candidate.skillExtensions)
  ) {
    throw planError("ADOPTION_PLAN_INVALID", "Adoption metadata has an invalid shape.");
  }
  const optOut = candidate.integrationPullRequestOptOut;
  if (
    optOut.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0,
    ) ||
    new Set(optOut).size !== optOut.length ||
    optOut.some((value, index) => index > 0 && value <= optOut[index - 1]!)
  ) {
    throw planError("ADOPTION_PLAN_INVALID", "Adoption PR opt-out metadata is invalid.");
  }
  const supportedSkills = ["code-review", "implement", "tdd"];
  const seenSkills = new Set<string>();
  for (const extension of candidate.skillExtensions) {
    if (
      !isRecord(extension) ||
      Object.keys(extension).sort().join("\u0000") !==
        ["content", "originalSha256", "skill"].join("\u0000") ||
      typeof extension.content !== "string" ||
      typeof extension.originalSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(extension.originalSha256) ||
      typeof extension.skill !== "string" ||
      !supportedSkills.includes(extension.skill) ||
      seenSkills.has(extension.skill) ||
      (extension.content.length > 0 &&
        (!/sandcastle/iu.test(extension.content) ||
          !candidate.runtimeWrapper.includes(extension.content)))
    ) {
      throw planError(
        "ADOPTION_PLAN_INVALID",
        "Adoption skill migration metadata is invalid.",
      );
    }
    seenSkills.add(extension.skill);
  }
}

function assertPlanEnvelope(candidate: unknown): asserts candidate is InstallPlan {
  if (!isRecord(candidate)) {
    throw planError("PLAN_INVALID", "Confirmed installation plan has an invalid shape.");
  }
  const expectedKeys = [
    ...(candidate.adoption === undefined ? [] : ["adoption"]),
    "assets",
    "config",
    "installationState",
    "installerVersion",
    "patch",
    "planHash",
    "preconditions",
    "schemaVersion",
    "templateVersion",
  ];
  if (
    Object.keys(candidate).sort().join("\u0000") !==
      expectedKeys.sort().join("\u0000") ||
    candidate.schemaVersion !== 1 ||
    candidate.installerVersion !== VERSION ||
    candidate.templateVersion !== TEMPLATE_VERSION ||
    typeof candidate.patch !== "string" ||
    typeof candidate.planHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.planHash) ||
    !Array.isArray(candidate.assets) ||
    !isRecord(candidate.preconditions) ||
    !Array.isArray(candidate.preconditions.assets) ||
    typeof candidate.preconditions.head !== "string" ||
    typeof candidate.preconditions.indexSha256 !== "string" ||
    !["fresh", "managed", "unmanaged"].includes(
      String(candidate.installationState),
    )
  ) {
    throw planError("PLAN_INVALID", "Confirmed installation plan has an invalid shape.");
  }

  if (candidate.adoption !== undefined) {
    assertAdoptionMetadata(candidate.adoption);
  }

  if (sha256(canonicalJson(planWithoutHash(candidate))) !== candidate.planHash) {
    throw planError(
      "PLAN_HASH_MISMATCH",
      "Confirmed installation plan content does not match its plan hash.",
    );
  }

  const config = validateProjectConfig(candidate.config);
  const adoption = candidate.adoption as
    | { runtimeWrapper: string }
    | undefined;
  const renderedAssets = renderCandidateAssets(config, {
    runtimeWrapper: adoption?.runtimeWrapper,
  }).map((asset) => ({
    ownership: asset.ownership,
    path: asset.path,
    sha256: sha256(asset.content),
  }));
  if (canonicalJson(candidate.assets) !== canonicalJson(renderedAssets)) {
    throw planError(
      "PLAN_CANDIDATE_MISMATCH",
      "Confirmed installation plan does not match the installer candidate tree.",
    );
  }

  const preconditionsAreValid = candidate.preconditions.assets.every(
    (precondition, index) => {
      if (!isRecord(precondition)) {
        return false;
      }
      const asset = renderedAssets[index];
      return (
        asset !== undefined &&
        precondition.path === asset.path &&
        (precondition.type === "absent" || precondition.type === "file") &&
        (precondition.sha256 === null ||
          (typeof precondition.sha256 === "string" &&
            /^[a-f0-9]{64}$/u.test(precondition.sha256)))
      );
    },
  );
  if (
    candidate.preconditions.assets.length !== renderedAssets.length ||
    !preconditionsAreValid
  ) {
    throw planError(
      "PLAN_PRECONDITION_INVALID",
      "Confirmed installation plan contains invalid target preconditions.",
    );
  }
}

export async function readInstallPlan(path: string): Promise<InstallPlan> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new InfrastructureError([
      {
        code: "PLAN_READ_FAILED",
        message: "Unable to read the confirmed installation plan.",
      },
    ]);
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(source);
  } catch {
    throw planError("PLAN_INVALID_JSON", "Confirmed installation plan is not valid JSON.");
  }
  assertPlanEnvelope(candidate);
  return candidate;
}

function preconditionsMatch(
  expected: AssetPrecondition,
  actual: AssetPrecondition,
): boolean {
  return (
    expected.path === actual.path &&
    expected.type === actual.type &&
    expected.sha256 === actual.sha256
  );
}

async function ensureParentDirectories(
  target: string,
  repositoryRoot: string,
  createdDirectories: string[],
): Promise<void> {
  const missing: string[] = [];
  let cursor = dirname(target);
  while (cursor !== repositoryRoot) {
    try {
      await lstat(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      missing.push(cursor);
      cursor = dirname(cursor);
    }
  }

  for (const directory of missing.reverse()) {
    await mkdir(directory, { mode: 0o755 });
    createdDirectories.push(directory);
  }
}

async function rollbackAppliedEntries(
  entries: AppliedEntry[],
  createdDirectories: string[],
): Promise<boolean> {
  let succeeded = true;
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.installed) {
        await rm(entry.target, { force: true });
      }
      if (entry.backedUp) {
        await rename(entry.backup, entry.target);
      }
    } catch {
      succeeded = false;
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        succeeded = false;
      }
    }
  }
  return succeeded;
}

function assertSafeAssetPath(repositoryRoot: string, assetPath: string): void {
  const resolved = join(repositoryRoot, assetPath);
  const relativePath = relative(repositoryRoot, resolved);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw planError("PLAN_INVALID", "Confirmed plan contains an unsafe asset path.");
  }
}

async function applyCandidateAssets(
  repositoryRoot: string,
  assets: CandidateAsset[],
  expectedPreconditions: AssetPrecondition[],
  overwrittenProjectPaths: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const changedAssets: CandidateAsset[] = [];
  for (const [index, asset] of assets.entries()) {
    const current = await readAssetPrecondition(repositoryRoot, asset);
    const expected = expectedPreconditions[index];
    if (expected === undefined || !preconditionsMatch(expected, current)) {
      throw planError(
        "PLAN_STALE",
        "Target assets changed after the installation plan was created.",
      );
    }
    if (
      asset.ownership === "project" &&
      current.type === "file" &&
      !overwrittenProjectPaths.has(asset.path)
    ) {
      continue;
    }
    if (current.sha256 !== sha256(asset.content)) {
      changedAssets.push(asset);
    }
  }
  if (changedAssets.length === 0) {
    return [];
  }

  const transactionParent = await resolveRepositoryGitPath(
    repositoryRoot,
    "sandcastle/transactions",
  );
  await mkdir(transactionParent, { mode: 0o700, recursive: true });
  const transactionRoot = await mkdtemp(join(transactionParent, "apply-"));
  const stagedRoot = join(transactionRoot, "candidate");
  const backupRoot = join(transactionRoot, "backup");
  const entries: AppliedEntry[] = [];
  const createdDirectories: string[] = [];

  try {
    await Promise.all(
      changedAssets.map(async (asset) => {
        const staged = join(stagedRoot, asset.path);
        await mkdir(dirname(staged), { mode: 0o700, recursive: true });
        await writeFile(staged, asset.content, { encoding: "utf8", mode: 0o644 });
      }),
    );

    for (const asset of changedAssets) {
      assertSafeAssetPath(repositoryRoot, asset.path);
      const target = join(repositoryRoot, asset.path);
      const staged = join(stagedRoot, asset.path);
      const backup = join(backupRoot, asset.path);
      await ensureParentDirectories(target, repositoryRoot, createdDirectories);
      const current = await readAssetPrecondition(repositoryRoot, asset);
      const expected = expectedPreconditions.find(({ path }) => path === asset.path);
      if (expected === undefined || !preconditionsMatch(expected, current)) {
        throw planError(
          "PLAN_STALE",
          "Target assets changed after the installation plan was created.",
        );
      }
      const hadOriginal = current.type === "file";
      const entry = { backup, backedUp: false, installed: false, target };
      entries.push(entry);

      if (hadOriginal) {
        await mkdir(dirname(backup), { mode: 0o700, recursive: true });
        await rename(target, backup);
        entry.backedUp = true;
        if (sha256(await readFile(backup)) !== current.sha256) {
          throw new Error("Target changed during installation");
        }
      }

      await link(staged, target);
      entry.installed = true;
      await unlink(staged);
    }

    return changedAssets.map(({ path }) => path);
  } catch (error) {
    const rolledBack = await rollbackAppliedEntries(entries, createdDirectories);
    if (rolledBack && error instanceof ConfigurationError) {
      throw error;
    }
    throw new InfrastructureError([
      {
        code: rolledBack ? "APPLY_FAILED" : "APPLY_ROLLBACK_FAILED",
        message: rolledBack
          ? "Installation failed and all target changes were rolled back."
          : "Installation failed and rollback could not restore every target.",
      },
    ]);
  } finally {
    await rm(transactionRoot, { force: true, recursive: true });
  }
}

export async function applyInstallPlan(
  repository: string,
  plan: InstallPlan,
  confirmation: string,
): Promise<InstallResult> {
  assertPlanEnvelope(plan);
  if (confirmation !== plan.planHash) {
    throw planError(
      "PLAN_NOT_CONFIRMED",
      "Installation requires explicit confirmation of the exact plan hash.",
    );
  }
  if (plan.adoption) {
    throw planError(
      "ADOPTION_PLAN_REQUIRES_ADOPT",
      "An adoption plan must be applied through the adopt lifecycle.",
    );
  }
  if (plan.installationState === "unmanaged") {
    throw planError(
      "UNMANAGED_INSTALLATION",
      "Unmanaged Sandcastle assets require the adopt lifecycle.",
    );
  }

  const root = await resolveRepositoryRoot(repository);
  const assets = renderCandidateAssets(plan.config);
  const actualPreconditions = await Promise.all(
    assets.map((asset) => readAssetPrecondition(root, asset)),
  );
  if (
    !plan.preconditions.assets.every((expected, index) => {
      const actual = actualPreconditions[index];
      return actual !== undefined && preconditionsMatch(expected, actual);
    })
  ) {
    throw planError(
      "PLAN_STALE",
      "Target assets changed after the installation plan was created.",
    );
  }

  const filesWritten = await applyCandidateAssets(
    root,
    assets,
    plan.preconditions.assets,
  );
  return {
    changed: filesWritten.length > 0,
    filesWritten,
    planHash: plan.planHash,
  };
}

export async function applyAdoptPlan(
  repository: string,
  plan: InstallPlan,
  confirmation: string,
): Promise<InstallResult> {
  assertPlanEnvelope(plan);
  if (!plan.adoption || plan.installationState !== "unmanaged") {
    throw planError(
      "ADOPTION_PLAN_INVALID",
      "The confirmed plan is not an unmanaged adoption plan.",
    );
  }
  if (confirmation !== plan.planHash) {
    throw planError(
      "PLAN_NOT_CONFIRMED",
      "Adoption requires explicit confirmation of the exact plan hash.",
    );
  }

  const root = await resolveRepositoryRoot(repository);
  const assets = renderCandidateAssets(plan.config, {
    runtimeWrapper: plan.adoption.runtimeWrapper,
  });
  const actualPreconditions = await Promise.all(
    assets.map((asset) => readAssetPrecondition(root, asset)),
  );
  if (
    !plan.preconditions.assets.every((expected, index) => {
      const actual = actualPreconditions[index];
      return actual !== undefined && preconditionsMatch(expected, actual);
    })
  ) {
    throw planError(
      "PLAN_STALE",
      "Target assets changed after the adoption plan was created.",
    );
  }

  const filesWritten = await applyCandidateAssets(
    root,
    assets,
    plan.preconditions.assets,
    new Set([".sandcastle/config.json"]),
  );
  return {
    changed: filesWritten.length > 0,
    filesWritten,
    planHash: plan.planHash,
  };
}
