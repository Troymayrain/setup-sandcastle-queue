import { readFile } from "node:fs/promises";

import { ConfigurationError } from "../config.js";

const shaPattern = /^[a-f0-9]{40}$/u;
const runIdPattern = /^[1-9][0-9]*$/u;
const maximumInputBytes = 4 * 1024 * 1024;

export const CREDENTIALLESS_FIXTURE_IDS = [
  "mixed-python-pip-node-npm",
  "python-uv",
  "node-npm",
  "go-module",
  "java-maven",
  "custom",
  "existing-install",
  "adopt",
  "upgrade",
] as const;

export type CredentiallessFixtureId =
  (typeof CREDENTIALLESS_FIXTURE_IDS)[number];

export const FIXTURE_LIFECYCLE_STEPS = [
  "install",
  "offline-doctor",
  "zero-diff-reinstall",
  "container-build",
  "bootstrap",
  "tests",
  "verification",
  "protected-path-gate",
  "upgrade-conflict",
  "rollback",
] as const;

export type FixtureLifecycleStep = (typeof FIXTURE_LIFECYCLE_STEPS)[number];

export const GITHUB_CONTRACT_CAPABILITIES = [
  "pagination",
  "stale-reads",
  "native-dependencies",
  "comments",
  "branches",
  "commits",
  "pull-requests",
  "rate-limits",
  "transient-failures",
] as const;

export const ANTHROPIC_CONTRACT_CAPABILITIES = [
  "streaming",
  "errors",
  "model-restrictions",
  "broker-metadata",
] as const;

export interface CredentiallessFixtureEvidence {
  candidateSha: string;
  fixture: CredentiallessFixtureId;
  observations: {
    audit: true;
    repository: true;
    sandbox: true;
    tracker: true;
  };
  schemaVersion: 1;
  steps: Array<{ id: FixtureLifecycleStep; status: "pass" }>;
  usedCredentials: false;
}

export interface CredentiallessContractEvidence {
  anthropic: Array<(typeof ANTHROPIC_CONTRACT_CAPABILITIES)[number]>;
  candidateSha: string;
  github: Array<(typeof GITHUB_CONTRACT_CAPABILITIES)[number]>;
}

export interface CredentiallessFixtureMatrixInput {
  candidateSha: string;
  contracts: CredentiallessContractEvidence;
  evidence: unknown[];
  schemaVersion: 1;
}

export interface CredentiallessFixtureDiagnostic {
  code: string;
  fixture?: CredentiallessFixtureId;
  message: string;
}

export interface CredentiallessFixtureMatrixResult {
  candidateSha: string | null;
  contracts: CredentiallessContractEvidence | null;
  diagnostics: CredentiallessFixtureDiagnostic[];
  fixtures: CredentiallessFixtureEvidence[];
  ok: boolean;
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

function exactStringArray(
  candidate: unknown,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(candidate) &&
    candidate.length === expected.length &&
    candidate.every((value, index) => value === expected[index])
  );
}

function validContracts(
  value: unknown,
  candidateSha: string,
): value is CredentiallessContractEvidence {
  return (
    hasExactShape(value, ["anthropic", "candidateSha", "github"]) &&
    value.candidateSha === candidateSha &&
    exactStringArray(value.anthropic, ANTHROPIC_CONTRACT_CAPABILITIES) &&
    exactStringArray(value.github, GITHUB_CONTRACT_CAPABILITIES)
  );
}

function validFixtureEvidence(
  value: unknown,
  fixture: CredentiallessFixtureId,
  candidateSha: string,
): value is CredentiallessFixtureEvidence {
  return (
    hasExactShape(value, [
      "candidateSha",
      "fixture",
      "observations",
      "schemaVersion",
      "steps",
      "usedCredentials",
    ]) &&
    value.schemaVersion === 1 &&
    value.candidateSha === candidateSha &&
    value.fixture === fixture &&
    value.usedCredentials === false &&
    hasExactShape(value.observations, [
      "audit",
      "repository",
      "sandbox",
      "tracker",
    ]) &&
    value.observations.audit === true &&
    value.observations.repository === true &&
    value.observations.sandbox === true &&
    value.observations.tracker === true &&
    Array.isArray(value.steps) &&
    value.steps.length === FIXTURE_LIFECYCLE_STEPS.length &&
    value.steps.every(
      (step, index) =>
        hasExactShape(step, ["id", "status"]) &&
        step.id === FIXTURE_LIFECYCLE_STEPS[index] &&
        step.status === "pass",
    )
  );
}

