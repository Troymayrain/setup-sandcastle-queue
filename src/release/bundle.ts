import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { canonicalJson } from "../canonical-json.js";
import { ConfigurationError, type ProjectConfig } from "../config.js";
import { sha256 } from "../hash.js";
import {
  hasExactShape,
  isRecord,
  readBoundedJsonFile,
} from "../json.js";
import {
  renderCandidateAssets,
  RUNTIME_SKILL_HASHES,
} from "../installer/templates.js";
import { VERSION } from "../version.js";
import {
  CLAUDE_CODE_VERSION,
  CONTROL_PLANE_IMAGE,
  CONTROL_PLANE_IMAGE_DIGEST,
  CONTROL_PLANE_IMAGE_REPOSITORY,
  CONTROL_PLANE_NODE_VERSION,
} from "./metadata.js";

const shaPattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;
const dogfoodVersionPattern = /^0\.1\.(0|[1-9][0-9]*)$/u;
const maximumInputBytes = 4 * 1024 * 1024;
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

const releaseTemplateConfig: ProjectConfig = {
  audit: { retentionDays: 30 },
  commands: {
    tests: [{ argv: ["npm", "test"] }],
    verification: [{ argv: ["npm", "run", "typecheck"] }],
  },
  execution: {
    jobTimeoutMinutes: 350,
    maxTicketsPerRun: 3,
    minimumRemainingMinutes: 140,
    processingBudgetMinutes: 300,
    ticketTimeoutMinutes: 120,
  },
  provider: {
    kind: "anthropic-compatible",
    models: { ticket: "release-manifest-model" },
  },
  queue: {
    ownershipLabel: "sandcastle",
    readyLabel: "ready-for-agent",
  },
  runtime: {
    adapter: "node-npm",
    version: CONTROL_PLANE_NODE_VERSION,
  },
  schemaVersion: 1,
};

const requiredPackageContents = [
  "Dockerfile",
  "LICENSE",
  "OPERATIONS.md",
  "README.md",
  "RELEASE_NOTES.md",
  "SKILL.md",
  "THIRD_PARTY_NOTICES.md",
  "agents/openai.yaml",
  "assets/project-docs/sandcastle-queue.md",
  "control-plane/package-lock.json",
  "control-plane/package.json",
  "control-plane/runtime-package.json",
  "dist/cli.js",
  "dist/index.js",
  "package.json",
  "release-manifest.json",
  "schema/config.schema.json",
  "scripts/setup.mjs",
  "vendor/runtime-skills/implement/SKILL.md",
  "vendor/sandcastle-runtime/SKILL.md",
] as const;

const allowedPackageFiles = new Set([
  "Dockerfile",
  "LICENSE",
  "OPERATIONS.md",
  "README.md",
  "RELEASE_NOTES.md",
  "SKILL.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "release-manifest.json",
]);
const allowedPackagePrefixes = [
  "agents/",
  "assets/",
  "control-plane/",
  "dist/",
  "schema/",
  "scripts/",
  "vendor/",
] as const;

export interface ReleaseSourceManifest {
  candidateSha: string;
  controlPlaneLockSha256: string;
  licenseSha256: string;
  managedTemplatesSha256: string;
  noticesSha256: string;
  packageLockSha256: string;
  releaseNotesSha256: string;
  skillHashes: {
    "code-review": string;
    implement: string;
    tdd: string;
  };
  tag: string;
  version: string;
}

export type ReleaseGateKind =
  | "batch-dogfood"
  | "credentialless"
  | "legacy-dogfood"
  | "live-e2e";

export interface ReleasePrerequisiteEvidence {
  artifactId: string;
  candidateSha: string;
  conclusion: "success";
  kind: ReleaseGateKind;
  reportSha256: string;
  runId: string;
}

export interface ReleaseDogfoodPrerequisiteEvidence
  extends ReleasePrerequisiteEvidence {
  kind: "batch-dogfood" | "legacy-dogfood";
  testedVersion: string;
}

export interface ReleaseGateDiagnostic {
  code: string;
  message: string;
}

