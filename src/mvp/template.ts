import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../canonical-json.js";
import type { QueueConfig } from "./config.js";

export interface TemplateAsset {
  content: string;
  path: string;
}

const schema = readFileSync(
  fileURLToPath(new URL("../../schema/mvp-config.schema.json", import.meta.url)),
  "utf8",
);
const toolRoot = fileURLToPath(
  new URL("../../assets/queue-template/tool", import.meta.url),
);

function toolAssets(root: string = toolRoot, current: string = root): TemplateAsset[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) return toolAssets(root, absolute);
    if (!entry.isFile()) return [];
    return [
      {
        content: readFileSync(absolute, "utf8"),
        path: `.sandcastle/tool/${relative(root, absolute).split("\\").join("/")}`,
      },
    ];
  });
}

function workflow(config: QueueConfig): string {
  return `name: Sandcastle Queue

on:
  workflow_dispatch:
    inputs:
      operation:
        required: true
        type: choice
        options:
          - start
          - continue
          - resume
          - final-review
          - final-fix
          - final-rereview
      expected_head:
        required: false
        type: string
      predecessor_run_id:
        required: false
        type: string

concurrency:
  group: sandcastle-queue-\${{ github.repository }}
  cancel-in-progress: false

permissions: {}

jobs:
  queue:
    runs-on: ${config.runner.runsOn}
    permissions:
      actions: write
      contents: write
      issues: write
      pull-requests: write
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Install Queue Template tool
        working-directory: .sandcastle/tool
        run: npm ci
      - name: Run one bounded work unit
        working-directory: .sandcastle/tool
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: npm start -- --operation "\${{ inputs.operation }}" --expected-head "\${{ inputs.expected_head }}" --predecessor-run-id "\${{ inputs.predecessor_run_id }}"
`;
}

export function renderQueueTemplate(config: QueueConfig): TemplateAsset[] {
  const assets: TemplateAsset[] = [
    ...toolAssets(),
    {
      path: ".github/workflows/sandcastle-queue.yml",
      content: workflow(config),
    },
    {
      path: ".sandcastle/config.json",
      content: canonicalJson(config),
    },
    {
      path: ".sandcastle/config.schema.json",
      content: schema.endsWith("\n") ? schema : `${schema}\n`,
    },
    {
      path: ".sandcastle/README.md",
      content:
        "# Sandcastle Queue Template\n\nThese files are Project-controlled Assets. The project may review, edit, rename, or remove them.\n",
    },
    {
      path: ".sandcastle/LICENSE",
      content: "MIT License\n\nCopyright (c) Sandcastle Queue Setup contributors\n",
    },
    {
      path: ".sandcastle/prompts/ticket.md",
      content: "# Ticket\n\nImplement the selected Ticket and satisfy its acceptance criteria.\n",
    },
    {
      path: ".sandcastle/prompts/final-review.md",
      content: "# Final review\n\nReturn exactly `pass` or `needs-fix` after reviewing the temporary merge.\n",
    },
    {
      path: ".sandcastle/prompts/final-fix.md",
      content:
        "# Final fix\n\nFix the findings authorized for the reviewed Integration Branch HEAD.\n",
    },
  ];
  return assets.sort((left, right) => left.path.localeCompare(right.path));
}
