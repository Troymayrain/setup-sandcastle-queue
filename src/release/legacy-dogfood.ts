import { readFile } from "node:fs/promises";

import { ConfigurationError } from "../config.js";

const sha1Pattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const exactSemverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const opaqueIdPattern = /^[1-9][0-9]{0,19}$/u;
const gateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const findingCodePattern = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){1,7}$/u;
const repositoryPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const maximumInputBytes = 1024 * 1024;

export interface LegacyDogfoodChecks {
  adopt: true;
  codeReviewPatchMigrated: true;
  failureAtomicity: true;
  integrationPullRequestsResolved: true;
  legacyWorkflowQuiescent: true;
  localDoctor: true;
  managedDriftConflict: true;
  remoteDoctor: true;
  rollback: true;
  skillExtensionsMigrated: true;
  upstreamSnapshotsRestored: true;
  upgrade: true;
}

export interface LegacyDogfoodFinding {
  code: string;
  fixedInRelease: string;
  issueNumber: number;
  reverified: true;
}

export interface LegacyDogfoodEvidence {
  baselineSha: string;
  candidateSha: string;
  checks: LegacyDogfoodChecks;
  findings: LegacyDogfoodFinding[];
  gateId: string;
  gitEffects: {
    automaticCommits: 0;
    automaticPushes: 0;
    automaticResets: 0;
    automaticStashes: 0;
  };
  identities: {
    adoptPlanHash: string;
    remoteDoctorArtifactId: string;
    rollbackPlanHash: string;
    upgradePlanHash: string;
  };
  operationCounts: {
    adopt: 1;
    managedDriftConflict: 1;
    rollback: 1;
    upgrade: 1;
  };
  release: {
    installerPackageSha256: string;
    releaseManifestSha256: string;
    skillSnapshotSha256: string;
    version: string;
  };
  repository: string;
  run: {
    conclusion: "success";
    event: "workflow_dispatch";
    id: string;
    url: string;
  };
  schemaVersion: 1;
  stateHashes: {
    failedApplyAfter: string;
    failedApplyBefore: string;
    managedDriftAfter: string;
    managedDriftBefore: string;
    rollbackActual: string;
    rollbackExpected: string;
  };
}

export interface LegacyDogfoodGateInput {
  actorPermission: "admin" | "maintain" | "read" | "triage" | "write";
  baselineSha: string;
  candidateSha: string;
  evidence: unknown;
  gateId: string;
  releaseVersion: string;
  repository: string;
}

export interface LegacyDogfoodGateDiagnostic {
  code: string;
  message: string;
}

