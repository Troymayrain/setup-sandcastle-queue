import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import {
  InfrastructureError,
  readProjectConfig,
  validateProjectConfig,
  ConfigurationError,
  type ProjectConfig,
} from "../config.js";
import { sha256 } from "../hash.js";
import { VERSION } from "../version.js";
import {
  renderCandidateAssets,
  TEMPLATE_VERSION,
  type AssetOwnership,
  type CandidateAsset,
} from "./templates.js";

export type InstallationState = "fresh" | "managed" | "unmanaged";

export interface InstallPlanAsset {
  ownership: AssetOwnership;
  path: string;
  sha256: string;
}

export interface AssetPrecondition {
  path: string;
  sha256: string | null;
  type: "absent" | "file";
}

export interface InstallPlan {
  assets: InstallPlanAsset[];
  installationState: InstallationState;
  installerVersion: string;
  patch: string;
  planHash: string;
  preconditions: {
    assets: AssetPrecondition[];
    head: string;
    indexSha256: string;
  };
  schemaVersion: 1;
  templateVersion: string;
}

interface PendingInstallPlan {
  config: ProjectConfig;
  installerVersion: string;
  planHash: string;
  schemaVersion: 1;
  templateVersion: string;
}

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

function runCommand(
  executable: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stderr, stdout });
          return;
        }
        if (typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error.code, stderr, stdout });
      },
    );
  });
}

async function git(
  repository: string,
  args: string[],
  acceptedCodes: number[] = [0],
): Promise<string> {
  let result: CommandResult;
  try {
    result = await runCommand("git", args, repository);
  } catch {
    throw new InfrastructureError([
      { code: "GIT_FAILED", message: "Unable to inspect the target Git repository." },
    ]);
  }

  if (!acceptedCodes.includes(result.code)) {
    throw new InfrastructureError([
      { code: "GIT_FAILED", message: "Unable to inspect the target Git repository." },
    ]);
  }

  return result.stdout;
}

async function pendingPlanPath(repository: string): Promise<string> {
  const root = (await git(repository, ["rev-parse", "--show-toplevel"])).trim();
  const gitPath = (
    await git(root, ["rev-parse", "--git-path", "sandcastle/pending-plan.json"])
  ).trim();
  return isAbsolute(gitPath) ? gitPath : resolve(root, gitPath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function determineInstallationState(
  repository: string,
  assets: CandidateAsset[],
): Promise<InstallationState> {
  if (await pathExists(join(repository, ".sandcastle/installation.json"))) {
    return "managed";
  }

  const collisions = await Promise.all(
    assets
      .filter((asset) => asset.ownership !== "installer-state")
      .map((asset) => pathExists(join(repository, asset.path))),
  );
  return collisions.some(Boolean) ? "unmanaged" : "fresh";
}

async function assetPrecondition(
  repository: string,
  asset: CandidateAsset,
): Promise<AssetPrecondition> {
  const target = join(repository, asset.path);
  if (!(await pathExists(target))) {
    return { path: asset.path, sha256: null, type: "absent" };
  }

  const metadata = await lstat(target);
  if (!metadata.isFile()) {
    throw new InfrastructureError([
      {
        code: "UNSUPPORTED_TARGET_TYPE",
        message: "A candidate installation path is not a regular file.",
      },
    ]);
  }

  return {
    path: asset.path,
    sha256: sha256(await readFile(target)),
    type: "file",
  };
}

async function writeTree(root: string, assets: CandidateAsset[]): Promise<void> {
  await Promise.all(
    assets.map(async (asset) => {
      const target = join(root, asset.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, asset.content, { encoding: "utf8", mode: 0o644 });
    }),
  );
}

async function writeBaseTree(
  root: string,
  repository: string,
  assets: CandidateAsset[],
): Promise<void> {
  await Promise.all(
    assets.map(async (asset) => {
      const source = join(repository, asset.path);
      if (!(await pathExists(source))) {
        return;
      }
      const metadata = await lstat(source);
      if (!metadata.isFile()) {
        return;
      }
      const target = join(root, asset.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readFile(source), { mode: 0o644 });
    }),
  );
}

async function validateCandidateTree(
  candidateRoot: string,
  assets: CandidateAsset[],
): Promise<void> {
  await readProjectConfig(join(candidateRoot, ".sandcastle/config.json"));
  const manifest = JSON.parse(
    await readFile(join(candidateRoot, ".sandcastle/installation.json"), "utf8"),
  ) as {
    installerVersion?: string;
    managedAssets?: Record<string, { sha256?: string }>;
    templateVersion?: string;
  };

  if (
    manifest.installerVersion !== VERSION ||
    manifest.templateVersion !== TEMPLATE_VERSION
  ) {
    throw new InfrastructureError([
      {
        code: "CANDIDATE_VALIDATION_FAILED",
        message: "Generated installation metadata is inconsistent.",
      },
    ]);
  }

  for (const asset of assets.filter(({ ownership }) => ownership === "installer")) {
    if (manifest.managedAssets?.[asset.path]?.sha256 !== sha256(asset.content)) {
      throw new InfrastructureError([
        {
          code: "CANDIDATE_VALIDATION_FAILED",
          message: "Generated managed asset hashes are inconsistent.",
        },
      ]);
    }
  }

  const workflow = await readFile(
    join(candidateRoot, ".github/workflows/sandcastle.yml"),
    "utf8",
  );
  if (!workflow.includes("workflow_dispatch:") || !workflow.includes("permissions: {}")) {
    throw new InfrastructureError([
      {
        code: "CANDIDATE_VALIDATION_FAILED",
        message: "Generated workflow failed offline validation.",
      },
    ]);
  }
}

async function renderPatch(
  repository: string,
  assets: CandidateAsset[],
): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sandcastle-plan-"));
  const baseRoot = join(temporaryRoot, "base");
  const candidateRoot = join(temporaryRoot, "candidate");

  try {
    await Promise.all([
      mkdir(baseRoot, { recursive: true }),
      mkdir(candidateRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeBaseTree(baseRoot, repository, assets),
      writeTree(candidateRoot, assets),
    ]);
    await validateCandidateTree(candidateRoot, assets);
    const result = await runCommand(
      "git",
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--binary",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
        "base",
        "candidate",
      ],
      temporaryRoot,
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new InfrastructureError([
        {
          code: "PATCH_GENERATION_FAILED",
          message: "Unable to generate the candidate installation patch.",
        },
      ]);
    }
    return result.stdout
      .replaceAll("a/base/", "a/")
      .replaceAll("b/candidate/", "b/");
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function createInstallPlan(
  repository: string,
  config: ProjectConfig,
): Promise<InstallPlan> {
  const root = (await git(repository, ["rev-parse", "--show-toplevel"])).trim();
  const [head, index] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["ls-files", "--stage", "-z"]),
  ]);
  const assets = renderCandidateAssets(config);
  const [installationState, preconditions, patch] = await Promise.all([
    determineInstallationState(root, assets),
    Promise.all(assets.map((asset) => assetPrecondition(root, asset))),
    renderPatch(root, assets),
  ]);
  const planWithoutHash = {
    assets: assets.map((asset) => ({
      ownership: asset.ownership,
      path: asset.path,
      sha256: sha256(asset.content),
    })),
    installationState,
    installerVersion: VERSION,
    patch,
    preconditions: {
      assets: preconditions,
      head: head.trim(),
      indexSha256: sha256(index),
    },
    schemaVersion: 1 as const,
    templateVersion: TEMPLATE_VERSION,
  };

  return {
    ...planWithoutHash,
    planHash: sha256(canonicalJson(planWithoutHash)),
  };
}

