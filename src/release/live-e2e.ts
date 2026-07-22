import { ConfigurationError } from "../config.js";
import {
  hasExactShape,
  isRecord,
  readBoundedJsonFile,
} from "../json.js";

const sha1Pattern = /^[a-f0-9]{40}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const opaqueIdPattern = /^[1-9][0-9]{0,19}$/u;
const gateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const repositoryPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const maximumInputBytes = 1024 * 1024;

export type LiveE2EFixture = "java-maven" | "python";

export interface LiveE2EFixtureTarget {
  fixture: LiveE2EFixture;
  repository: string;
}

export interface LiveE2EFixtureChecks {
  actions: true;
  broker: true;
  draftPullRequest: true;
  issueClosure: true;
  protectedPathMutationRejected: true;
  provider: true;
  remoteDoctor: true;
  runtimeSkills: true;
  sandboxHasGitHubToken: false;
  sandboxHasLongLivedProviderToken: false;
  tests: true;
  verification: true;
}

export interface LiveE2EFixtureEvidence {
  audit: {
    artifactId: string;
    commentId: string;
  };
  candidateSha: string;
  checks: LiveE2EFixtureChecks;
  fixture: LiveE2EFixture;
  gateId: string;
  identities: {
    issueNumber: number;
    pullRequestNumber: number;
    publishedCommit: string;
    remoteDoctorArtifactId: string;
    runtimeEnvironmentHash: string;
    skillHashes: {
      "code-review": string;
      implement: string;
      tdd: string;
    };
  };
  repository: string;
  run: {
    conclusion: "success";
    event: "workflow_dispatch";
    id: string;
    url: string;
  };
  runtimeAdapter: "java-maven" | "python-pip" | "python-uv";
  schemaVersion: 1;
}

export interface LiveE2EReleaseGateInput {
  actorPermission: "admin" | "maintain" | "read" | "triage" | "write";
  candidateSha: string;
  evidence: unknown[];
  gateId: string;
  targets: LiveE2EFixtureTarget[];
}

export interface LiveE2EGateDiagnostic {
  code: string;
  fixture?: LiveE2EFixture;
  message: string;
}

