import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { readQueueConfig } from "./config.js";
import { renderQueueTemplate } from "./template.js";

export interface DoctorResult {
  checks: {
    config: { status: "pass" };
    localAssets: { missing: string[]; status: "fail" | "pass" };
    remote: { status: "not-run" };
  };
  mode: "offline";
  ok: boolean;
}

export async function doctorOffline(root: string): Promise<DoctorResult> {
  const config = await readQueueConfig(join(root, ".sandcastle", "config.json"));
  const missing: string[] = [];
  for (const asset of renderQueueTemplate(config)) {
    try {
      const metadata = await lstat(join(root, asset.path));
      if (!metadata.isFile()) missing.push(asset.path);
    } catch {
      missing.push(asset.path);
    }
  }
  const workflow = join(root, ".github", "workflows", "sandcastle-queue.yml");
  if (!missing.includes(".github/workflows/sandcastle-queue.yml")) {
    const source = await readFile(workflow, "utf8");
    if (!source.includes("workflow_dispatch:") || !source.includes("permissions: {}")) {
      missing.push(".github/workflows/sandcastle-queue.yml");
    }
  }
  return {
    checks: {
      config: { status: "pass" },
      localAssets: {
        missing: missing.sort(),
        status: missing.length === 0 ? "pass" : "fail",
      },
      remote: { status: "not-run" },
    },
    mode: "offline",
    ok: missing.length === 0,
  };
}