function result(
  candidate: unknown,
  diagnostics: CredentiallessFixtureDiagnostic[],
  contracts: CredentiallessContractEvidence | null = null,
  fixtures: CredentiallessFixtureEvidence[] = [],
): CredentiallessFixtureMatrixResult {
  const candidateSha =
    isRecord(candidate) &&
    typeof candidate.candidateSha === "string" &&
    shaPattern.test(candidate.candidateSha)
      ? candidate.candidateSha
      : null;
  return {
    candidateSha,
    contracts,
    diagnostics,
    fixtures,
    ok:
      diagnostics.length === 0 &&
      contracts !== null &&
      fixtures.length === CREDENTIALLESS_FIXTURE_IDS.length,
    schemaVersion: 1,
  };
}

function credentialEnvironmentPresent(environment: NodeJS.ProcessEnv): boolean {
  return [
    "ANTHROPIC_AUTH_TOKEN",
    "LIVE_E2E_DISPATCH_TOKEN",
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "SANDCASTLE_RELEASE_TOKEN",
  ].some((name) => Boolean(environment[name]));
}

/** 校验普通 CI 产生的无凭据 fixture 与本地 API contract 证据。 */
export function evaluateCredentiallessFixtureMatrix(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): CredentiallessFixtureMatrixResult {
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    !["pull_request", "push"].includes(environment.GITHUB_EVENT_NAME ?? "") ||
    environment.GITHUB_JOB !== "credentialless-gate" ||
    !environment.GITHUB_RUN_ID ||
    !runIdPattern.test(environment.GITHUB_RUN_ID)
  ) {
    return result(input, [
      {
        code: "CREDENTIALLESS_CI_CONTEXT_INVALID",
        message:
          "Credentialless fixture evidence is accepted only from the ordinary CI gate job.",
      },
    ]);
  }

  if (credentialEnvironmentPresent(environment)) {
    return result(input, [
      {
        code: "CREDENTIALLESS_CI_SECRET_EXPOSED",
        message:
          "Ordinary CI must not expose provider, live E2E, package, or release credentials.",
      },
    ]);
  }

  if (
    !hasExactShape(input, [
      "candidateSha",
      "contracts",
      "evidence",
      "schemaVersion",
    ]) ||
    input.schemaVersion !== 1 ||
    typeof input.candidateSha !== "string" ||
    !shaPattern.test(input.candidateSha) ||
    !Array.isArray(input.evidence)
  ) {
    return result(input, [
      {
        code: "CREDENTIALLESS_CI_INPUT_INVALID",
        message: "The credentialless fixture matrix input is invalid.",
      },
    ]);
  }

  if (!validContracts(input.contracts, input.candidateSha)) {
    return result(input, [
      {
        code: "CREDENTIALLESS_CONTRACT_EVIDENCE_INVALID",
        message:
          "The local GitHub and Anthropic contract capability evidence is incomplete.",
      },
    ]);
  }

  const diagnostics: CredentiallessFixtureDiagnostic[] = [];
  const fixtures: CredentiallessFixtureEvidence[] = [];
  for (const fixture of CREDENTIALLESS_FIXTURE_IDS) {
    const matching = input.evidence.filter(
      (candidate) => isRecord(candidate) && candidate.fixture === fixture,
    );
    if (
      matching.length !== 1 ||
      !validFixtureEvidence(matching[0], fixture, input.candidateSha)
    ) {
      diagnostics.push({
        code: "CREDENTIALLESS_FIXTURE_EVIDENCE_INVALID",
        fixture,
        message:
          "Fixture evidence is missing, duplicated, credentialed, or does not cover the required lifecycle.",
      });
      continue;
    }
    fixtures.push(matching[0]);
  }
  if (input.evidence.length !== CREDENTIALLESS_FIXTURE_IDS.length) {
    diagnostics.push({
      code: "CREDENTIALLESS_FIXTURE_SET_INVALID",
      message: "The credentialless matrix contains unexpected fixture evidence.",
    });
  }

  return result(
    input,
    diagnostics,
    input.contracts,
    diagnostics.length === 0 ? fixtures : [],
  );
}

export async function readCredentiallessFixtureMatrixInput(
  path: string,
): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new ConfigurationError([
      {
        code: "CREDENTIALLESS_CI_INPUT_UNAVAILABLE",
        message: "Unable to read the credentialless fixture matrix input.",
        path: "",
      },
    ]);
  }
  if (Buffer.byteLength(source, "utf8") > maximumInputBytes) {
    throw new ConfigurationError([
      {
        code: "CREDENTIALLESS_CI_INPUT_TOO_LARGE",
        message: "The credentialless fixture matrix input exceeds the size limit.",
        path: "",
      },
    ]);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ConfigurationError([
      {
        code: "CREDENTIALLESS_CI_INPUT_INVALID_JSON",
        message: "The credentialless fixture matrix input is not valid JSON.",
        path: "",
      },
    ]);
  }
}