export interface LegacyDogfoodGateResult {
  baselineSha: string | null;
  candidateSha: string | null;
  diagnostics: LegacyDogfoodGateDiagnostic[];
  findings: LegacyDogfoodFinding[];
  gateId: string | null;
  ok: boolean;
  releaseVersion: string | null;
  repository: string | null;
  run: { id: string; url: string } | null;
  schemaVersion: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactShape(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function semverParts(value: string): [number, number, number] | null {
  const match = value.match(exactSemverPattern);
  if (!match) {
    return null;
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    return null;
  }
  return parts as [number, number, number];
}

function releaseContains(fixedInRelease: string, testedRelease: string): boolean {
  const fixed = semverParts(fixedInRelease);
  const tested = semverParts(testedRelease);
  if (!fixed || !tested) {
    return false;
  }
  for (let index = 0; index < fixed.length; index += 1) {
    if (fixed[index] !== tested[index]) {
      return fixed[index]! < tested[index]!;
    }
  }
  return true;
}

function validChecks(value: unknown): value is LegacyDogfoodChecks {
  const keys = [
    "adopt",
    "codeReviewPatchMigrated",
    "failureAtomicity",
    "integrationPullRequestsResolved",
    "legacyWorkflowQuiescent",
    "localDoctor",
    "managedDriftConflict",
    "remoteDoctor",
    "rollback",
    "skillExtensionsMigrated",
    "upstreamSnapshotsRestored",
    "upgrade",
  ] as const;
  return hasExactShape(value, keys) && keys.every((key) => value[key] === true);
}

function validFindings(
  value: unknown,
  releaseVersion: string,
): value is LegacyDogfoodFinding[] {
  if (!Array.isArray(value) || value.length > 100) {
    return false;
  }
  const findings = value.filter(
    (finding): finding is LegacyDogfoodFinding =>
      hasExactShape(finding, [
        "code",
        "fixedInRelease",
        "issueNumber",
        "reverified",
      ]) &&
      typeof finding.code === "string" &&
      findingCodePattern.test(finding.code) &&
      finding.code.length <= 64 &&
      typeof finding.fixedInRelease === "string" &&
      releaseContains(finding.fixedInRelease, releaseVersion) &&
      positiveInteger(finding.issueNumber) &&
      finding.reverified === true,
  );
  return (
    findings.length === value.length &&
    new Set(findings.map(({ code }) => code)).size === findings.length &&
    new Set(findings.map(({ issueNumber }) => issueNumber)).size ===
      findings.length
  );
}

function validEvidence(
  value: unknown,
  input: LegacyDogfoodGateInput,
): value is LegacyDogfoodEvidence {
  if (
    !hasExactShape(value, [
      "baselineSha",
      "candidateSha",
      "checks",
      "findings",
      "gateId",
      "gitEffects",
      "identities",
      "operationCounts",
      "release",
      "repository",
      "run",
      "schemaVersion",
      "stateHashes",
    ]) ||
    value.schemaVersion !== 1 ||
    value.baselineSha !== input.baselineSha ||
    value.candidateSha !== input.candidateSha ||
    value.gateId !== input.gateId ||
    value.repository !== input.repository ||
    !validChecks(value.checks) ||
    !validFindings(value.findings, input.releaseVersion) ||
    !hasExactShape(value.gitEffects, [
      "automaticCommits",
      "automaticPushes",
      "automaticResets",
      "automaticStashes",
    ]) ||
    value.gitEffects.automaticCommits !== 0 ||
    value.gitEffects.automaticPushes !== 0 ||
    value.gitEffects.automaticResets !== 0 ||
    value.gitEffects.automaticStashes !== 0 ||
    !hasExactShape(value.identities, [
      "adoptPlanHash",
      "remoteDoctorArtifactId",
      "rollbackPlanHash",
      "upgradePlanHash",
    ]) ||
    typeof value.identities.adoptPlanHash !== "string" ||
    !sha256Pattern.test(value.identities.adoptPlanHash) ||
    typeof value.identities.remoteDoctorArtifactId !== "string" ||
    !opaqueIdPattern.test(value.identities.remoteDoctorArtifactId) ||
    typeof value.identities.rollbackPlanHash !== "string" ||
    !sha256Pattern.test(value.identities.rollbackPlanHash) ||
    typeof value.identities.upgradePlanHash !== "string" ||
    !sha256Pattern.test(value.identities.upgradePlanHash) ||
    !hasExactShape(value.operationCounts, [
      "adopt",
      "managedDriftConflict",
      "rollback",
      "upgrade",
    ]) ||
    value.operationCounts.adopt !== 1 ||
    value.operationCounts.managedDriftConflict !== 1 ||
    value.operationCounts.rollback !== 1 ||
    value.operationCounts.upgrade !== 1 ||
    !hasExactShape(value.release, [
      "installerPackageSha256",
      "releaseManifestSha256",
      "skillSnapshotSha256",
      "version",
    ]) ||
    value.release.version !== input.releaseVersion ||
    typeof value.release.installerPackageSha256 !== "string" ||
    !sha256Pattern.test(value.release.installerPackageSha256) ||
    typeof value.release.releaseManifestSha256 !== "string" ||
    !sha256Pattern.test(value.release.releaseManifestSha256) ||
    typeof value.release.skillSnapshotSha256 !== "string" ||
    !sha256Pattern.test(value.release.skillSnapshotSha256) ||
    !hasExactShape(value.run, ["conclusion", "event", "id", "url"]) ||
    value.run.conclusion !== "success" ||
    value.run.event !== "workflow_dispatch" ||
    typeof value.run.id !== "string" ||
    !opaqueIdPattern.test(value.run.id) ||
    value.run.url !==
      `https://github.com/${input.repository}/actions/runs/${value.run.id}` ||
    !hasExactShape(value.stateHashes, [
      "failedApplyAfter",
      "failedApplyBefore",
      "managedDriftAfter",
      "managedDriftBefore",
      "rollbackActual",
      "rollbackExpected",
    ])
  ) {
    return false;
  }
  const hashes = Object.values(value.stateHashes);
  return (
    hashes.every((hash) =>
      typeof hash === "string" ? sha256Pattern.test(hash) : false,
    ) &&
    value.stateHashes.failedApplyAfter ===
      value.stateHashes.failedApplyBefore &&
    value.stateHashes.managedDriftAfter ===
      value.stateHashes.managedDriftBefore &&
    value.stateHashes.rollbackActual === value.stateHashes.rollbackExpected
  );
}

function report(
  input: Partial<LegacyDogfoodGateInput>,
  diagnostics: LegacyDogfoodGateDiagnostic[],
  evidence?: LegacyDogfoodEvidence,
): LegacyDogfoodGateResult {
  return {
    baselineSha:
      typeof input.baselineSha === "string" && sha1Pattern.test(input.baselineSha)
        ? input.baselineSha
        : null,
    candidateSha:
      typeof input.candidateSha === "string" &&
      sha1Pattern.test(input.candidateSha)
        ? input.candidateSha
        : null,
    diagnostics,
    findings: evidence?.findings ?? [],
    gateId:
      typeof input.gateId === "string" && gateIdPattern.test(input.gateId)
        ? input.gateId
        : null,
    ok: diagnostics.length === 0 && evidence !== undefined,
    releaseVersion:
      typeof input.releaseVersion === "string" &&
      exactSemverPattern.test(input.releaseVersion)
        ? input.releaseVersion
        : null,
    repository:
      typeof input.repository === "string" &&
      repositoryPattern.test(input.repository)
        ? input.repository
        : null,
    run: evidence ? { id: evidence.run.id, url: evidence.run.url } : null,
    schemaVersion: 1,
  };
}

/**
 * 校验真实 legacy 仓库产生的脱敏 lifecycle dogfood 证据。
 * 无效输入只返回稳定诊断，不保留目标 workflow 的任意文本。
 */
export function evaluateLegacyDogfoodGate(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): LegacyDogfoodGateResult {
  const safeInput = isRecord(input) ? input : {};
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_JOB !== "legacy-dogfood-gate" ||
    !environment.GITHUB_RUN_ID ||
    !opaqueIdPattern.test(environment.GITHUB_RUN_ID)
  ) {
    return report(safeInput, [
      {
        code: "LEGACY_DOGFOOD_CONTEXT_INVALID",
        message:
          "The legacy dogfood gate runs only in its dedicated manual GitHub Actions job.",
      },
    ]);
  }

  if (
    !hasExactShape(input, [
      "actorPermission",
      "baselineSha",
      "candidateSha",
      "evidence",
      "gateId",
      "releaseVersion",
      "repository",
    ]) ||
    typeof input.actorPermission !== "string" ||
    !["admin", "maintain", "read", "triage", "write"].includes(
      input.actorPermission,
    ) ||
    typeof input.baselineSha !== "string" ||
    !sha1Pattern.test(input.baselineSha) ||
    typeof input.candidateSha !== "string" ||
    !sha1Pattern.test(input.candidateSha) ||
    typeof input.gateId !== "string" ||
    !gateIdPattern.test(input.gateId) ||
    typeof input.releaseVersion !== "string" ||
    !exactSemverPattern.test(input.releaseVersion) ||
    typeof input.repository !== "string" ||
    !repositoryPattern.test(input.repository)
  ) {
    return report(safeInput, [
      {
        code: "LEGACY_DOGFOOD_INPUT_INVALID",
        message: "The legacy dogfood gate input is invalid.",
      },
    ]);
  }

  if (
    input.actorPermission !== "admin" &&
    input.actorPermission !== "maintain"
  ) {
    return report(input, [
      {
        code: "LEGACY_DOGFOOD_MAINTAINER_REQUIRED",
        message: "Only a repository maintainer may run the legacy dogfood gate.",
      },
    ]);
  }

  const gateInput = input as unknown as LegacyDogfoodGateInput;
  if (!validEvidence(gateInput.evidence, gateInput)) {
    return report(gateInput, [
      {
        code: "LEGACY_DOGFOOD_EVIDENCE_INVALID",
        message:
          "Legacy dogfood evidence is incomplete, unsafe, or bound to different gate inputs.",
      },
    ]);
  }

  return report(gateInput, [], gateInput.evidence);
}

export async function readLegacyDogfoodGateInput(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new ConfigurationError([
      {
        code: "LEGACY_DOGFOOD_INPUT_UNAVAILABLE",
        message: "Unable to read the legacy dogfood gate input.",
        path: "",
      },
    ]);
  }
  if (Buffer.byteLength(source, "utf8") > maximumInputBytes) {
    throw new ConfigurationError([
      {
        code: "LEGACY_DOGFOOD_INPUT_TOO_LARGE",
        message: "The legacy dogfood gate input exceeds the size limit.",
        path: "",
      },
    ]);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ConfigurationError([
      {
        code: "LEGACY_DOGFOOD_INPUT_INVALID_JSON",
        message: "The legacy dogfood gate input is not valid JSON.",
        path: "",
      },
    ]);
  }
}
