import type { ProjectConfig } from "../config.js";
import { canonicalJson } from "../canonical-json.js";
import { sha256 } from "../hash.js";
import { VERSION } from "../version.js";

export const TEMPLATE_VERSION = "1.0.0";

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

export function renderCandidateAssets(config: ProjectConfig): CandidateAsset[] {
  const configContent = canonicalJson(config);
  const managedAssets = {
    ".github/workflows/sandcastle.yml": {
      sha256: sha256(workflow),
    },
  };
  const manifestContent = canonicalJson({
    installerVersion: VERSION,
    managedAssets,
    projectAssets: [".sandcastle/config.json"],
    schemaVersion: 1,
    templateVersion: TEMPLATE_VERSION,
  });

  return [
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
      content: manifestContent,
      ownership: "installer-state",
      path: ".sandcastle/installation.json",
    },
  ];
}
