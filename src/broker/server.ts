import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createInterface } from "node:readline";

import { ConfigurationError, InfrastructureError } from "../config.js";
import { sha256 } from "../hash.js";

const maximumRequestBytes = 16 * 1024 * 1024;
const maximumSessionSeconds = 6 * 60 * 60;
const contextPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

interface BrokerSessionRecord {
  batchId: string;
  expiresAt: number;
  models: Set<string>;
  scope: string;
  state: "active" | "revoked";
}

export interface BrokerSessionRequest {
  batchId: string;
  models: string[];
  scope: string;
  ttlSeconds: number;
}

export interface BrokerSessionCredential {
  baseUrl: string;
  expiresAt: string;
  token: string;
}

export interface BrokerUsage {
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface BrokerAuditEvent {
  latencyMs: number;
  model: string | null;
  status: number;
  timestamp: string;
  usage: BrokerUsage | null;
}

class BrokerRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BrokerRequestError";
    this.code = code;
    this.status = status;
  }
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function validateContext(value: string, name: "Batch ID" | "scope"): void {
  if (!contextPattern.test(value)) {
    throw configurationError(
      "BROKER_SESSION_INVALID",
      `${name} is not a supported broker context identifier.`,
    );
  }
}

function providerMessagesUrl(source: string): URL {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw configurationError(
      "PROVIDER_BASE_URL_INVALID",
      "ANTHROPIC_BASE_URL must be a valid HTTP or HTTPS URL.",
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

function requestToken(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,})$/u);
  return match?.[1] ?? null;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes) {
      throw new BrokerRequestError(
        413,
        "BROKER_REQUEST_TOO_LARGE",
        "Broker request exceeds the supported size limit.",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requestModel(source: string): { body: Record<string, unknown>; model: string } {
  let candidate: unknown;
  try {
    candidate = JSON.parse(source) as unknown;
  } catch {
    throw new BrokerRequestError(
      400,
      "BROKER_REQUEST_INVALID",
      "Broker request body must be valid JSON.",
    );
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new BrokerRequestError(
      400,
      "BROKER_REQUEST_INVALID",
      "Broker request body must be a JSON object.",
    );
  }
  const body = candidate as Record<string, unknown>;
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new BrokerRequestError(
      400,
      "BROKER_MODEL_INVALID",
      "Broker request must name a model.",
    );
  }
  return { body, model: body.model };
}

function numericUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function extractUsage(candidate: unknown): BrokerUsage | null {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  const source =
    record.usage !== null &&
    typeof record.usage === "object" &&
    !Array.isArray(record.usage)
      ? (record.usage as Record<string, unknown>)
      : record.message !== null &&
          typeof record.message === "object" &&
          !Array.isArray(record.message) &&
          (record.message as Record<string, unknown>).usage !== null &&
          typeof (record.message as Record<string, unknown>).usage === "object"
        ? ((record.message as Record<string, unknown>).usage as Record<
            string,
            unknown
          >)
        : null;
  if (!source) {
    return null;
  }
  const usage: BrokerUsage = {
    cacheCreationInputTokens: numericUsage(source.cache_creation_input_tokens),
    cacheReadInputTokens: numericUsage(source.cache_read_input_tokens),
    inputTokens: numericUsage(source.input_tokens),
    outputTokens: numericUsage(source.output_tokens),
  };
  const compact = Object.fromEntries(
    Object.entries(usage).filter(([, value]) => value !== undefined),
  ) as BrokerUsage;
  return Object.keys(compact).length > 0 ? compact : null;
}

function mergeUsage(current: BrokerUsage | null, next: BrokerUsage | null): BrokerUsage | null {
  if (!next) {
    return current;
  }
  return { ...(current ?? {}), ...next };
}

function safeResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "request-id", "retry-after"]) {
    const value = response.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  return headers;
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  value: object,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

function parseSseUsage(source: string): BrokerUsage | null {
  let usage: BrokerUsage | null = null;
  for (const line of source.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      usage = mergeUsage(usage, extractUsage(JSON.parse(data) as unknown));
    } catch {
      // Provider event data remains opaque and is never added to broker audit output.
    }
  }
  return usage;
}

