import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import sodium from "libsodium-wrappers";

import type { QueueConfig } from "./config.js";
import { CliError } from "./errors.js";

const execute = promisify(execFile);
const secretName = "ANTHROPIC_AUTH_TOKEN";
const variableName = "ANTHROPIC_BASE_URL";

interface Credentials {
  baseUrl: string;
  token: string;
}

interface ResourcePlan {
  action: "create" | "preserve" | "reuse" | "upsert";
  kind: "label" | "secret" | "variable";
  name: string;
}

export interface GitHubPreview {
  repository: string;
  resources: ResourcePlan[];
  secretExists: boolean;
}

export interface GitHubApplyResult {
  ok: boolean;
  repository: string;
  resources: Array<ResourcePlan & { guidance?: string; status: "failed" | "ok" }>;
}

class GitHubClient {
  readonly #apiUrl: string;
  readonly #repository: string;
  readonly #token: string;

  constructor(environment: NodeJS.ProcessEnv) {
    const token = environment.GITHUB_TOKEN;
    const repository = environment.GITHUB_REPOSITORY;
    if (!token || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new CliError(
        3,
        "GITHUB_ENVIRONMENT_UNREADABLE",
        "GITHUB_TOKEN and GITHUB_REPOSITORY are required to inspect GitHub resources.",
      );
    }
    this.#apiUrl = (environment.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/u, "");
    this.#repository = repository;
    this.#token = token;
  }

  get repository(): string {
    return this.#repository;
  }

