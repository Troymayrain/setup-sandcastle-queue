import {
  readFileSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import type { ProjectConfig } from "../config.js";
import { canonicalJson } from "../canonical-json.js";
import { sha256 } from "../hash.js";
import { VERSION } from "../version.js";

export const TEMPLATE_VERSION = "1.0.0";
export const RUNTIME_SKILLS_UPSTREAM_COMMIT =
  "ed37663cc5fbef691ddfecd080dff42f7e7e350d";
export const RUNTIME_SKILL_HASHES: Record<
  "code-review" | "implement" | "tdd",
  string
> = {
  "code-review":
    "31d149a480eaa68c11e32f5ee77f0fd0b98a906834d531d881d502352edd0b8e",
  implement: "2139cfedf24791adbc839aaab6019cff158af1e28bfead020ec6e0ce01b3e74d",
  tdd: "81eca2a5b53a63f481c0849be7a663a8cd43d5cf53f32b644ec0a2f50cf91aa2",
};

export type AssetOwnership = "installer" | "installer-state" | "project";

export interface CandidateAsset {
  content: string;
  ownership: AssetOwnership;
  path: string;
}

const workflow = `# Managed by setup-sandcastle-queue. Use the installer to update this file.
name: Sandcastle Queue

on:
  workflow_dispatch:

permissions: {}

jobs:
  installation-check:
    name: Verify Sandcastle installation
    runs-on: ubuntu-24.04
    steps:
      - name: Confirm managed workflow
        run: echo "Sandcastle Queue installation is ready for runtime setup"
`;

interface SnapshotFile {
  content: Buffer;
  relativePath: string;
}

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeSkillsRoot = join(packageRoot, "vendor", "runtime-skills");
const runtimeSkillNames = ["code-review", "implement", "tdd"] as const;
const upstreamSkillPaths: Record<(typeof runtimeSkillNames)[number], string> = {
  "code-review": "skills/engineering/code-review/SKILL.md",
  implement: "skills/engineering/implement/SKILL.md",
  tdd: "skills/engineering/tdd/SKILL.md",
};

function collectSnapshotFiles(
  root: string,
  current: string = root,
  files: SnapshotFile[] = [],
): SnapshotFile[] {
  const entries = readdirSync(current, { withFileTypes: true }).sort(
    (left: Dirent, right: Dirent) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      collectSnapshotFiles(root, absolute, files);
    } else if (entry.isFile()) {
      files.push({
        content: readFileSync(absolute),
        relativePath: relative(root, absolute).split("\\").join("/"),
      });
    }
  }
  return files;
}

function renderRuntimeSkillAssets(): CandidateAsset[] {
  const assets: CandidateAsset[] = [];
  for (const skillName of runtimeSkillNames) {
    const snapshotFiles = collectSnapshotFiles(join(runtimeSkillsRoot, skillName));
    for (const file of snapshotFiles) {
      assets.push({
        content: file.content.toString("utf8"),
        ownership: "installer",
        path: `.agents/skills/${skillName}/${file.relativePath}`,
      });
    }
  }
  return assets;
}

export function renderCandidateAssets(config: ProjectConfig): CandidateAsset[] {
  const configContent = canonicalJson(config);
  const runtimeSkillAssets = renderRuntimeSkillAssets();
  const lockContent = canonicalJson({
    skills: Object.fromEntries(
      runtimeSkillNames.map((skillName) => [
        skillName,
        {
          computedHash: RUNTIME_SKILL_HASHES[skillName],
          ref: RUNTIME_SKILLS_UPSTREAM_COMMIT,
          skillPath: upstreamSkillPaths[skillName],
          source: "mattpocock/skills",
          sourceType: "github",
        },
      ]),
    ),
    version: 1,
  });
  const thirdPartyNotices = readFileSync(
    join(packageRoot, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  const projectAgentDoc = readFileSync(
    join(packageRoot, "assets", "project-docs", "sandcastle-queue.md"),
    "utf8",
  );
  const runtimeWrapper = readFileSync(
    join(packageRoot, "vendor", "sandcastle-runtime", "SKILL.md"),
    "utf8",
  );
  const baseAssets: CandidateAsset[] = [
    ...runtimeSkillAssets,
    {
      content: workflow,
      ownership: "installer",
      path: ".github/workflows/sandcastle.yml",
    },
    {
      content: configContent,
      ownership: "project",
      path: ".sandcastle/config.json",
    },
    {
      content: thirdPartyNotices,
      ownership: "installer",
      path: ".sandcastle/THIRD_PARTY_NOTICES.md",
    },
    {
      content: canonicalJson({
        license: "MIT",
        schemaVersion: 1,
        skills: RUNTIME_SKILL_HASHES,
        source: "https://github.com/mattpocock/skills",
        upstreamCommit: RUNTIME_SKILLS_UPSTREAM_COMMIT,
      }),
      ownership: "installer",
      path: ".sandcastle/skill-provenance.json",
    },
    {
      content: runtimeWrapper,
      ownership: "installer",
      path: ".agents/skills/sandcastle-runtime/SKILL.md",
    },
    {
      content: projectAgentDoc,
      ownership: "project",
      path: "docs/agents/sandcastle-queue.md",
    },
    {
      content: lockContent,
      ownership: "installer",
      path: "skills-lock.json",
    },
  ];
  const managedAssets = Object.fromEntries(
    baseAssets
      .filter(({ ownership }) => ownership === "installer")
      .map((asset) => [asset.path, { sha256: sha256(asset.content) }]),
  );
  const projectAssets = baseAssets
    .filter(({ ownership }) => ownership === "project")
    .map(({ path }) => path)
    .sort();
  const manifestContent = canonicalJson({
    installerVersion: VERSION,
    managedAssets,
    projectAssets,
    schemaVersion: 1,
    templateVersion: TEMPLATE_VERSION,
  });

  const candidateAssets: CandidateAsset[] = [
    ...baseAssets,
    {
      content: manifestContent,
      ownership: "installer-state",
      path: ".sandcastle/installation.json",
    },
  ];
  return candidateAssets.sort((left, right) => left.path.localeCompare(right.path));
}
