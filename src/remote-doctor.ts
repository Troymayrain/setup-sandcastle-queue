import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "./canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
  readProjectConfig,
  resolveModelRoles,
  type ProjectConfig,
} from "./config.js";
import { sha256 } from "./hash.js";
import { resolveRepositoryRoot } from "./installer/plan.js";
import { VERSION } from "./version.js";

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export type RemoteDoctorCheckId =
  | "artifact"
  | "broker"
  | "configuration"
  | "credential"
  | "network-policy"
  | "permissions"
  | "sandbox";

export interface RemoteDoctorCheck {
  id: RemoteDoctorCheckId;
  status: "fail" | "pass";
}

export interface RemoteDoctorDiagnostic {
  check: RemoteDoctorCheckId;
  code: string;
  message: string;
}

export interface RemoteDoctorBinding {
  configurationHash: string;
  installationVersion: string;
  workflowSha: string;
}

export interface RemoteDoctorProbeInput {
  bindingHash: string;
  model: string;
  runId: string;
}

export interface RemoteDoctorProbeReceipt {
  ok: true;
  receiptId: string;
}

export interface RemoteDoctorPermissions {
  actions: "none" | "read" | "write";
  contents: "none" | "read" | "write";
  issues: "none" | "read" | "write";
  pullRequests: "none" | "read" | "write";
}

export interface RemoteDoctorArtifactRequest {
  name: string;
  path: string;
  retentionDays: number;
}

export interface RemoteDoctorRuntime {
  probeBroker: (
    input: RemoteDoctorProbeInput,
  ) => Promise<RemoteDoctorProbeReceipt>;
  probeCredential: (
    input: RemoteDoctorProbeInput,
  ) => Promise<RemoteDoctorProbeReceipt>;
  probeNetworkPolicy: (
    input: RemoteDoctorProbeInput,
  ) => Promise<RemoteDoctorProbeReceipt>;
  probeSandbox: (
    input: RemoteDoctorProbeInput,
  ) => Promise<RemoteDoctorProbeReceipt>;
  readJobPermissions: () => Promise<RemoteDoctorPermissions>;
  uploadArtifact: (
    request: RemoteDoctorArtifactRequest,
  ) => Promise<{ artifactId: string }>;
}

