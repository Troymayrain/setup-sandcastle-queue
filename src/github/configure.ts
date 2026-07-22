import { execFile } from "node:child_process";
import sodium from "libsodium-wrappers";

import {
  ConfigurationError,
  InfrastructureError,
  type ProjectConfig,
} from "../config.js";

const confirmationCategories = [
  "labels",
  "environment",
  "provider-variable",
  "provider-secret",
] as const;

export type GitHubConfirmationCategory = (typeof confirmationCategories)[number];

export function validateGitHubResourceConfirmation(
  confirmation: string | undefined,
): GitHubConfirmationCategory[] {
  const supplied = confirmation?.split(",").filter(Boolean) ?? [];
  const suppliedSet = new Set(supplied);
  const complete =
    supplied.length === confirmationCategories.length &&
    suppliedSet.size === confirmationCategories.length &&
    confirmationCategories.every((category) => suppliedSet.has(category));
  if (!complete) {
    throw configurationError(
      "GITHUB_CONFIRMATION_INCOMPLETE",
      `--confirm-resources must explicitly include ${confirmationCategories.join(",")}.`,
    );
  }
  return [...confirmationCategories];
}

export interface GitHubConfigurationResource {
  action: "create" | "reuse" | "upsert";
  available?: boolean;
  category: GitHubConfirmationCategory;
  kind: "environment" | "environment-secret" | "environment-variable" | "label";
  name: string;
  value?: "[redacted]";
}

export interface GitHubConfigurationDiagnostic {
  guidance: string;
  kind:
    | "actions-permissions"
    | "branch-protection"
    | "environment-reviewers"
    | "organization-policy"
    | "pat-or-github-app"
    | "repository-rulesets";
  status: "configured" | "manual" | "missing" | "review-required";
}

export interface GitHubConfigurationPreview {
  confirmationsRequired: GitHubConfirmationCategory[];
  diagnostics: GitHubConfigurationDiagnostic[];
  mode: "preview";
  repository: string;
  resources: GitHubConfigurationResource[];
}

export interface GitHubConfigurationApplyResult {
  confirmations: GitHubConfirmationCategory[];
  diagnostics: GitHubConfigurationDiagnostic[];
  mode: "applied";
  repository: string;
  resources: GitHubConfigurationResource[];
}

export interface GitHubEnvironmentResourceState {
  providerSecretConfigured: boolean;
  providerVariableConfigured: boolean;
}

interface GitHubResponse<T> {
  data: T | null;
  headers: Headers;
  status: number;
}

class GitHubClient {
  readonly #apiUrl: string;
  readonly #token: string;

  constructor(apiUrl: string, token: string) {
    this.#apiUrl = apiUrl.replace(/\/$/u, "");
    this.#token = token;
  }

