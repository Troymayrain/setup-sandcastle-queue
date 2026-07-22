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
import {
  WORKFLOW_OPERATION_CONTRACTS,
  type WorkflowOperation,
} from "../workflow/security.js";
import { CONTROL_PLANE_IMAGE_DIGEST_HEX } from "../release/metadata.js";

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
const controlPlaneImage =
  `ghcr.io/troymayrain/setup-sandcastle-queue-control-plane@sha256:${CONTROL_PLANE_IMAGE_DIGEST_HEX}`;

export type AssetOwnership = "installer" | "installer-state" | "project";

export interface CandidateAsset {
  content: string;
  ownership: AssetOwnership;
  path: string;
}

export interface CandidateRenderOptions {
  runtimeWrapper?: string;
}

function workflowPermissions(operation: WorkflowOperation): string {
  const permissions = WORKFLOW_OPERATION_CONTRACTS[operation].permissions;
  return [
    `      actions: ${permissions.actions}`,
    `      contents: ${permissions.contents}`,
    `      issues: ${permissions.issues}`,
    `      pull-requests: ${permissions.pullRequests}`,
  ].join("\n");
}

const workflow = `# Managed by setup-sandcastle-queue. Use the installer to update this file.
name: Sandcastle Queue

on:
  workflow_dispatch:
    inputs:
      operation:
        description: Sandcastle operation
        required: true
        type: choice
        options:
          - start
          - continue
          - resume
          - review-only
          - final-fix
          - abort
          - remote-doctor
      parent:
        description: Parent PRD issue number
        required: false
        type: string
      base_sha:
        description: Confirmed original default-branch SHA
        required: false
        type: string
      batch_id:
        description: Stable Batch identity for an existing Batch
        required: false
        type: string
      expected_head:
        description: Fixed Batch HEAD for reconciliation
        required: false
        type: string
      predecessor_run_id:
        description: Previous run identity for a continuation
        required: false
        type: string
      pull_request:
        description: Stable Batch pull request number
        required: false
        type: string
      reason:
        description: Human reason for abort or recovery
        required: false
        type: string

run-name: "Sandcastle \${{ inputs.operation }} \${{ inputs.batch_id || inputs.parent }}"

concurrency:
  group: sandcastle-\${{ github.repository }}
  cancel-in-progress: false

permissions: {}

jobs:
  initialize-batch:
    if: \${{ inputs.operation == 'start' }}
    name: Initialize stable Batch
    runs-on: ubuntu-24.04
    container:
      image: ${controlPlaneImage}
    outputs:
      batch-id: \${{ steps.batch-identity.outputs.batch-id }}
    permissions:
      contents: write
      issues: read
    steps:
      - name: Check out the fixed host workspace
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - name: Fix the stable Batch identity
        id: batch-identity
        shell: bash
        env:
          BASE_SHA: \${{ inputs.base_sha }}
          PARENT: \${{ inputs.parent }}
        run: |
          set -euo pipefail
          if [[ ! "$PARENT" =~ ^[1-9][0-9]*$ || ! "$BASE_SHA" =~ ^[a-f0-9]{40,64}$ ]]; then
            exit 2
          fi
          printf 'batch-id=p%s-%s-r%s\\n' "$PARENT" "\${BASE_SHA:0:12}" "$GITHUB_RUN_ID" >> "$GITHUB_OUTPUT"
      - name: Initialize stable Batch
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: >-
          sandcastle-queue initialize-batch
          --parent "\${{ inputs.parent }}"
          --base-sha "\${{ inputs.base_sha }}"
          --run-id "\${{ github.run_id }}"
          --config .sandcastle/config.json

  process:
    needs: initialize-batch
    if: \${{ always() && !cancelled() && contains(fromJSON('["start","continue","resume"]'), inputs.operation) && (inputs.operation != 'start' || needs.initialize-batch.result == 'success') }}
    name: Process or resume a Batch
    runs-on: ubuntu-24.04
    container:
      image: ${controlPlaneImage}
    timeout-minutes: 350
    environment: sandcastle
    permissions:
${workflowPermissions("process")}
    steps:
      - name: Check out the fixed host workspace
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - name: Run the process host orchestrator
        env:
          ANTHROPIC_AUTH_TOKEN: \${{ secrets.ANTHROPIC_AUTH_TOKEN }}
          ANTHROPIC_BASE_URL: \${{ vars.ANTHROPIC_BASE_URL }}
          GITHUB_TOKEN: \${{ github.token }}
          SANDCASTLE_BATCH_ID: \${{ inputs.operation == 'start' && needs.initialize-batch.outputs.batch-id || inputs.batch_id }}
          SANDCASTLE_OPERATION: process
        run: >-
          sandcastle-queue workflow-host
          --operation process
          --batch-id "$SANDCASTLE_BATCH_ID"
          --expected-head "\${{ inputs.expected_head }}"
          --predecessor-run-id "\${{ inputs.predecessor_run_id }}"

  review-only:
    if: \${{ inputs.operation == 'review-only' }}
    name: Run cumulative review only
    runs-on: ubuntu-24.04
    container:
      image: ${controlPlaneImage}
    timeout-minutes: 350
    environment: sandcastle
    permissions:
${workflowPermissions("review-only")}
    steps:
      - name: Check out the fixed host workspace
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - name: Run the review-only host orchestrator
        env:
          ANTHROPIC_AUTH_TOKEN: \${{ secrets.ANTHROPIC_AUTH_TOKEN }}
          ANTHROPIC_BASE_URL: \${{ vars.ANTHROPIC_BASE_URL }}
          GITHUB_TOKEN: \${{ github.token }}
          SANDCASTLE_OPERATION: review-only
        run: >-
          sandcastle-queue workflow-host
          --operation review-only
          --batch-id "\${{ inputs.batch_id }}"
          --expected-head "\${{ inputs.expected_head }}"
          --pull-request "\${{ inputs.pull_request }}"

  final-fix:
    if: \${{ inputs.operation == 'final-fix' }}
    name: Run one bounded final fix
    runs-on: ubuntu-24.04
    container:
      image: ${controlPlaneImage}
    timeout-minutes: 350
    environment: sandcastle
    permissions:
${workflowPermissions("final-fix")}
    steps:
      - name: Check out the fixed host workspace
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - name: Run the final-fix host orchestrator
        env:
          ANTHROPIC_AUTH_TOKEN: \${{ secrets.ANTHROPIC_AUTH_TOKEN }}
          ANTHROPIC_BASE_URL: \${{ vars.ANTHROPIC_BASE_URL }}
          GITHUB_TOKEN: \${{ github.token }}
          SANDCASTLE_OPERATION: final-fix
        run: >-
          sandcastle-queue workflow-host
          --operation final-fix
          --batch-id "\${{ inputs.batch_id }}"
          --expected-head "\${{ inputs.expected_head }}"
          --pull-request "\${{ inputs.pull_request }}"

  abort:
    if: \${{ inputs.operation == 'abort' }}
    name: Abort a Batch recoverably
    runs-on: ubuntu-24.04
    container:
      image: ${controlPlaneImage}
    permissions:
${workflowPermissions("abort")}
    steps:
      - name: Check out the fixed host workspace
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - name: Run the abort host orchestrator
        env:
          GITHUB_TOKEN: \${{ github.token }}
          SANDCASTLE_OPERATION: abort
        run: >-
          sandcastle-queue workflow-host
          --operation abort
          --batch-id "\${{ inputs.batch_id }}"
          --expected-head "\${{ inputs.expected_head }}"
          --pull-request "\${{ inputs.pull_request }}"
          --reason "\${{ inputs.reason }}"

  remote-doctor:
    if: \${{ inputs.operation == 'remote-doctor' }}
    name: Verify real Actions boundaries
    runs-on: ubuntu-24.04
    container:
      image: ${controlPlaneImage}
    timeout-minutes: 15
    environment: sandcastle
    permissions:
${workflowPermissions("remote-doctor")}
    steps:
      - name: Check out the fixed host workspace
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          persist-credentials: false
      - name: Run the remote doctor host orchestrator
        env:
          ANTHROPIC_AUTH_TOKEN: \${{ secrets.ANTHROPIC_AUTH_TOKEN }}
          ANTHROPIC_BASE_URL: \${{ vars.ANTHROPIC_BASE_URL }}
          GITHUB_TOKEN: \${{ github.token }}
          SANDCASTLE_OPERATION: remote-doctor
        run: >-
          sandcastle-queue workflow-host
          --operation remote-doctor
          --config .sandcastle/config.json
`;

interface SnapshotFile {
  content: Buffer;
  relativePath: string;
}

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const runtimeSkillsRoot = join(packageRoot, "vendor", "runtime-skills");
export const RUNTIME_WRAPPER_CONTENT = readFileSync(
  join(packageRoot, "vendor", "sandcastle-runtime", "SKILL.md"),
  "utf8",
);
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

export function renderCandidateAssets(
  config: ProjectConfig,
  options: CandidateRenderOptions = {},
): CandidateAsset[] {
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
  const runtimeWrapper = options.runtimeWrapper ?? RUNTIME_WRAPPER_CONTENT;
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
