import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "../hash.js";
import type { QueueConfig } from "./config.js";
import { CliError } from "./errors.js";
import { renderQueueTemplate, type TemplateAsset } from "./template.js";

const execute = promisify(execFile);

interface Inventory {
  conflicting: string[];
  matching: string[];
  missing: string[];
}

async function inspect(root: string, assets: TemplateAsset[]): Promise<Inventory> {
  const inventory: Inventory = { conflicting: [], matching: [], missing: [] };
  for (const asset of assets) {
    const target = join(root, asset.path);
    try {
      const metadata = await lstat(target);
      if (!metadata.isFile()) {
        inventory.conflicting.push(asset.path);
      } else if (sha256(await readFile(target)) === sha256(asset.content)) {
        inventory.matching.push(asset.path);
      } else {
        inventory.conflicting.push(asset.path);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        inventory.missing.push(asset.path);
      } else if (code === "ENOTDIR") {
        inventory.conflicting.push(asset.path);
      } else {
        throw new CliError(3, "INSTALLATION_INSPECTION_FAILED", "Unable to inspect installation paths.");
      }
    }
  }
  return inventory;
}

async function writeTree(root: string, assets: TemplateAsset[]): Promise<void> {
  for (const asset of assets) {
    const target = join(root, asset.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, asset.content, { encoding: "utf8", flag: "wx", mode: 0o644 });
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

export interface InitPreview {
  assets: TemplateAsset[];
  patch: string;
}

export async function previewInit(root: string, config: QueueConfig): Promise<InitPreview | null> {
  const assets = renderQueueTemplate(config);
  const inventory = await inspect(root, assets);
  if (inventory.missing.length === 0 && inventory.conflicting.length === 0) {
    return null;
  }
  if (inventory.matching.length > 0 || inventory.conflicting.length > 0) {
    throw new CliError(
      4,
      inventory.missing.length > 0 ? "INSTALLATION_PARTIAL" : "INSTALLATION_CONFLICT",
      "Existing paths do not exactly match a complete Queue Template installation.",
      { inventory },
    );
  }
  return { assets, patch: await renderPatch(assets) };
}

export async function applyInit(root: string, preview: InitPreview): Promise<void> {
  const inventory = await inspect(root, preview.assets);
  if (inventory.missing.length !== preview.assets.length) {
    throw new CliError(4, "INSTALLATION_STALE", "Installation paths changed after preview.", {
      inventory,
    });
  }
  try {
    await writeTree(root, preview.assets);
  } catch {
    throw new CliError(3, "INSTALLATION_WRITE_FAILED", "Unable to write Queue Template assets.");
  }
}