export interface LiveE2EReleaseGateResult {
  candidateSha: string | null;
  diagnostics: LiveE2EGateDiagnostic[];
  fixtures: LiveE2EFixtureEvidence[];
  gateId: string | null;
  ok: boolean;
  schemaVersion: 1;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function validTarget(value: unknown): value is LiveE2EFixtureTarget {
  return (
    hasExactShape(value, ["fixture", "repository"]) &&
    (value.fixture === "python" || value.fixture === "java-maven") &&
    typeof value.repository === "string" &&
    repositoryPattern.test(value.repository)
  );
}

function validChecks(value: unknown): value is LiveE2EFixtureChecks {
  return (
    hasExactShape(value, [
      "actions",
      "broker",
      "draftPullRequest",
      "issueClosure",
      "protectedPathMutationRejected",
      "provider",
      "remoteDoctor",
      "runtimeSkills",
      "sandboxHasGitHubToken",
      "sandboxHasLongLivedProviderToken",
      "tests",
      "verification",
    ]) &&
    value.actions === true &&
    value.broker === true &&
    value.draftPullRequest === true &&
    value.issueClosure === true &&
    value.protectedPathMutationRejected === true &&
    value.provider === true &&
    value.remoteDoctor === true &&
    value.runtimeSkills === true &&
    value.sandboxHasGitHubToken === false &&
    value.sandboxHasLongLivedProviderToken === false &&
    value.tests === true &&
    value.verification === true
  );
}

function validEvidence(
  value: unknown,
  target: LiveE2EFixtureTarget,
  candidateSha: string,
  gateId: string,
): value is LiveE2EFixtureEvidence {
  if (
    !hasExactShape(value, [
      "audit",
      "candidateSha",
      "checks",
      "fixture",
      "gateId",
      "identities",
      "repository",
      "run",
      "runtimeAdapter",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    value.fixture !== target.fixture ||
    value.repository !== target.repository ||
    value.candidateSha !== candidateSha ||
    value.gateId !== gateId ||
    !validChecks(value.checks) ||
    !hasExactShape(value.audit, ["artifactId", "commentId"]) ||
    typeof value.audit.artifactId !== "string" ||
    !opaqueIdPattern.test(value.audit.artifactId) ||
    typeof value.audit.commentId !== "string" ||
    !opaqueIdPattern.test(value.audit.commentId) ||
    !hasExactShape(value.identities, [
      "issueNumber",
      "pullRequestNumber",
      "publishedCommit",
      "remoteDoctorArtifactId",
      "runtimeEnvironmentHash",
      "skillHashes",
    ]) ||
    !positiveInteger(value.identities.issueNumber) ||
    !positiveInteger(value.identities.pullRequestNumber) ||
    typeof value.identities.publishedCommit !== "string" ||
    !sha1Pattern.test(value.identities.publishedCommit) ||
    typeof value.identities.remoteDoctorArtifactId !== "string" ||
    !opaqueIdPattern.test(value.identities.remoteDoctorArtifactId) ||
    typeof value.identities.runtimeEnvironmentHash !== "string" ||
    !sha256Pattern.test(value.identities.runtimeEnvironmentHash) ||
    !hasExactShape(value.identities.skillHashes, [
      "code-review",
      "implement",
      "tdd",
    ]) ||
    typeof value.identities.skillHashes["code-review"] !== "string" ||
    !sha256Pattern.test(value.identities.skillHashes["code-review"]) ||
    typeof value.identities.skillHashes.implement !== "string" ||
    !sha256Pattern.test(value.identities.skillHashes.implement) ||
    typeof value.identities.skillHashes.tdd !== "string" ||
    !sha256Pattern.test(value.identities.skillHashes.tdd) ||
    !hasExactShape(value.run, ["conclusion", "event", "id", "url"]) ||
    value.run.conclusion !== "success" ||
    value.run.event !== "workflow_dispatch" ||
    typeof value.run.id !== "string" ||
    !opaqueIdPattern.test(value.run.id) ||
    value.run.url !==
      `https://github.com/${target.repository}/actions/runs/${value.run.id}`
  ) {
    return false;
  }

  return target.fixture === "java-maven"
    ? value.runtimeAdapter === "java-maven"
    : value.runtimeAdapter === "python-pip" ||
        value.runtimeAdapter === "python-uv";
}

function report(
  input: Partial<Pick<LiveE2EReleaseGateInput, "candidateSha" | "gateId">>,
  diagnostics: LiveE2EGateDiagnostic[],
  fixtures: LiveE2EFixtureEvidence[] = [],
): LiveE2EReleaseGateResult {
  return {
    candidateSha:
      typeof input.candidateSha === "string" &&
      sha1Pattern.test(input.candidateSha)
        ? input.candidateSha
        : null,
    diagnostics,
    fixtures,
    gateId:
      typeof input.gateId === "string" && gateIdPattern.test(input.gateId)
        ? input.gateId
        : null,
    ok: diagnostics.length === 0 && fixtures.length === 2,
    schemaVersion: 1,
  };
}

/**
 * 校验由专用 fixture workflows 生成的 release-gate 证据。
 * 返回值只包含通过严格 schema 的证据或稳定诊断，不回显上游错误文本。
 */
export function evaluateLiveE2EReleaseGate(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): LiveE2EReleaseGateResult {
  const safeInput = isRecord(input) ? input : {};
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_JOB !== "live-e2e-gate" ||
    !environment.GITHUB_RUN_ID ||
    !opaqueIdPattern.test(environment.GITHUB_RUN_ID)
  ) {
    return report(safeInput, [
      {
        code: "LIVE_E2E_CONTEXT_INVALID",
        message:
          "The live E2E release gate runs only in its dedicated manual GitHub Actions job.",
      },
    ]);
  }

  if (
    !hasExactShape(input, [
      "actorPermission",
      "candidateSha",
      "evidence",
      "gateId",
      "targets",
    ]) ||
    typeof input.actorPermission !== "string" ||
    !["admin", "maintain", "read", "triage", "write"].includes(
      input.actorPermission,
    ) ||
    typeof input.candidateSha !== "string" ||
    !sha1Pattern.test(input.candidateSha) ||
    typeof input.gateId !== "string" ||
    !gateIdPattern.test(input.gateId) ||
    !Array.isArray(input.targets) ||
    !Array.isArray(input.evidence)
  ) {
    return report(safeInput, [
      {
        code: "LIVE_E2E_INPUT_INVALID",
        message: "The live E2E release-gate input is invalid.",
      },
    ]);
  }

  if (
    input.actorPermission !== "admin" &&
    input.actorPermission !== "maintain"
  ) {
    return report(input, [
      {
        code: "LIVE_E2E_MAINTAINER_REQUIRED",
        message: "Only a repository maintainer may run the live E2E release gate.",
      },
    ]);
  }

  const targets = input.targets;
  if (
    targets.length !== 2 ||
    !targets.every(validTarget) ||
    new Set(targets.map(({ fixture }) => fixture)).size !== 2 ||
    new Set(targets.map(({ repository }) => repository.toLowerCase())).size !==
      2
  ) {
    return report(input, [
      {
        code: "LIVE_E2E_TARGETS_INVALID",
        message:
          "The gate requires distinct dedicated Python and Java/Maven fixture repositories.",
      },
    ]);
  }

  const orderedTargets = (["python", "java-maven"] as const).map(
    (fixture) => targets.find((target) => target.fixture === fixture)!,
  );
  const diagnostics: LiveE2EGateDiagnostic[] = [];
  const fixtures: LiveE2EFixtureEvidence[] = [];
  for (const target of orderedTargets) {
    const matching = input.evidence.filter(
      (value) => isRecord(value) && value.fixture === target.fixture,
    );
    if (matching.length === 0) {
      diagnostics.push({
        code: "LIVE_E2E_EVIDENCE_MISSING",
        fixture: target.fixture,
        message: "Required live E2E fixture evidence is missing.",
      });
      continue;
    }
    if (
      matching.length !== 1 ||
      !validEvidence(
        matching[0],
        target,
        input.candidateSha,
        input.gateId,
      )
    ) {
      diagnostics.push({
        code: "LIVE_E2E_EVIDENCE_INVALID",
        fixture: target.fixture,
        message:
          "Live E2E fixture evidence is incomplete, unsafe, or bound to different gate inputs.",
      });
      continue;
    }
    fixtures.push(matching[0]);
  }

  if (input.evidence.length !== 2 && diagnostics.length === 0) {
    diagnostics.push({
      code: "LIVE_E2E_EVIDENCE_INVALID",
      message: "The live E2E gate received unexpected fixture evidence.",
    });
  }
  return report(input, diagnostics, diagnostics.length === 0 ? fixtures : []);
}

export async function readLiveE2EReleaseGateInput(
  path: string,
): Promise<unknown> {
  const result = await readBoundedJsonFile(path, maximumInputBytes);
  if (!result.ok && result.reason === "unavailable") {
    throw new ConfigurationError([
      {
        code: "LIVE_E2E_INPUT_UNAVAILABLE",
        message: "Unable to read the live E2E release-gate input.",
        path: "",
      },
    ]);
  }
  if (!result.ok && result.reason === "too-large") {
    throw new ConfigurationError([
      {
        code: "LIVE_E2E_INPUT_TOO_LARGE",
        message: "The live E2E release-gate input exceeds the size limit.",
        path: "",
      },
    ]);
  }
  if (!result.ok) {
    throw new ConfigurationError([
      {
        code: "LIVE_E2E_INPUT_INVALID_JSON",
        message: "The live E2E release-gate input is not valid JSON.",
        path: "",
      },
    ]);
  }
  return result.value;
}