export class CredentialBroker {
  readonly #audit: BrokerAuditEvent[] = [];
  readonly #providerMessagesUrl: URL;
  readonly #providerToken: string;
  readonly #server: Server;
  readonly #sessions = new Map<string, BrokerSessionRecord>();
  #baseUrl: string | null = null;

  constructor(providerBaseUrl: string, providerToken: string) {
    if (!providerToken) {
      throw configurationError(
        "PROVIDER_TOKEN_MISSING",
        "ANTHROPIC_AUTH_TOKEN is required by the credential broker.",
      );
    }
    this.#providerMessagesUrl = providerMessagesUrl(providerBaseUrl);
    this.#providerToken = providerToken;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  async listen(host = "127.0.0.1", port = 0): Promise<string> {
    if (this.#baseUrl) {
      return this.#baseUrl;
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      throw infrastructureError(
        "BROKER_LISTEN_FAILED",
        "Credential broker did not receive a TCP listening address.",
      );
    }
    const visibleHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    this.#baseUrl = `http://${visibleHost}:${address.port}`;
    return this.#baseUrl;
  }

  createSession(request: BrokerSessionRequest): BrokerSessionCredential {
    if (!this.#baseUrl) {
      throw infrastructureError(
        "BROKER_NOT_LISTENING",
        "Credential broker must be listening before creating a session.",
      );
    }
    validateContext(request.batchId, "Batch ID");
    validateContext(request.scope, "scope");
    if (
      !Number.isInteger(request.ttlSeconds) ||
      request.ttlSeconds < 1 ||
      request.ttlSeconds > maximumSessionSeconds ||
      !Array.isArray(request.models) ||
      request.models.length === 0 ||
      request.models.length > 16 ||
      request.models.some(
        (model) => typeof model !== "string" || model.length === 0 || model.length > 256,
      ) ||
      new Set(request.models).size !== request.models.length
    ) {
      throw configurationError(
        "BROKER_SESSION_INVALID",
        "Broker session requires a bounded TTL and a unique non-empty model allowlist.",
      );
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + request.ttlSeconds * 1000;
    this.#sessions.set(sha256(token), {
      batchId: request.batchId,
      expiresAt,
      models: new Set(request.models),
      scope: request.scope,
      state: "active",
    });
    return {
      baseUrl: `${this.#baseUrl}/batches/${encodeURIComponent(
        request.batchId,
      )}/scopes/${encodeURIComponent(request.scope)}`,
      expiresAt: new Date(expiresAt).toISOString(),
      token,
    };
  }

  revokeSession(token: string): void {
    const session = this.#sessions.get(sha256(token));
    if (!session) {
      throw configurationError(
        "BROKER_TOKEN_UNKNOWN",
        "The broker session token is unknown.",
      );
    }
    session.state = "revoked";
  }

  auditEvents(): BrokerAuditEvent[] {
    return this.#audit.map((event) => ({
      ...event,
      usage: event.usage ? { ...event.usage } : null,
    }));
  }

  async close(): Promise<void> {
    if (!this.#server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  #record(
    startedAt: number,
    model: string | null,
    status: number,
    usage: BrokerUsage | null,
  ): void {
    this.#audit.push({
      latencyMs: Math.max(0, Date.now() - startedAt),
      model,
      status,
      timestamp: new Date(startedAt).toISOString(),
      usage,
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    let model: string | null = null;
    try {
      if (request.method !== "POST") {
        throw new BrokerRequestError(
          405,
          "BROKER_METHOD_NOT_ALLOWED",
          "Credential broker only accepts POST requests.",
        );
      }
      const url = new URL(request.url ?? "/", "http://broker.invalid");
      const match = url.pathname.match(
        /^\/batches\/([^/]+)\/scopes\/([^/]+)\/v1\/messages$/u,
      );
      if (!match?.[1] || !match[2]) {
        throw new BrokerRequestError(
          404,
          "BROKER_ROUTE_NOT_FOUND",
          "Credential broker route was not found.",
        );
      }
      const parsed = requestModel(await readBody(request));
      model = parsed.model;
      const token = requestToken(request.headers);
      if (!token) {
        throw new BrokerRequestError(
          401,
          "BROKER_TOKEN_INVALID",
          "A valid broker session token is required.",
        );
      }
      const session = this.#sessions.get(sha256(token));
      if (!session) {
        throw new BrokerRequestError(
          401,
          "BROKER_TOKEN_INVALID",
          "A valid broker session token is required.",
        );
      }
      if (session.state === "revoked") {
        throw new BrokerRequestError(
          401,
          "BROKER_TOKEN_REVOKED",
          "The broker session token is no longer active.",
        );
      }
      if (Date.now() >= session.expiresAt) {
        throw new BrokerRequestError(
          401,
          "BROKER_TOKEN_EXPIRED",
          "The broker session token has expired.",
        );
      }
      let batchId: string;
      let scope: string;
      try {
        batchId = decodeURIComponent(match[1]);
        scope = decodeURIComponent(match[2]);
      } catch {
        throw new BrokerRequestError(
          400,
          "BROKER_CONTEXT_INVALID",
          "Broker route context is malformed.",
        );
      }
      if (batchId !== session.batchId) {
        throw new BrokerRequestError(
          403,
          "BROKER_BATCH_MISMATCH",
          "Broker token is not valid for this Batch.",
        );
      }
      if (scope !== session.scope) {
        throw new BrokerRequestError(
          403,
          "BROKER_SCOPE_MISMATCH",
          "Broker token is not valid for this scope.",
        );
      }
      if (!session.models.has(model)) {
        throw new BrokerRequestError(
          403,
          "BROKER_MODEL_NOT_ALLOWED",
          "Requested model is outside this session allowlist.",
        );
      }

      let providerResponse: Response;
      try {
        providerResponse = await fetch(this.#providerMessagesUrl, {
          body: JSON.stringify(parsed.body),
          headers: {
            accept: request.headers.accept ?? "application/json",
            authorization: `Bearer ${this.#providerToken}`,
            "content-type": "application/json",
            ...(typeof request.headers["anthropic-beta"] === "string"
              ? { "anthropic-beta": request.headers["anthropic-beta"] }
              : {}),
            ...(typeof request.headers["anthropic-version"] === "string"
              ? { "anthropic-version": request.headers["anthropic-version"] }
              : {}),
            "user-agent": "setup-sandcastle-queue-broker",
            "x-api-key": this.#providerToken,
          },
          method: "POST",
          signal: AbortSignal.timeout(10 * 60 * 1000),
        });
      } catch {
        throw new BrokerRequestError(
          502,
          "BROKER_PROVIDER_UNREACHABLE",
          "Credential broker could not reach the configured provider.",
        );
      }

      const headers = safeResponseHeaders(providerResponse);
      response.writeHead(providerResponse.status, headers);
      let usage: BrokerUsage | null = null;
      if (
        providerResponse.headers.get("content-type")?.includes("text/event-stream") &&
        providerResponse.body
      ) {
        const decoder = new TextDecoder();
        let pending = "";
        for await (const chunk of providerResponse.body) {
          const buffer = Buffer.from(chunk);
          response.write(buffer);
          pending += decoder.decode(buffer, { stream: true });
          const boundary = pending.lastIndexOf("\n");
          if (boundary >= 0) {
            usage = mergeUsage(usage, parseSseUsage(pending.slice(0, boundary + 1)));
            pending = pending.slice(boundary + 1);
          }
          if (pending.length > 1024 * 1024) {
            pending = "";
          }
        }
        pending += decoder.decode();
        usage = mergeUsage(usage, parseSseUsage(pending));
        response.end();
      } else {
        const providerBody = await providerResponse.text();
        try {
          usage = extractUsage(JSON.parse(providerBody) as unknown);
        } catch {
          usage = null;
        }
        response.end(providerBody);
      }
      this.#record(startedAt, model, providerResponse.status, usage);
    } catch (error) {
      const brokerError =
        error instanceof BrokerRequestError
          ? error
          : new BrokerRequestError(
              500,
              "BROKER_INTERNAL_ERROR",
              "Credential broker failed safely.",
            );
      if (!response.headersSent) {
        jsonResponse(response, brokerError.status, {
          code: brokerError.code,
          message: brokerError.message,
        });
      } else {
        response.destroy();
      }
      this.#record(startedAt, model, brokerError.status, null);
    }
  }
}

