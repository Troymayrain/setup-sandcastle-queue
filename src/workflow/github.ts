import { ConfigurationError, InfrastructureError } from "../config.js";
import { readBoundedGitHubResponseText } from "../github/response.js";
export { hasNextGitHubPage } from "../github/response.js";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export interface WorkflowGitHubResponse<T> {
  data: T | null;
  headers: Headers;
  status: number;
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

/** Minimal bounded REST client for credentialed workflow-host operations. */
export class WorkflowGitHubClient {
  readonly repository: string;
  readonly #apiUrl: string;
  readonly #token: string;

  constructor(environment: NodeJS.ProcessEnv) {
    const token = environment.GITHUB_TOKEN;
    const repository = environment.GITHUB_REPOSITORY;
    if (!token) {
      throw configurationError(
        "GITHUB_TOKEN_MISSING",
        "The workflow host requires its job-scoped GITHUB_TOKEN.",
      );
    }
    if (!repository || !repositoryPattern.test(repository)) {
      throw configurationError(
        "GITHUB_REPOSITORY_INVALID",
        "The workflow host requires the exact Actions repository identity.",
      );
    }
    this.#apiUrl = (environment.GITHUB_API_URL ?? "https://api.github.com").replace(
      /\/$/u,
      "",
    );
    this.#token = token;
    this.repository = repository;
  }

  async request<T>(
    method: "DELETE" | "GET" | "PATCH" | "POST",
    path: string,
    body: object | undefined,
    allowedStatuses: readonly number[],
  ): Promise<WorkflowGitHubResponse<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.#apiUrl}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": "setup-sandcastle-queue-workflow-host",
          "x-github-api-version": "2022-11-28",
        },
        method,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw infrastructureError(
        "GITHUB_API_UNREACHABLE",
        "The workflow host could not reach GitHub.",
      );
    }
    if (!allowedStatuses.includes(response.status)) {
      throw infrastructureError(
        method === "GET" ? "GITHUB_API_FAILED" : "GITHUB_API_WRITE_FAILED",
        `GitHub rejected a workflow host ${method} request with status ${response.status}.`,
      );
    }
    const source = await readBoundedGitHubResponseText(response);
    if (!source) {
      return { data: null, headers: response.headers, status: response.status };
    }
    try {
      return {
        data: JSON.parse(source) as T,
        headers: response.headers,
        status: response.status,
      };
    } catch {
      throw infrastructureError(
        "GITHUB_API_INVALID_RESPONSE",
        "GitHub returned invalid workflow host JSON.",
      );
    }
  }

  delete<T>(path: string): Promise<WorkflowGitHubResponse<T>> {
    return this.request<T>("DELETE", path, undefined, [204]);
  }

  get<T>(
    path: string,
    allowedStatuses: readonly number[] = [200],
  ): Promise<WorkflowGitHubResponse<T>> {
    return this.request<T>("GET", path, undefined, allowedStatuses);
  }

  patch<T>(path: string, body: object): Promise<WorkflowGitHubResponse<T>> {
    return this.request<T>("PATCH", path, body, [200]);
  }

  post<T>(
    path: string,
    body: object,
    allowedStatuses: readonly number[] = [201],
  ): Promise<WorkflowGitHubResponse<T>> {
    return this.request<T>("POST", path, body, allowedStatuses);
  }
}