export interface RemoteDoctorResult {
  artifactId: string | null;
  artifactName: string;
  binding: RemoteDoctorBinding;
  checks: RemoteDoctorCheck[];
  diagnostics: RemoteDoctorDiagnostic[];
  evidence: Partial<
    Record<
      "broker" | "credential" | "networkPolicy" | "sandbox",
      RemoteDoctorProbeReceipt
    >
  >;
  ok: boolean;
  runId: string;
  schemaVersion: 1;
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactShape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function validReceipt(value: unknown): value is RemoteDoctorProbeReceipt {
  return (
    hasExactShape(value, ["ok", "receiptId"]) &&
    value.ok === true &&
    typeof value.receiptId === "string" &&
    opaqueIdPattern.test(value.receiptId)
  );
}

function checkResults(
  diagnostics: RemoteDoctorDiagnostic[],
): RemoteDoctorCheck[] {
  const order: RemoteDoctorCheckId[] = [
    "configuration",
    "credential",
    "broker",
    "sandbox",
    "network-policy",
    "permissions",
    "artifact",
  ];
  return order.map((id) => ({
    id,
    status: diagnostics.some(({ check }) => check === id) ? "fail" : "pass",
  }));
}

function addDiagnostic(
  diagnostics: RemoteDoctorDiagnostic[],
  check: RemoteDoctorCheckId,
  code: string,
  message: string,
): void {
  diagnostics.push({ check, code, message });
}

async function runProbe(
  check: "broker" | "credential" | "network-policy" | "sandbox",
  probe: (
    input: RemoteDoctorProbeInput,
  ) => Promise<RemoteDoctorProbeReceipt>,
  input: RemoteDoctorProbeInput,
  diagnostics: RemoteDoctorDiagnostic[],
  usedReceipts: Set<string>,
): Promise<RemoteDoctorProbeReceipt | undefined> {
  let receipt: RemoteDoctorProbeReceipt;
  try {
    receipt = await probe(input);
  } catch {
    addDiagnostic(
      diagnostics,
      check,
      `REMOTE_DOCTOR_${check.replace("-", "_").toUpperCase()}_FAILED`,
      `The remote ${check.replace("-", " ")} probe failed.`,
    );
    return undefined;
  }
  if (!validReceipt(receipt) || usedReceipts.has(receipt.receiptId)) {
    addDiagnostic(
      diagnostics,
      check,
      "REMOTE_DOCTOR_EVIDENCE_INVALID",
      `The remote ${check.replace("-", " ")} probe returned invalid evidence.`,
    );
    return undefined;
  }
  usedReceipts.add(receipt.receiptId);
  return receipt;
}

function validPermissions(value: unknown): value is RemoteDoctorPermissions {
  return (
    hasExactShape(value, ["actions", "contents", "issues", "pullRequests"]) &&
    value.actions === "write" &&
    value.contents === "read" &&
    value.issues === "none" &&
    value.pullRequests === "none"
  );
}

export function createRemoteDoctorBinding(
  config: ProjectConfig,
  workflow: string,
  installationVersion: string = VERSION,
): RemoteDoctorBinding {
  return {
    configurationHash: sha256(canonicalJson(config)),
    installationVersion,
    workflowSha: sha256(workflow),
  };
}

export function remoteDoctorArtifactName(
  binding: RemoteDoctorBinding,
): string {
  return `sandcastle-remote-doctor-${sha256(canonicalJson(binding)).slice(0, 16)}`;
}

export async function runRemoteDoctor(
  repositoryPath: string,
  configPath: string,
  runtime: RemoteDoctorRuntime,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RemoteDoctorResult> {
  const runId = environment.GITHUB_RUN_ID;
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    environment.GITHUB_JOB !== "remote-doctor" ||
    environment.SANDCASTLE_OPERATION !== "remote-doctor" ||
    !runId ||
    !/^[1-9][0-9]*$/u.test(runId)
  ) {
    throw configurationError(
      "REMOTE_DOCTOR_CONTEXT_INVALID",
      "Remote doctor runs only in its dedicated manual GitHub Actions job.",
    );
  }
  const root = await resolveRepositoryRoot(repositoryPath);
  const [config, workflow] = await Promise.all([
    readProjectConfig(configPath),
    readFile(
      join(root, ".github", "workflows", "sandcastle.yml"),
      "utf8",
    ).catch(() => {
      throw new InfrastructureError([
        {
          code: "REMOTE_DOCTOR_WORKFLOW_UNAVAILABLE",
          message: "Unable to read the managed remote doctor workflow.",
        },
      ]);
    }),
  ]);
  const binding = createRemoteDoctorBinding(config, workflow);
  const bindingHash = sha256(canonicalJson(binding));
  const model = resolveModelRoles(config).roles.fast;
  const probeInput: RemoteDoctorProbeInput = {
    bindingHash,
    model,
    runId,
  };
  const diagnostics: RemoteDoctorDiagnostic[] = [];
  const evidence: RemoteDoctorResult["evidence"] = {};
  const usedReceipts = new Set<string>();
  const probes = [
    ["credential", "credential", runtime.probeCredential],
    ["broker", "broker", runtime.probeBroker],
    ["sandbox", "sandbox", runtime.probeSandbox],
    ["network-policy", "networkPolicy", runtime.probeNetworkPolicy],
  ] as const;
  for (const [check, evidenceName, probe] of probes) {
    const receipt = await runProbe(
      check,
      probe.bind(runtime),
      probeInput,
      diagnostics,
      usedReceipts,
    );
    if (receipt) evidence[evidenceName] = receipt;
  }

  let permissions: RemoteDoctorPermissions | undefined;
  try {
    permissions = await runtime.readJobPermissions();
  } catch {
    addDiagnostic(
      diagnostics,
      "permissions",
      "REMOTE_DOCTOR_PERMISSIONS_FAILED",
      "Unable to inspect remote doctor job permissions.",
    );
  }
  if (permissions && !validPermissions(permissions)) {
    addDiagnostic(
      diagnostics,
      "permissions",
      "REMOTE_DOCTOR_PERMISSIONS_INVALID",
      "Remote doctor job permissions exceed or omit the required operation scope.",
    );
  }

  const eligibleForSuccess = diagnostics.length === 0;
  const artifactName = eligibleForSuccess
    ? remoteDoctorArtifactName(binding)
    : `sandcastle-remote-doctor-failed-${runId}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sandcastle-remote-doctor-"));
  const artifactPath = join(temporaryRoot, "remote-doctor.json");
  let artifactId: string | null = null;
  try {
    const report: RemoteDoctorResult = {
      artifactId: null,
      artifactName,
      binding,
      checks: checkResults(diagnostics),
      diagnostics,
      evidence,
      ok: eligibleForSuccess,
      runId,
      schemaVersion: 1,
    };
    await writeFile(artifactPath, canonicalJson(report), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(artifactPath, 0o600);
    try {
      const uploaded = await runtime.uploadArtifact({
        name: artifactName,
        path: artifactPath,
        retentionDays: config.audit.retentionDays,
      });
      if (
        !isRecord(uploaded) ||
        typeof uploaded.artifactId !== "string" ||
        !opaqueIdPattern.test(uploaded.artifactId)
      ) {
        throw new Error("invalid artifact identity");
      }
      artifactId = uploaded.artifactId;
    } catch {
      addDiagnostic(
        diagnostics,
        "artifact",
        "REMOTE_DOCTOR_ARTIFACT_FAILED",
        "The remote doctor result artifact could not be uploaded.",
      );
    }
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }

  return {
    artifactId,
    artifactName,
    binding,
    checks: checkResults(diagnostics),
    diagnostics,
    evidence,
    ok: diagnostics.length === 0,
    runId,
    schemaVersion: 1,
  };
}