export interface ReleaseBundleGateResult {
  candidateSha: string | null;
  diagnostics: ReleaseGateDiagnostic[];
  gates: {
    batchDogfoodRunId: string;
    credentiallessRunId: string;
    dogfoodVersion: string;
    legacyDogfoodRunId: string;
    liveE2ERunId: string;
  } | null;
  image: string | null;
  ok: boolean;
  schemaVersion: 1;
  tag: string | null;
  version: string | null;
}

function fileHash(path: string): string {
  return sha256(readFileSync(join(packageRoot, path)));
}

function managedTemplatesHash(): string {
  const hashes = renderCandidateAssets(releaseTemplateConfig)
    .filter(({ ownership }) => ownership !== "project")
    .map(({ content, path }) => ({ path, sha256: sha256(content) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256(canonicalJson(hashes));
}

/** 读取当前候选源码中所有必须跨分发物保持一致的 release facts。 */
export function createReleaseSourceManifest(
  candidateSha: string,
): ReleaseSourceManifest {
  return {
    candidateSha,
    controlPlaneLockSha256: fileHash("control-plane/package-lock.json"),
    licenseSha256: fileHash("LICENSE"),
    managedTemplatesSha256: managedTemplatesHash(),
    noticesSha256: fileHash("THIRD_PARTY_NOTICES.md"),
    packageLockSha256: fileHash("package-lock.json"),
    releaseNotesSha256: fileHash("RELEASE_NOTES.md"),
    skillHashes: {
      "code-review": RUNTIME_SKILL_HASHES["code-review"],
      implement: RUNTIME_SKILL_HASHES.implement,
      tdd: RUNTIME_SKILL_HASHES.tdd,
    },
    tag: VERSION,
    version: VERSION,
  };
}

function exactManifest(
  value: unknown,
  expected: ReleaseSourceManifest,
): value is ReleaseSourceManifest {
  return (
    hasExactShape(value, [
      "candidateSha",
      "controlPlaneLockSha256",
      "licenseSha256",
      "managedTemplatesSha256",
      "noticesSha256",
      "packageLockSha256",
      "releaseNotesSha256",
      "skillHashes",
      "tag",
      "version",
    ]) &&
    hasExactShape(value.skillHashes, ["code-review", "implement", "tdd"]) &&
    canonicalJson(value) === canonicalJson(expected)
  );
}

function validContents(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length < requiredPackageContents.length ||
    !value.every((path) => {
      if (
        typeof path !== "string" ||
        path.length === 0 ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").includes("..")
      ) {
        return false;
      }
      return (
        allowedPackageFiles.has(path) ||
        allowedPackagePrefixes.some((prefix) => path.startsWith(prefix))
      );
    }) ||
    new Set(value).size !== value.length
  ) {
    return false;
  }
  return requiredPackageContents.every((path) => value.includes(path));
}

function validPrerequisite(
  value: unknown,
  kind: ReleaseGateKind,
  candidateSha: string,
): value is ReleasePrerequisiteEvidence {
  return (
    hasExactShape(value, [
      "artifactId",
      "candidateSha",
      "conclusion",
      "kind",
      "reportSha256",
      "runId",
    ]) &&
    typeof value.artifactId === "string" &&
    runIdPattern.test(value.artifactId) &&
    value.candidateSha === candidateSha &&
    value.conclusion === "success" &&
    value.kind === kind &&
    typeof value.reportSha256 === "string" &&
    sha256Pattern.test(value.reportSha256) &&
    typeof value.runId === "string" &&
    runIdPattern.test(value.runId)
  );
}

function validDogfoodPrerequisite(
  value: unknown,
  kind: "batch-dogfood" | "legacy-dogfood",
  candidateSha: string,
): value is ReleaseDogfoodPrerequisiteEvidence {
  return (
    hasExactShape(value, [
      "artifactId",
      "candidateSha",
      "conclusion",
      "kind",
      "reportSha256",
      "runId",
      "testedVersion",
    ]) &&
    typeof value.artifactId === "string" &&
    runIdPattern.test(value.artifactId) &&
    value.candidateSha === candidateSha &&
    value.conclusion === "success" &&
    value.kind === kind &&
    typeof value.reportSha256 === "string" &&
    sha256Pattern.test(value.reportSha256) &&
    typeof value.runId === "string" &&
    runIdPattern.test(value.runId) &&
    typeof value.testedVersion === "string" &&
    dogfoodVersionPattern.test(value.testedVersion)
  );
}

function validNpmArtifact(
  value: unknown,
  manifest: ReleaseSourceManifest,
): boolean {
  return (
    hasExactShape(value, [
      "contents",
      "filename",
      "manifest",
      "name",
      "sha256",
      "version",
    ]) &&
    value.name === "setup-sandcastle-queue" &&
    value.version === manifest.version &&
    value.filename === `setup-sandcastle-queue-${manifest.version}.tgz` &&
    typeof value.sha256 === "string" &&
    sha256Pattern.test(value.sha256) &&
    validContents(value.contents) &&
    exactManifest(value.manifest, manifest)
  );
}

function validSkillArtifact(
  value: unknown,
  manifest: ReleaseSourceManifest,
): boolean {
  return (
    hasExactShape(value, [
      "contents",
      "filename",
      "manifest",
      "sha256",
      "version",
    ]) &&
    value.version === manifest.version &&
    value.filename ===
      `setup-sandcastle-queue-skill-${manifest.version}.tgz` &&
    typeof value.sha256 === "string" &&
    sha256Pattern.test(value.sha256) &&
    validContents(value.contents) &&
    exactManifest(value.manifest, manifest)
  );
}

function validImageArtifact(
  value: unknown,
  manifest: ReleaseSourceManifest,
): boolean {
  return (
    hasExactShape(value, [
      "dependencyLockSha256",
      "digest",
      "manifest",
      "platform",
      "reference",
      "repository",
      "tag",
      "versions",
    ]) &&
    value.dependencyLockSha256 === manifest.controlPlaneLockSha256 &&
    value.digest === CONTROL_PLANE_IMAGE_DIGEST &&
    typeof value.digest === "string" &&
    digestPattern.test(value.digest) &&
    value.reference === CONTROL_PLANE_IMAGE &&
    value.repository === CONTROL_PLANE_IMAGE_REPOSITORY &&
    value.platform === "linux/amd64" &&
    value.tag === manifest.tag &&
    hasExactShape(value.versions, [
      "brokerSchema",
      "claudeCode",
      "node",
      "sandcastleQueue",
    ]) &&
    value.versions.brokerSchema === 1 &&
    value.versions.claudeCode === CLAUDE_CODE_VERSION &&
    value.versions.node === CONTROL_PLANE_NODE_VERSION &&
    value.versions.sandcastleQueue === manifest.version &&
    exactManifest(value.manifest, manifest)
  );
}

function validReleaseAsset(
  value: unknown,
  kind: "npm" | "skill",
  artifact: Record<string, unknown>,
): boolean {
  return (
    hasExactShape(value, ["filename", "kind", "sha256"]) &&
    value.kind === kind &&
    value.filename === artifact.filename &&
    value.sha256 === artifact.sha256
  );
}

function validGitHubRelease(
  value: unknown,
  manifest: ReleaseSourceManifest,
  npm: Record<string, unknown>,
  skill: Record<string, unknown>,
): boolean {
  return (
    hasExactShape(value, ["assets", "manifest", "tag", "targetCommitish"]) &&
    value.tag === manifest.tag &&
    value.targetCommitish === manifest.candidateSha &&
    exactManifest(value.manifest, manifest) &&
    Array.isArray(value.assets) &&
    value.assets.length === 2 &&
    validReleaseAsset(value.assets[0], "npm", npm) &&
    validReleaseAsset(value.assets[1], "skill", skill)
  );
}

function releaseSecretsPresent(environment: NodeJS.ProcessEnv): boolean {
  return [
    "GHCR_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "SANDCASTLE_RELEASE_TOKEN",
  ].some((name) => Boolean(environment[name]));
}

function gateResult(
  candidateSha: string | null,
  tag: string | null,
  diagnostics: ReleaseGateDiagnostic[],
  credentialless: ReleasePrerequisiteEvidence | null = null,
  liveE2E: ReleasePrerequisiteEvidence | null = null,
  legacyDogfood: ReleaseDogfoodPrerequisiteEvidence | null = null,
  batchDogfood: ReleaseDogfoodPrerequisiteEvidence | null = null,
  image: string | null = null,
): ReleaseBundleGateResult {
  return {
    candidateSha,
    diagnostics,
    gates:
      credentialless &&
      liveE2E &&
      legacyDogfood &&
      batchDogfood &&
      legacyDogfood.testedVersion === batchDogfood.testedVersion
        ? {
            batchDogfoodRunId: batchDogfood.runId,
            credentiallessRunId: credentialless.runId,
            dogfoodVersion: legacyDogfood.testedVersion,
            legacyDogfoodRunId: legacyDogfood.runId,
            liveE2ERunId: liveE2E.runId,
          }
        : null,
    image,
    ok: diagnostics.length === 0,
    schemaVersion: 1,
    tag,
    version: tag === VERSION ? VERSION : null,
  };
}

/** 在任何发布凭据进入 job 前校验全部候选分发物和前置 gate。 */
export function evaluateReleaseBundleGate(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): ReleaseBundleGateResult {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_JOB !== "release-gate" ||
    !environment.GITHUB_RUN_ID ||
    !runIdPattern.test(environment.GITHUB_RUN_ID)
  ) {
    return gateResult(null, null, [
      {
        code: "RELEASE_GATE_CONTEXT_INVALID",
        message:
          "Release evidence is accepted only from the dedicated manual release gate job.",
      },
    ]);
  }
  if (releaseSecretsPresent(environment)) {
    return gateResult(null, null, [
      {
        code: "RELEASE_GATE_SECRET_EXPOSED",
        message: "Release credentials must not enter the evidence gate job.",
      },
    ]);
  }
  if (
    !hasExactShape(input, [
      "artifacts",
      "candidateSha",
      "gates",
      "schemaVersion",
      "tag",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.candidateSha !== "string" ||
    !shaPattern.test(input.candidateSha) ||
    typeof input.tag !== "string"
  ) {
    return gateResult(null, null, [
      {
        code: "RELEASE_GATE_INPUT_INVALID",
        message: "The release bundle input is invalid.",
      },
    ]);
  }

  const diagnostics: ReleaseGateDiagnostic[] = [];
  const manifest = createReleaseSourceManifest(input.candidateSha);
  if (input.tag !== manifest.tag) {
    diagnostics.push({
      code: "RELEASE_TAG_INVALID",
      message: "The Git tag must equal the exact package SemVer.",
    });
  }

  let credentialless: ReleasePrerequisiteEvidence | null = null;
  let liveE2E: ReleasePrerequisiteEvidence | null = null;
  let legacyDogfood: ReleaseDogfoodPrerequisiteEvidence | null = null;
  let batchDogfood: ReleaseDogfoodPrerequisiteEvidence | null = null;
  if (
    !hasExactShape(input.gates, [
      "batchDogfood",
      "credentialless",
      "legacyDogfood",
      "liveE2E",
    ])
  ) {
    diagnostics.push({
      code: "RELEASE_PREREQUISITE_SET_INVALID",
      message: "The required release gate evidence set is incomplete.",
    });
  } else {
    if (
      validPrerequisite(
        input.gates.credentialless,
        "credentialless",
        input.candidateSha,
      )
    ) {
      credentialless = input.gates.credentialless;
    } else {
      diagnostics.push({
        code: "RELEASE_CREDENTIALLESS_GATE_INVALID",
        message:
          "Credentialless fixture and contract evidence is not a successful result for this candidate.",
      });
    }
    if (
      validPrerequisite(input.gates.liveE2E, "live-e2e", input.candidateSha)
    ) {
      liveE2E = input.gates.liveE2E;
    } else {
      diagnostics.push({
        code: "RELEASE_LIVE_E2E_GATE_INVALID",
        message:
          "Live E2E evidence is not a successful result for this candidate.",
      });
    }
    if (
      validDogfoodPrerequisite(
        input.gates.legacyDogfood,
        "legacy-dogfood",
        input.candidateSha,
      )
    ) {
      legacyDogfood = input.gates.legacyDogfood;
    } else {
      diagnostics.push({
        code: "RELEASE_LEGACY_DOGFOOD_GATE_INVALID",
        message:
          "Legacy lifecycle dogfood evidence is not a successful 0.1.x result for this candidate.",
      });
    }
    if (
      validDogfoodPrerequisite(
        input.gates.batchDogfood,
        "batch-dogfood",
        input.candidateSha,
      )
    ) {
      batchDogfood = input.gates.batchDogfood;
    } else {
      diagnostics.push({
        code: "RELEASE_BATCH_DOGFOOD_GATE_INVALID",
        message:
          "Three-ticket Batch dogfood evidence is not a successful 0.1.x result for this candidate.",
      });
    }
    if (
      legacyDogfood &&
      batchDogfood &&
      legacyDogfood.testedVersion !== batchDogfood.testedVersion
    ) {
      diagnostics.push({
        code: "RELEASE_DOGFOOD_VERSION_MISMATCH",
        message: "Both dogfood gates must exercise the same exact 0.1.x release.",
      });
    }
  }

  let image: string | null = null;
  if (
    !hasExactShape(input.artifacts, [
      "controlPlaneImage",
      "githubRelease",
      "npm",
      "skillSnapshot",
    ])
  ) {
    diagnostics.push({
      code: "RELEASE_ARTIFACT_SET_INVALID",
      message: "The release artifact evidence set is incomplete.",
    });
  } else {
    const npm = input.artifacts.npm;
    const skill = input.artifacts.skillSnapshot;
    const npmValid = validNpmArtifact(npm, manifest);
    const skillValid = validSkillArtifact(skill, manifest);
    const imageValid = validImageArtifact(
      input.artifacts.controlPlaneImage,
      manifest,
    );
    if (!npmValid) {
      diagnostics.push({
        code: "RELEASE_NPM_ARTIFACT_INVALID",
        message:
          "The npm package contents, version, checksum, or release manifest is invalid.",
      });
    }
    if (!skillValid) {
      diagnostics.push({
        code: "RELEASE_SKILL_ARTIFACT_INVALID",
        message:
          "The skill snapshot contents, version, checksum, or release manifest is invalid.",
      });
    }
    if (!imageValid) {
      diagnostics.push({
        code: "RELEASE_IMAGE_ARTIFACT_INVALID",
        message:
          "The control-plane image digest, versions, dependency lock, or release manifest is invalid.",
      });
    } else {
      image = CONTROL_PLANE_IMAGE;
    }
    if (
      !isRecord(npm) ||
      !isRecord(skill) ||
      !validGitHubRelease(
        input.artifacts.githubRelease,
        manifest,
        npm,
        skill,
      )
    ) {
      diagnostics.push({
        code: "RELEASE_GITHUB_ARTIFACT_INVALID",
        message:
          "The GitHub Release tag, target, asset checksums, or release manifest is invalid.",
      });
    }
  }

  return gateResult(
    input.candidateSha,
    input.tag,
    diagnostics,
    credentialless,
    liveE2E,
    legacyDogfood,
    batchDogfood,
    image,
  );
}

export async function readReleaseBundleGateInput(path: string): Promise<unknown> {
  const result = await readBoundedJsonFile(path, maximumInputBytes);
  if (!result.ok && result.reason === "unavailable") {
    throw new ConfigurationError([
      {
        code: "RELEASE_GATE_INPUT_UNAVAILABLE",
        message: "Unable to read the release bundle input.",
        path: "",
      },
    ]);
  }
  if (!result.ok && result.reason === "too-large") {
    throw new ConfigurationError([
      {
        code: "RELEASE_GATE_INPUT_TOO_LARGE",
        message: "The release bundle input exceeds the size limit.",
        path: "",
      },
    ]);
  }
  if (!result.ok) {
    throw new ConfigurationError([
      {
        code: "RELEASE_GATE_INPUT_INVALID_JSON",
        message: "The release bundle input is not valid JSON.",
        path: "",
      },
    ]);
  }
  return result.value;
}