interface ControlMessage {
  batchId?: unknown;
  command?: unknown;
  id?: unknown;
  models?: unknown;
  scope?: unknown;
  token?: unknown;
  ttlSeconds?: unknown;
}

function writeControlMessage(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function validControlId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(value);
}

export async function runCredentialBrokerProcess(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const providerToken = environment.ANTHROPIC_AUTH_TOKEN;
  const providerBaseUrl = environment.ANTHROPIC_BASE_URL;
  if (!providerToken) {
    throw configurationError(
      "PROVIDER_TOKEN_MISSING",
      "ANTHROPIC_AUTH_TOKEN is required by the credential broker.",
    );
  }
  if (!providerBaseUrl) {
    throw configurationError(
      "PROVIDER_BASE_URL_MISSING",
      "ANTHROPIC_BASE_URL is required by the credential broker.",
    );
  }
  const portSource = environment.SANDCASTLE_BROKER_PORT ?? "0";
  if (!/^(?:0|[1-9][0-9]{0,4})$/u.test(portSource) || Number(portSource) > 65_535) {
    throw configurationError(
      "BROKER_PORT_INVALID",
      "SANDCASTLE_BROKER_PORT must be a valid TCP port.",
    );
  }
  const broker = new CredentialBroker(providerBaseUrl, providerToken);
  const baseUrl = await broker.listen(
    environment.SANDCASTLE_BROKER_HOST ?? "127.0.0.1",
    Number(portSource),
  );
  writeControlMessage({ baseUrl, event: "ready" });

  const input = createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  let stopped = false;
  await new Promise<void>((resolve) => {
    input.on("line", (line) => {
      chain = chain.then(async () => {
        let message: ControlMessage;
        try {
          message = JSON.parse(line) as ControlMessage;
        } catch {
          writeControlMessage({
            code: "BROKER_CONTROL_INVALID",
            id: null,
            ok: false,
          });
          return;
        }
        const id = validControlId(message.id) ? message.id : null;
        if (!id || typeof message.command !== "string") {
          writeControlMessage({
            code: "BROKER_CONTROL_INVALID",
            id,
            ok: false,
          });
          return;
        }
        try {
          if (message.command === "create-session") {
            if (
              typeof message.batchId !== "string" ||
              typeof message.scope !== "string" ||
              !Array.isArray(message.models) ||
              !message.models.every((model) => typeof model === "string") ||
              typeof message.ttlSeconds !== "number"
            ) {
              throw configurationError(
                "BROKER_CONTROL_INVALID",
                "create-session control message is incomplete.",
              );
            }
            const result = broker.createSession({
              batchId: message.batchId,
              models: message.models,
              scope: message.scope,
              ttlSeconds: message.ttlSeconds,
            });
            writeControlMessage({ id, ok: true, result });
            return;
          }
          if (message.command === "revoke-session") {
            if (typeof message.token !== "string") {
              throw configurationError(
                "BROKER_CONTROL_INVALID",
                "revoke-session requires a token on the host control channel.",
              );
            }
            broker.revokeSession(message.token);
            writeControlMessage({ id, ok: true, result: { revoked: true } });
            return;
          }
          if (message.command === "read-audit") {
            writeControlMessage({ id, ok: true, result: broker.auditEvents() });
            return;
          }
          if (message.command === "shutdown") {
            writeControlMessage({ id, ok: true, result: { stopped: true } });
            stopped = true;
            input.close();
            await broker.close();
            resolve();
            return;
          }
          throw configurationError(
            "BROKER_CONTROL_INVALID",
            "Unknown broker control command.",
          );
        } catch (error) {
          const code =
            error instanceof ConfigurationError
              ? (error.diagnostics[0]?.code ?? "BROKER_CONTROL_INVALID")
              : "BROKER_CONTROL_FAILED";
          writeControlMessage({ code, id, ok: false });
        }
      });
    });
    input.on("close", () => {
      void chain.finally(async () => {
        if (!stopped) {
          await broker.close();
          resolve();
        }
      });
    });
  });
}
