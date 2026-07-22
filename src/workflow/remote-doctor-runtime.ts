import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CredentialBroker } from "../broker/server.js";
import { canonicalJson } from "../canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
} from "../config.js";
import { createHostGitEnvironment } from "../git/environment.js";
import { sha256 } from "../hash.js";
import { resolveRepositoryRoot } from "../git/repository.js";
import {
  createSandboxPlan,
  executeSandboxPlan,
} from "../sandbox/policy.js";
import type {
  RemoteDoctorProbeInput,
  RemoteDoctorProbeReceipt,
  RemoteDoctorRuntime,
} from "../remote-doctor.js";
import {
  isWorkflowSecurityContractSatisfied,
  readWorkflowJobPermissions,
} from "./security.js";
import { uploadWorkflowArtifact } from "./artifact.js";

const maximumProviderResponseBytes = 1024 * 1024;

interface ProviderObservation {
  id: string | null;
  status: number;
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function messagesUrl(source: string): URL {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw configurationError(
      "PROVIDER_BASE_URL_INVALID",
      "ANTHROPIC_BASE_URL must be a credential-free HTTP or HTTPS URL.",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw configurationError(
      "PROVIDER_BASE_URL_INVALID",
      "ANTHROPIC_BASE_URL must be a credential-free HTTP or HTTPS URL.",
    );
  }
  const basePath = url.pathname.replace(/\/$/u, "");
  url.pathname = basePath.endsWith("/v1")
    ? `${basePath}/messages`
    : `${basePath}/v1/messages`;
  return url;
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumProviderResponseBytes) {
      throw infrastructureError(
        "REMOTE_DOCTOR_PROVIDER_RESPONSE_INVALID",
        "The credential probe returned an oversized provider response.",
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw infrastructureError(
      "REMOTE_DOCTOR_PROVIDER_RESPONSE_INVALID",
      "The credential probe returned invalid provider JSON.",
    );
  }
}

function providerId(candidate: unknown, response: Response): string | null {
  const requestId = response.headers.get("request-id");
  if (requestId) return requestId.slice(0, 256);
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    typeof (candidate as { id?: unknown }).id === "string"
  ) {
    return ((candidate as { id: string }).id).slice(0, 256);
  }
  return null;
}

async function callProvider(
  baseUrl: string,
  token: string,
  model: string,
): Promise<ProviderObservation> {
  let response: Response;
  try {
    response = await fetch(messagesUrl(baseUrl), {
      body: JSON.stringify({
        max_tokens: 1,
        messages: [{ content: "Reply with OK.", role: "user" }],
        model,
      }),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": token,
      },
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw infrastructureError(
      "REMOTE_DOCTOR_PROVIDER_UNREACHABLE",
      "The credential probe could not reach the configured provider.",
    );
  }
  const candidate = await boundedResponseJson(response);
  if (!response.ok) {
    throw infrastructureError(
      "REMOTE_DOCTOR_PROVIDER_REJECTED",
      "The configured provider rejected the credential probe.",
    );
  }
  return { id: providerId(candidate, response), status: response.status };
}

function receipt(
  kind: "broker" | "credential" | "network" | "sandbox",
  input: RemoteDoctorProbeInput,
  evidence: unknown,
): RemoteDoctorProbeReceipt {
  return {
    ok: true,
    receiptId: `${kind}:${sha256(
      canonicalJson({
        bindingHash: input.bindingHash,
        evidence,
        model: input.model,
        runId: input.runId,
      }),
    ).slice(0, 48)}`,
  };
}

function gitFingerprint(repository: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      {
        cwd: repository,
        encoding: "utf8",
        env: createHostGitEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error) {
          reject(
            infrastructureError(
              "REMOTE_DOCTOR_REPOSITORY_INVALID",
              "The sandbox probe could not inspect the checked-out repository.",
            ),
          );
          return;
        }
        resolve(sha256(stdout));
      },
    );
  });
}

function sandboxProbeProgram(model: string): string {
  return `
const http = require("node:http");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.ANTHROPIC_API_KEY) process.exit(20);
if (!process.env.ANTHROPIC_BASE_URL?.startsWith("http://sandcastle-broker:8081/batches/") || !/^[A-Za-z0-9_-]{32,}$/.test(process.env.ANTHROPIC_AUTH_TOKEN || "")) process.exit(21);
let provider;
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    provider = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
      body: JSON.stringify({max_tokens: 1, messages: [{content: "Reply with OK.", role: "user"}], model: ${JSON.stringify(model)}}),
      headers: {authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN, "anthropic-version": "2023-06-01", "content-type": "application/json"},
      method: "POST",
      signal: AbortSignal.timeout(15000),
    });
    if (provider.ok) break;
  } catch {}
  await delay(250);
}
if (!provider?.ok) process.exit(22);
await provider.arrayBuffer();
const privateDenied = await new Promise((resolve) => {
  let settled = false;
  const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
  const request = http.request({host: "sandcastle-egress", method: "CONNECT", path: "169.254.169.254:80", port: 8080});
  request.once("connect", (response, socket) => { socket.destroy(); finish(response.statusCode === 403); });
  request.once("response", (response) => { response.resume(); finish(response.statusCode === 403); });
  request.once("error", () => finish(false));
  request.setTimeout(5000, () => { request.destroy(); finish(false); });
  request.end();
});
if (!privateDenied) process.exit(23);
`;
}

