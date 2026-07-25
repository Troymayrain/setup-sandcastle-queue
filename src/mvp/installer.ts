import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import { sha256 } from "../hash.js";
import type { QueueConfig } from "./config.js";
import { CliError } from "./errors.js";
import { renderQueueTemplate, type TemplateAsset } from "./template.js";

const execute = promisify(execFile);

interface AssetPrecondition {
  path: string;
  sha256: string | null;
  type: "absent" | "file";
}

interface FrozenPreconditions {
  assets: AssetPrecondition[];
  head: string;
  indexSha256: string;
}

interface Inventory {
  conflicting: string[];
  matching: string[];
  missing: string[];
}

export function assertSafeAssetPath(root: string, assetPath: string): string {
  const target = resolve(root, assetPath);
  const fromRoot = relative(root, target);
  if (
    assetPath.length === 0 ||
    isAbsolute(assetPath) ||
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    const error = new CliError(
      4,
      "INSTALL_PATH_OUTSIDE_REPOSITORY",
      "Queue Template asset paths must remain inside the repository.",
    ) as CliError & { code: string };
    throw error;
  }
  return target;
}

async function parentsAreDirectories(root: string, assetPath: string): Promise<boolean> {
  const target = assertSafeAssetPath(root, assetPath);
  const parent = relative(root, dirname(target));
  if (!parent) return true;
  let cursor = root;
  for (const segment of parent.split(sep)) {
    cursor = join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw new CliError(
          4,
          "INSTALL_PATH_SYMLINK_FORBIDDEN",
          "Queue Template paths cannot traverse a symbolic-link parent.",
        );
      }
      if (!metadata.isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  return true;
}

async function readPrecondition(
  root: string,
  asset: TemplateAsset,
): Promise<AssetPrecondition> {
  if (!(await parentsAreDirectories(root, asset.path))) {
    return { path: asset.path, sha256: null, type: "file" };
  }
  const target = assertSafeAssetPath(root, asset.path);
  try {
    const metadata = await lstat(target);
    if (!metadata.isFile()) {
      return { path: asset.path, sha256: null, type: "file" };
    }
    return {
      path: asset.path,
      sha256: sha256(await readFile(target)),
      type: "file",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: asset.path, sha256: null, type: "absent" };
    }
    throw new CliError(
      3,
      "INSTALLATION_INSPECTION_FAILED",
      "Unable to inspect installation paths.",
    );
  }
}

async function inspect(root: string, assets: TemplateAsset[]): Promise<Inventory> {
  const inventory: Inventory = { conflicting: [], matching: [], missing: [] };
  for (const asset of assets) {
    const precondition = await readPrecondition(root, asset);
    if (precondition.type === "absent") {
      inventory.missing.push(asset.path);
    } else if (precondition.sha256 === sha256(asset.content)) {
      inventory.matching.push(asset.path);
    } else {
      inventory.conflicting.push(asset.path);
    }
  }
  return inventory;
}

async function writeTree(root: string, assets: TemplateAsset[]): Promise<void> {
  for (const asset of assets) {
    const target = join(root, asset.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, asset.content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
  }
}

async function renderPatch(assets: TemplateAsset[]): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "sandcastle-init-"));
  const before = join(temporary, "before");
  const after = join(temporary, "after");
  await Promise.all([mkdir(before), mkdir(after)]);
  try {
    await writeTree(after, assets);
    try {
      await execute(
        "git",
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--",
          "before",
          "after",
        ],
        { cwd: temporary, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      return "";
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      if (failure.code === 1 && typeof failure.stdout === "string") {
        return failure.stdout
          .replaceAll("a/before/", "a/")
          .replaceAll("a/after/", "a/")
          .replaceAll("b/after/", "b/");
      }
      throw new CliError(3, "PREVIEW_FAILED", "Unable to render installation preview.");
    }
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await execute("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10_000,
    });
    return result.stdout;
  } catch {
    throw new CliError(3, "GIT_INSPECTION_FAILED", "Unable to inspect repository state.");
  }
}

async function freeze(root: string, assets: TemplateAsset[]): Promise<FrozenPreconditions> {
  const [head, index] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["ls-files", "--stage", "-z"]),
  ]);
  const preconditions: FrozenPreconditions = {
    assets: [],
    head: head.trim(),
    indexSha256: sha256(index),
  };
  for (const asset of assets) {
    preconditions.assets.push(await readPrecondition(root, asset));
  }
  return preconditions;
}

function samePreconditions(
  left: FrozenPreconditions,
  right: FrozenPreconditions,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface InitPreview {
  assets: TemplateAsset[];
  patch: string;
  preconditions: FrozenPreconditions;
}

export async function previewInit(
  root: string,
  config: QueueConfig,
): Promise<InitPreview | null> {
  const assets = renderQueueTemplate(config);
  const inventory = await inspect(root, assets);
  if (inventory.missing.length === 0 && inventory.conflicting.length === 0) {
    return null;
  }
  if (inventory.matching.length > 0 || inventory.conflicting.length > 0) {
    throw new CliError(
      4,
      inventory.missing.length > 0
        ? "INSTALLATION_PARTIAL"
        : "INSTALLATION_CONFLICT",
      "Existing paths do not exactly match a complete Queue Template installation.",
      { inventory },
    );
  }
  return {
    assets,
    patch: await renderPatch(assets),
    preconditions: await freeze(root, assets),
  };
}

async function ensureParents(
  root: string,
  assetPath: string,
  createdDirectories: string[],
): Promise<string> {
  const target = assertSafeAssetPath(root, assetPath);
  const parent = relative(root, dirname(target));
  let cursor = root;
  for (const segment of parent.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new CliError(
          4,
          "INSTALLATION_STALE",
          "Installation path parents changed after preview.",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(cursor);
      createdDirectories.push(cursor);
    }
  }
  return target;
}

async function transactionRoot(root: string): Promise<string> {
  const source = (await git(root, ["rev-parse", "--git-dir"])).trim();
  const gitDirectory = isAbsolute(source) ? source : resolve(root, source);
  await mkdir(join(gitDirectory, "sandcastle"), { recursive: true, mode: 0o700 });
  return mkdtemp(join(gitDirectory, "sandcastle", "install-"));
}

export async function applyInit(root: string, preview: InitPreview): Promise<void> {
  const current = await freeze(root, preview.assets);
  if (!samePreconditions(preview.preconditions, current)) {
    throw new CliError(
      4,
      "INSTALLATION_STALE",
      "Repository state or installation paths changed after preview.",
      { inventory: await inspect(root, preview.assets) },
    );
  }

  const transaction = await transactionRoot(root);
  const staged = join(transaction, "candidate");
  const installed: string[] = [];
  const createdDirectories: string[] = [];
  try {
    await writeTree(staged, preview.assets);
    for (const asset of preview.assets) {
      const target = await ensureParents(root, asset.path, createdDirectories);
      const source = join(staged, asset.path);
      await link(source, target);
      installed.push(target);
      await unlink(source);
    }
  } catch (error) {
    for (const target of installed.reverse()) {
      await unlink(target).catch(() => undefined);
    }
    for (const directory of createdDirectories.reverse()) {
      await rmdir(directory).catch(() => undefined);
    }
    if (error instanceof CliError) throw error;
    throw new CliError(
      3,
      "INSTALLATION_WRITE_FAILED",
      "Unable to atomically write Queue Template assets; all writes were rolled back.",
    );
  } finally {
    await rm(transaction, { force: true, recursive: true });
  }
}
