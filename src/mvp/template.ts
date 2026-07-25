import { readFileSync } from "node:fs";
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
    {
      path: ".sandcastle/tool/package.json",
      content: canonicalJson({
        name: "sandcastle-queue-template-tool",
        version: "1.0.0",
        private: true,
        type: "module",
        engines: { node: ">=22 <23" },
        scripts: {
          start: "node dist/index.js",
          build: "tsc -p tsconfig.json",
          typecheck: "tsc -p tsconfig.json --noEmit",
          test: "node --test test/*.test.mjs",
        },
        dependencies: { "@ai-hero/sandcastle": "0.12.0" },
        devDependencies: { "@types/node": "22.20.1", typescript: "5.9.3" },
      }),
    },
    {
      path: ".sandcastle/tool/package-lock.json",
      content: canonicalJson({
        name: "sandcastle-queue-template-tool",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "sandcastle-queue-template-tool",
            version: "1.0.0",
            dependencies: { "@ai-hero/sandcastle": "0.12.0" },
            devDependencies: { "@types/node": "22.20.1", typescript: "5.9.3" },
          },
        },
      }),
    },
    {
      path: ".sandcastle/tool/tsconfig.json",
      content: canonicalJson({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          strict: true,
        },
        include: ["src/**/*.ts"],
      }),
    },
    {
      path: ".sandcastle/tool/Dockerfile",
      content: "FROM node:22-bookworm-slim\nWORKDIR /queue\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n",
    },
    {
      path: ".sandcastle/tool/src/index.ts",
      content:
        'process.stdout.write(`${JSON.stringify({ status: "not-implemented", operation: process.argv[2] ?? null })}\\n`);\n',
    },
    {
      path: ".sandcastle/tool/test/template.test.mjs",
      content:
        'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("template tool loads", () => assert.equal(true, true));\n',
    },
  ];
  return assets.sort((left, right) => left.path.localeCompare(right.path));
}