  async request<T>(
    method: "GET" | "PATCH" | "POST" | "PUT",
    path: string,
    body: object | undefined,
    allowed: number[],
  ): Promise<{ data: T | null; status: number }> {
    let response: Response;
    try {
      response = await fetch(`${this.#apiUrl}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": "setup-sandcastle-queue",
          "x-github-api-version": "2022-11-28",
        },
        method,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new CliError(3, "GITHUB_API_UNREADABLE", "Unable to reach the GitHub API.");
    }
    if (!allowed.includes(response.status)) {
      throw new CliError(
        method === "GET" ? 3 : 4,
        method === "GET" ? "GITHUB_API_UNREADABLE" : "GITHUB_RESOURCE_WRITE_FAILED",
        `GitHub ${method} request failed with status ${response.status}.`,
      );
    }
    if (response.status === 204 || response.status === 404) {
      return { data: null, status: response.status };
    }
    const source = await response.text();
    try {
      return { data: source ? (JSON.parse(source) as T) : null, status: response.status };
    } catch {
      throw new CliError(3, "GITHUB_API_UNREADABLE", "GitHub returned invalid JSON.");
    }
  }
}

function parseEnv(source: string): Partial<Record<typeof secretName | typeof variableName, string>> {
  const result: Partial<Record<typeof secretName | typeof variableName, string>> = {};
  for (const line of source.split(/\r?\n/u)) {
    const match = line.match(/^(ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL)=(.*)$/u);
    if (match?.[1]) result[match[1] as typeof secretName | typeof variableName] = match[2] ?? "";
  }
  return result;
}

async function readEnvFile(path: string): Promise<Partial<Record<string, string>>> {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new CliError(3, "PROVIDER_ENV_UNREADABLE", "Unable to read Provider credential file.");
  }
}

export async function resolveProviderCredentials(
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<Credentials | null> {
  const sources = [
    {
      [secretName]: environment[secretName],
      [variableName]: environment[variableName],
    },
    await readEnvFile(join(root, ".sandcastle", ".env")),
    await readEnvFile(join(root, ".env")),
  ];
  for (const source of sources) {
    const token = source[secretName];
    const baseUrl = source[variableName];
    if (token === undefined && baseUrl === undefined) continue;
    if (!token || !baseUrl) {
      throw new CliError(
        2,
        "PROVIDER_CREDENTIALS_INCOMPLETE",
        "Provider secret and base URL must be supplied together.",
      );
    }
    if (!/^https:\/\//u.test(baseUrl)) {
      throw new CliError(2, "PROVIDER_BASE_URL_INVALID", "Provider base URL must use HTTPS.");
    }
    return { baseUrl, token };
  }
  return null;
}

async function assertCredentialFilesUntracked(root: string): Promise<void> {
  for (const path of [".env", ".sandcastle/.env"]) {
    try {
      const result = await execute("git", ["ls-files", "--error-unmatch", "--", path], {
        cwd: root,
        encoding: "utf8",
      });
      if (result.stdout.trim()) {
        throw new CliError(
          4,
          "TRACKED_CREDENTIAL_FILE",
          "Tracked or staged Provider credential files block all GitHub writes.",
          { inventory: { paths: [path] } },
        );
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
    }
  }
}

async function labels(client: GitHubClient): Promise<Array<{ name: string }>> {
  const result: Array<{ name: string }> = [];
  for (let page = 1; ; page += 1) {
    const response = await client.request<Array<{ name: string }>>(
      "GET",
      `/repos/${client.repository}/labels?per_page=100&page=${page}`,
      undefined,
      [200],
    );
    const current = response.data ?? [];
    result.push(...current);
    if (current.length < 100) return result;
  }
}

export async function previewGitHubResources(
  config: QueueConfig,
  environment: NodeJS.ProcessEnv,
): Promise<GitHubPreview> {
  const client = new GitHubClient(environment);
  const [existingLabels, secret, variable] = await Promise.all([
    labels(client),
    client.request(
      "GET",
      `/repos/${client.repository}/actions/secrets/${secretName}`,
      undefined,
      [200, 404],
    ),
    client.request(
      "GET",
      `/repos/${client.repository}/actions/variables/${variableName}`,
      undefined,
      [200, 404],
    ),
  ]);
  const resources: ResourcePlan[] = [config.queue.readyLabel, config.queue.ownershipLabel].map(
    (configuredName) => {
      const existing = existingLabels.find(
        ({ name }) => name.toLowerCase() === configuredName.toLowerCase(),
      );
      return {
        action: existing ? "reuse" : "create",
        kind: "label",
        name: existing?.name ?? configuredName,
      };
    },
  );
  resources.push({
    action: secret.status === 200 ? "preserve" : "create",
    kind: "secret",
    name: secretName,
  });
  resources.push({
    action: variable.status === 200 ? "upsert" : "create",
    kind: "variable",
    name: variableName,
  });
  return {
    repository: client.repository,
    resources,
    secretExists: secret.status === 200,
  };
}

async function encryptedSecret(
  client: GitHubClient,
  credentials: Credentials,
): Promise<{ encrypted_value: string; key_id: string }> {
  const response = await client.request<{ key: string; key_id: string }>(
    "GET",
    `/repos/${client.repository}/actions/secrets/public-key`,
    undefined,
    [200],
  );
  if (!response.data?.key || !response.data.key_id) {
    throw new CliError(3, "GITHUB_API_UNREADABLE", "GitHub secret public key is missing.");
  }
  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(
    sodium.from_string(credentials.token),
    sodium.from_base64(response.data.key, sodium.base64_variants.ORIGINAL),
  );
  return {
    encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
    key_id: response.data.key_id,
  };
}

export async function applyGitHubResources(
  root: string,
  config: QueueConfig,
  preview: GitHubPreview,
  credentials: Credentials,
  overwriteSecret: boolean,
  environment: NodeJS.ProcessEnv,
): Promise<GitHubApplyResult> {
  await assertCredentialFilesUntracked(root);
  const client = new GitHubClient(environment);
  const results: GitHubApplyResult["resources"] = [];
  for (const resource of preview.resources) {
    if (resource.action === "reuse" || (resource.action === "preserve" && !overwriteSecret)) {
      results.push({ ...resource, status: "ok" });
      continue;
    }
    try {
      if (resource.kind === "label") {
        await client.request(
          "POST",
          `/repos/${client.repository}/labels`,
          { color: "0E8A16", name: resource.name },
          [201],
        );
      } else if (resource.kind === "secret") {
        await client.request(
          "PUT",
          `/repos/${client.repository}/actions/secrets/${secretName}`,
          await encryptedSecret(client, credentials),
          [201, 204],
        );
      } else if (resource.action === "create") {
        await client.request(
          "POST",
          `/repos/${client.repository}/actions/variables`,
          { name: variableName, value: credentials.baseUrl },
          [201],
        );
      } else {
        await client.request(
          "PATCH",
          `/repos/${client.repository}/actions/variables/${variableName}`,
          { name: variableName, value: credentials.baseUrl },
          [204],
        );
      }
      results.push({ ...resource, status: "ok" });
    } catch {
      results.push({
        ...resource,
        guidance: `Configure repository ${resource.kind} '${resource.name}' manually.`,
        status: "failed",
      });
    }
  }
  return {
    ok: results.every(({ status }) => status === "ok"),
    repository: preview.repository,
    resources: results,
  };
}

export async function inspectGitHubResources(
  config: QueueConfig,
  environment: NodeJS.ProcessEnv,
): Promise<{ missing: string[]; status: "fail" | "pass" }> {
  const preview = await previewGitHubResources(config, environment);
  const missing = preview.resources
    .filter(({ action }) => action === "create")
    .map(({ name }) => name)
    .sort();
  return { missing, status: missing.length === 0 ? "pass" : "fail" };
}
