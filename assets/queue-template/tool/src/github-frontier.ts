import type { FrontierGitHub, GitHubIssue } from "./frontier.js";

export class RestFrontierGitHub implements FrontierGitHub {
  readonly #apiUrl: string;
  readonly #repository: string;
  readonly #token: string;

  constructor(environment: NodeJS.ProcessEnv) {
    const token = environment.GITHUB_TOKEN;
    const repository = environment.GITHUB_REPOSITORY;
    if (!token || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new Error("Host GitHub environment is incomplete.");
    }
    this.#apiUrl = (environment.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/u, "");
    this.#repository = repository;
    this.#token = token;
  }

  async #request<T>(
    method: "GET" | "POST",
    path: string,
    body?: object,
  ): Promise<T> {
    const response = await fetch(`${this.#apiUrl}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "user-agent": "sandcastle-queue-template",
        "x-github-api-version": "2022-11-28",
      },
      method,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${method} failed with status ${response.status}.`);
    }
    const source = await response.text();
    return (source ? JSON.parse(source) : null) as T;
  }

  async addLabel(issue: number, label: string): Promise<void> {
    await this.#request(
      "POST",
      `/repos/${this.#repository}/issues/${issue}/labels`,
      { labels: [label] },
    );
  }

  getIssue(issue: number): Promise<GitHubIssue> {
    return this.#request("GET", `/repos/${this.#repository}/issues/${issue}`);
  }

  listOpenIssues(page: number): Promise<GitHubIssue[]> {
    return this.#request(
      "GET",
      `/repos/${this.#repository}/issues?state=open&per_page=100&page=${page}`,
    );
  }
}