function pendingConfigurationError(
  code: string,
  message: string,
): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function parsePendingInstallPlan(source: string): PendingInstallPlan {
  let candidate: unknown;
  try {
    candidate = JSON.parse(source);
  } catch {
    throw pendingConfigurationError(
      "PENDING_PLAN_INVALID",
      "Pending installation state is not valid JSON.",
    );
  }

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw pendingConfigurationError(
      "PENDING_PLAN_INVALID",
      "Pending installation state has an unsupported shape.",
    );
  }
  const record = candidate as Record<string, unknown>;
  const expectedKeys = [
    "config",
    "installerVersion",
    "planHash",
    "schemaVersion",
    "templateVersion",
  ];
  if (
    Object.keys(record).sort().join("\u0000") !== expectedKeys.sort().join("\u0000") ||
    record.schemaVersion !== 1 ||
    record.installerVersion !== VERSION ||
    record.templateVersion !== TEMPLATE_VERSION ||
    typeof record.planHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.planHash)
  ) {
    throw pendingConfigurationError(
      "PENDING_PLAN_INVALID",
      "Pending installation state has an unsupported shape.",
    );
  }

  return {
    config: validateProjectConfig(record.config),
    installerVersion: record.installerVersion,
    planHash: record.planHash,
    schemaVersion: 1,
    templateVersion: record.templateVersion,
  };
}

export async function savePendingInstallPlan(
  repository: string,
  config: ProjectConfig,
  plan: InstallPlan,
): Promise<void> {
  const target = await pendingPlanPath(repository);
  const temporary = `${target}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      canonicalJson({
        config,
        installerVersion: VERSION,
        planHash: plan.planHash,
        schemaVersion: 1,
        templateVersion: TEMPLATE_VERSION,
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, target);
  } catch {
    await rm(temporary, { force: true });
    throw new InfrastructureError([
      {
        code: "PENDING_PLAN_WRITE_FAILED",
        message: "Unable to save pending installation state.",
      },
    ]);
  }
}

export async function resumePendingInstallPlan(
  repository: string,
): Promise<InstallPlan> {
  const target = await pendingPlanPath(repository);
  let source: string;
  try {
    source = await readFile(target, "utf8");
  } catch {
    throw pendingConfigurationError(
      "PENDING_PLAN_NOT_FOUND",
      "No pending installation plan is available.",
    );
  }
  const pending = parsePendingInstallPlan(source);
  const plan = await createInstallPlan(repository, pending.config);
  if (plan.planHash !== pending.planHash) {
    throw pendingConfigurationError(
      "PENDING_PLAN_STALE",
      "Repository state no longer matches the pending installation plan.",
    );
  }
  return plan;
}