export interface WorkflowRemoteDoctorRuntimeOptions {
  configPath: string;
  environment: NodeJS.ProcessEnv;
  image: string;
  repositoryPath: string;
}

/** Build the concrete remote-doctor runtime used inside the dedicated Actions job. */
export async function createWorkflowRemoteDoctorRuntime(
  options: WorkflowRemoteDoctorRuntimeOptions,
): Promise<RemoteDoctorRuntime> {
  const root = await resolveRepositoryRoot(options.repositoryPath);
  const providerToken = options.environment.ANTHROPIC_AUTH_TOKEN;
  const providerBaseUrl = options.environment.ANTHROPIC_BASE_URL;
  if (!providerToken || !providerBaseUrl) {
    throw configurationError(
      "REMOTE_DOCTOR_CREDENTIAL_MISSING",
      "Remote doctor requires the Environment-scoped provider credential.",
    );
  }

  let sandboxExecution:
    | Promise<{ network: string; sandbox: string }>
    | undefined;
  const runSandboxBoundary = async (
    input: RemoteDoctorProbeInput,
  ): Promise<{ network: string; sandbox: string }> => {
    if (!sandboxExecution) {
      sandboxExecution = (async () => {
        const token = randomBytes(32).toString("base64url");
        const batchId = `remote-doctor:${input.runId}`;
        const scope = "remote-doctor";
        const scopedEnvironment: NodeJS.ProcessEnv = {
          ...options.environment,
          SANDCASTLE_BATCH_ID: batchId,
          SANDCASTLE_BROKER_BASE_URL:
            `http://sandcastle-broker:8081/batches/${encodeURIComponent(batchId)}/scopes/${scope}`,
          SANDCASTLE_SCOPE: scope,
          SANDCASTLE_SESSION_TOKEN: token,
        };
        const before = await gitFingerprint(root);
        const plan = await createSandboxPlan(
          root,
          options.configPath,
          "verification",
          options.image,
          `remote-doctor-${input.runId}`,
          ["node", "-e", sandboxProbeProgram(input.model)],
          scopedEnvironment,
        );
        const result = await executeSandboxPlan(
          plan,
          plan.planHash,
          scopedEnvironment,
        );
        const after = await gitFingerprint(root);
        if (result.exitCode !== 0 || before !== after) {
          throw infrastructureError(
            "REMOTE_DOCTOR_SANDBOX_FAILED",
            "The isolated sandbox boundary probe failed or changed the repository.",
          );
        }
        return {
          network: `${plan.planHash}:private-address-denied`,
          sandbox: `${plan.planHash}:scoped-credential-only`,
        };
      })();
    }
    return sandboxExecution;
  };

  return {
    async probeBroker(input) {
      const broker = new CredentialBroker(providerBaseUrl, providerToken);
      try {
        await broker.listen();
        const session = broker.createSession({
          batchId: `remote-doctor:${input.runId}`,
          models: [input.model],
          scope: "broker-probe",
          ttlSeconds: 120,
        });
        const observed = await callProvider(
          session.baseUrl,
          session.token,
          input.model,
        );
        const audit = broker.auditEvents();
        const event = audit[0];
        if (!event || audit.length !== 1 || event.status < 200 || event.status >= 300) {
          throw infrastructureError(
            "REMOTE_DOCTOR_BROKER_FAILED",
            "The scoped credential broker did not observe a successful provider call.",
          );
        }
        return receipt("broker", input, { audit: event, observed });
      } finally {
        await broker.close();
      }
    },
    async probeCredential(input) {
      return receipt(
        "credential",
        input,
        await callProvider(providerBaseUrl, providerToken, input.model),
      );
    },
    async probeNetworkPolicy(input) {
      return receipt("network", input, (await runSandboxBoundary(input)).network);
    },
    async probeSandbox(input) {
      return receipt("sandbox", input, (await runSandboxBoundary(input)).sandbox);
    },
    async readJobPermissions() {
      const workflow = await readFile(
        join(root, ".github", "workflows", "sandcastle.yml"),
        "utf8",
      );
      const permissions = readWorkflowJobPermissions(
        workflow,
        "remote-doctor",
      );
      if (!isWorkflowSecurityContractSatisfied(workflow) || !permissions) {
        return {
          actions: "write",
          contents: "write",
          issues: "write",
          pullRequests: "write",
        };
      }
      return permissions;
    },
    uploadArtifact: uploadWorkflowArtifact,
  };
}