  async get<T>(path: string, allowedStatuses: number[] = [200]): Promise<GitHubResponse<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.#apiUrl}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "user-agent": "setup-sandcastle-queue",
          "x-github-api-version": "2022-11-28",
        },
        method: "GET",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new InfrastructureError([
        {
          code: "GITHUB_API_UNREACHABLE",
          message: "Unable to reach the GitHub API.",
        },
      ]);
    }
    if (!allowedStatuses.includes(response.status)) {
      throw new InfrastructureError([
        {
          code: "GITHUB_API_FAILED",
          message: `GitHub API read failed with status ${response.status}.`,
        },
      ]);
    }
    const source = await response.text();
    let data: T | null = null;
    if (source) {
      try {
        data = JSON.parse(source) as T;
      } catch {
        throw new InfrastructureError([
          {
            code: "GITHUB_API_INVALID_RESPONSE",
            message: "GitHub API returned an invalid JSON response.",
          },
        ]);
      }
    }
    return { data, headers: response.headers, status: response.status };
  }

  async write<T>(
    method: "PATCH" | "POST" | "PUT",
    path: string,
    body: object,
    allowedStatuses: number[],
  ): Promise<GitHubResponse<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.#apiUrl}${path}`, {
        body: JSON.stringify(body),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          "user-agent": "setup-sandcastle-queue",
          "x-github-api-version": "2022-11-28",
        },
        method,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new InfrastructureError([
        {
          code: "GITHUB_API_UNREACHABLE",
          message: "Unable to reach the GitHub API.",
        },
      ]);
    }
    if (!allowedStatuses.includes(response.status)) {
      throw new InfrastructureError([
        {
          code: "GITHUB_API_WRITE_FAILED",
          message: `GitHub API write failed with status ${response.status}.`,
        },
      ]);
    }
    const source = await response.text();
    let data: T | null = null;
    if (source) {
      try {
        data = JSON.parse(source) as T;
      } catch {
        throw new InfrastructureError([
          {
            code: "GITHUB_API_INVALID_RESPONSE",
            message: "GitHub API returned an invalid JSON response.",
          },
        ]);
      }
    }
    return { data, headers: response.headers, status: response.status };
  }
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function gitRemote(repository: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["remote", "get-url", "origin"],
      { cwd: repository, encoding: "utf8", timeout: 10_000 },
      (error, stdout) => {
        if (error) {
          reject(
            new InfrastructureError([
              {
                code: "GITHUB_REPOSITORY_UNDETERMINED",
                message: "Unable to read the origin Git remote.",
              },
            ]),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function parseGitHubRepository(remote: string): string {
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u,
    /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/u,
    /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u,
  ];
  for (const pattern of patterns) {
    const match = remote.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  throw configurationError(
    "GITHUB_REPOSITORY_UNSUPPORTED",
    "The origin remote is not a supported GitHub.com repository URL.",
  );
}

async function listLabels(
  client: GitHubClient,
  repository: string,
): Promise<Array<{ name: string }>> {
  const labels: Array<{ name: string }> = [];
  for (let page = 1; ; page += 1) {
    const response = await client.get<Array<{ name: string }>>(
      `/repos/${repository}/labels?per_page=100&page=${page}`,
    );
    const pageLabels = response.data ?? [];
    labels.push(...pageLabels);
    if (pageLabels.length < 100) {
      return labels;
    }
  }
}

function canonicalLabel(
  existingLabels: Array<{ name: string }>,
  configuredName: string,
): { action: "create" | "reuse"; name: string } {
  const existing = existingLabels.find(
    ({ name }) => name.toLocaleLowerCase("en-US") === configuredName.toLocaleLowerCase("en-US"),
  );
  return existing
    ? { action: "reuse", name: existing.name }
    : { action: "create", name: configuredName };
}

export async function previewGitHubConfiguration(
  repositoryPath: string,
  config: ProjectConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GitHubConfigurationPreview> {
  const githubToken = environment.GITHUB_TOKEN;
  if (!githubToken) {
    throw configurationError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to inspect GitHub repository configuration.",
    );
  }
  const repository = parseGitHubRepository(await gitRemote(repositoryPath));
  const client = new GitHubClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    githubToken,
  );
  const [metadataResponse, labels, environmentResponse, rulesetsResponse, actionsResponse] =
    await Promise.all([
      client.get<{ default_branch: string }>(`/repos/${repository}`),
      listLabels(client, repository),
      client.get(`/repos/${repository}/environments/sandcastle`, [200, 404]),
      client.get<unknown[]>(`/repos/${repository}/rulesets`),
      client.get<{ allowed_actions?: string }>(
        `/repos/${repository}/actions/permissions`,
      ),
    ]);
  const defaultBranch = metadataResponse.data?.default_branch;
  if (!defaultBranch) {
    throw new InfrastructureError([
      {
        code: "GITHUB_API_INVALID_RESPONSE",
        message: "GitHub repository metadata omitted the default branch.",
      },
    ]);
  }
  const protectionResponse = await client.get(
    `/repos/${repository}/branches/${encodeURIComponent(defaultBranch)}/protection`,
    [200, 404],
  );
  const readyLabel = canonicalLabel(labels, config.queue.readyLabel);
  const ownershipLabel = canonicalLabel(labels, config.queue.ownershipLabel);
  const resources: GitHubConfigurationResource[] = [
    {
      ...readyLabel,
      category: "labels",
      kind: "label",
    },
    {
      ...ownershipLabel,
      category: "labels",
      kind: "label",
    },
    {
      action: environmentResponse.status === 404 ? "create" : "reuse",
      category: "environment",
      kind: "environment",
      name: "sandcastle",
    },
    {
      action: "upsert",
      available: Boolean(environment.ANTHROPIC_BASE_URL),
      category: "provider-variable",
      kind: "environment-variable",
      name: "ANTHROPIC_BASE_URL",
      value: "[redacted]",
    },
    {
      action: "upsert",
      available: Boolean(environment.ANTHROPIC_AUTH_TOKEN),
      category: "provider-secret",
      kind: "environment-secret",
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "[redacted]",
    },
  ];
  const diagnostics: GitHubConfigurationDiagnostic[] = [
    {
      guidance:
        "Review and configure default-branch protection manually; the installer will not change it.",
      kind: "branch-protection",
      status: protectionResponse.status === 200 ? "configured" : "missing",
    },
    {
      guidance:
        "Review repository rulesets manually; the installer will not create or update rulesets.",
      kind: "repository-rulesets",
      status:
        Array.isArray(rulesetsResponse.data) && rulesetsResponse.data.length > 0
          ? "configured"
          : "missing",
    },
    {
      guidance:
        "Review high-privilege Actions settings manually; the installer only configures job-level permissions.",
      kind: "actions-permissions",
      status:
        actionsResponse.data?.allowed_actions === "selected"
          ? "configured"
          : "review-required",
    },
    {
      guidance:
        "Review organization policy manually; the installer will not change organization-level settings.",
      kind: "organization-policy",
      status: "manual",
    },
    {
      guidance:
        "Choose and provision any PAT or GitHub App manually; the installer does not create identities.",
      kind: "pat-or-github-app",
      status: "manual",
    },
    {
      guidance:
        "Configure Environment required reviewers manually if repository policy requires them.",
      kind: "environment-reviewers",
      status: "manual",
    },
  ];

  return {
    confirmationsRequired: [...confirmationCategories],
    diagnostics,
    mode: "preview",
    repository,
    resources,
  };
}

export async function applyGitHubConfiguration(
  preview: GitHubConfigurationPreview,
  confirmation: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GitHubConfigurationApplyResult> {
  const confirmations = validateGitHubResourceConfirmation(confirmation);
  const githubToken = environment.GITHUB_TOKEN;
  const providerBaseUrl = environment.ANTHROPIC_BASE_URL;
  const providerToken = environment.ANTHROPIC_AUTH_TOKEN;
  if (!githubToken) {
    throw configurationError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to configure GitHub repository resources.",
    );
  }
  if (!providerBaseUrl) {
    throw configurationError(
      "PROVIDER_BASE_URL_MISSING",
      "ANTHROPIC_BASE_URL is required to configure the provider Environment variable.",
    );
  }
  if (!providerToken) {
    throw configurationError(
      "PROVIDER_TOKEN_MISSING",
      "ANTHROPIC_AUTH_TOKEN is required to configure the provider Environment secret.",
    );
  }

  const client = new GitHubClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    githubToken,
  );
  const repositoryPath = `/repos/${preview.repository}`;
  for (const resource of preview.resources) {
    if (resource.kind === "label" && resource.action === "create") {
      await client.write("POST", `${repositoryPath}/labels`, {
        color: "5319E7",
        name: resource.name,
      }, [201]);
    }
  }

  await client.write(
    "PUT",
    `${repositoryPath}/environments/sandcastle`,
    {},
    [200],
  );
  const variablesResponse = await client.get<{
    variables?: Array<{ name: string }>;
  }>(`${repositoryPath}/environments/sandcastle/variables?per_page=100&page=1`);
  const existingVariable = variablesResponse.data?.variables?.find(
    ({ name }) => name === "ANTHROPIC_BASE_URL",
  );
  if (existingVariable) {
    await client.write(
      "PATCH",
      `${repositoryPath}/environments/sandcastle/variables/${encodeURIComponent(existingVariable.name)}`,
      { name: "ANTHROPIC_BASE_URL", value: providerBaseUrl },
      [204],
    );
  } else {
    await client.write(
      "POST",
      `${repositoryPath}/environments/sandcastle/variables`,
      { name: "ANTHROPIC_BASE_URL", value: providerBaseUrl },
      [201],
    );
  }

  const keyResponse = await client.get<{ key?: string; key_id?: string }>(
    `${repositoryPath}/environments/sandcastle/secrets/public-key`,
  );
  const publicKey = keyResponse.data?.key;
  const keyId = keyResponse.data?.key_id;
  if (!publicKey || !keyId) {
    throw new InfrastructureError([
      {
        code: "GITHUB_SECRET_KEY_INVALID",
        message: "GitHub omitted the Environment secret public key.",
      },
    ]);
  }
  let encryptedValue: string;
  try {
    await sodium.ready;
    encryptedValue = sodium.to_base64(
      sodium.crypto_box_seal(
        sodium.from_string(providerToken),
        sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL),
      ),
      sodium.base64_variants.ORIGINAL,
    );
  } catch {
    throw new InfrastructureError([
      {
        code: "GITHUB_SECRET_ENCRYPTION_FAILED",
        message: "Unable to encrypt the provider token for GitHub.",
      },
    ]);
  }
  await client.write(
    "PUT",
    `${repositoryPath}/environments/sandcastle/secrets/ANTHROPIC_AUTH_TOKEN`,
    { encrypted_value: encryptedValue, key_id: keyId },
    [201, 204],
  );

  return {
    confirmations,
    diagnostics: preview.diagnostics,
    mode: "applied",
    repository: preview.repository,
    resources: preview.resources,
  };
}

export async function inspectGitHubEnvironmentResources(
  repository: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GitHubEnvironmentResourceState> {
  const githubToken = environment.GITHUB_TOKEN;
  if (!githubToken) {
    throw configurationError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to inspect GitHub Environment resources.",
    );
  }
  const client = new GitHubClient(
    environment.GITHUB_API_URL ?? "https://api.github.com",
    githubToken,
  );
  const environmentPath = `/repos/${repository}/environments/sandcastle`;
  const [variablesResponse, secretsResponse] = await Promise.all([
    client.get<{ variables?: Array<{ name: string }> }>(
      `${environmentPath}/variables?per_page=100&page=1`,
      [200, 404],
    ),
    client.get<{ secrets?: Array<{ name: string }> }>(
      `${environmentPath}/secrets?per_page=100&page=1`,
      [200, 404],
    ),
  ]);
  return {
    providerSecretConfigured: Boolean(
      secretsResponse.data?.secrets?.some(
        ({ name }) => name === "ANTHROPIC_AUTH_TOKEN",
      ),
    ),
    providerVariableConfigured: Boolean(
      variablesResponse.data?.variables?.some(
        ({ name }) => name === "ANTHROPIC_BASE_URL",
      ),
    ),
  };
}
