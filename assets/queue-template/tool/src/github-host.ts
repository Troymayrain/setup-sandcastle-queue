import type { FrontierGitHub, GitHubIssue } from "./frontier.js";
import type {
  DraftPullRequest,
  IntegrationPullRequest,
} from "./integration-pull-request.js";
import {
  renderFinalFixMarker,
  renderFinalRereviewMarker,
  renderFinalReviewMarker,
  type FinalFixMarker,
  type FinalRereviewMarker,
  type FinalReviewMarker,
} from "./final-review-facts.js";
import { renderPublicationMarker } from "./publication-facts.js";
import type { PublicationMarker } from "./publication-facts.js";

type RetryMode = "none" | "retryable";

export class RestGitHubHost implements FrontierGitHub {
  readonly #apiUrl: string;
  readonly #now: () => number;
  readonly #repository: string;
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #token: string;

  constructor(
    environment: NodeJS.ProcessEnv,
    retry: {
      now?: () => number;
      sleep?: (delayMs: number) => Promise<void>;
    } = {},
  ) {
    const token = environment.GITHUB_TOKEN;
    const repository = environment.GITHUB_REPOSITORY;
    if (!token || !repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new Error("Host GitHub environment is incomplete.");
    }
    this.#apiUrl = (environment.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/u, "");
    this.#now = retry.now ?? (() => Date.now());
    this.#repository = repository;
    this.#sleep =
      retry.sleep ??
      ((delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.#token = token;
  }

  #retryDelay(response: Response | undefined, attempt: number): number {
    const retryAfter = response?.headers.get("retry-after");
    if (retryAfter && /^(?:0|[1-9][0-9]*)$/u.test(retryAfter)) {
      return Math.min(30_000, Number(retryAfter) * 1_000);
    }
    const retryDate = retryAfter ? Date.parse(retryAfter) : Number.NaN;
    if (Number.isFinite(retryDate)) {
      return Math.min(30_000, Math.max(0, retryDate - this.#now()));
    }
    return Math.min(5_000, 250 * 4 ** (attempt - 1));
  }

  #transientNetworkError(error: unknown): boolean {
    return (
      error instanceof TypeError ||
      (error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    );
  }

  async #request<T>(
    method: "GET" | "PATCH" | "POST",
    path: string,
    body?: object,
    allowNotFound = false,
    retryMode: RetryMode =
      method === "GET" || method === "PATCH" ? "retryable" : "none",
  ): Promise<T> {
    const serializedBody =
      body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.#apiUrl}${path}`, {
          body: serializedBody,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.#token}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
            "user-agent": "sandcastle-queue-template",
            "x-github-api-version": "2022-11-28",
          },
          method,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        if (
          retryMode === "none" ||
          attempt === 3 ||
          !this.#transientNetworkError(error)
        ) {
          throw error;
        }
        await this.#sleep(this.#retryDelay(undefined, attempt));
        continue;
      }
      if (allowNotFound && response.status === 404) {
        return null as T;
      }
      const transient =
        response.status === 429 ||
        (response.status >= 500 && response.status <= 599);
      if (transient && retryMode !== "none" && attempt < 3) {
        await response.body?.cancel();
        await this.#sleep(this.#retryDelay(response, attempt));
        continue;
      }
      if (!response.ok) {
        throw new Error(`GitHub ${method} failed with status ${response.status}.`);
      }
      const source = await response.text();
      return (source ? JSON.parse(source) : null) as T;
    }
    throw new Error(`GitHub ${method} retry limit was exhausted.`);
  }

  async addLabel(issue: number, label: string): Promise<void> {
    await this.#request(
      "POST",
      `/repos/${this.#repository}/issues/${issue}/labels`,
      { labels: [label] },
      false,
      "retryable",
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

  async remoteHead(branch: string): Promise<string | null> {
    const response = await this.#request<{ object?: { sha?: string } } | null>(
      "GET",
      `/repos/${this.#repository}/git/ref/heads/${encodeURIComponent(branch)}`,
      undefined,
      true,
    );
    const sha = response?.object?.sha;
    if (sha === undefined) return null;
    if (!/^[0-9a-f]{40}$/u.test(sha)) {
      throw new Error("GitHub returned an invalid branch HEAD.");
    }
    return sha;
  }

  async createIntegrationBranch(branch: string, head: string): Promise<void> {
    await this.#request("POST", `/repos/${this.#repository}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: head,
    });
  }

  async createPublicationMarker(
    issue: number,
    marker: PublicationMarker,
  ): Promise<{ id: number }> {
    const result = await this.#request<{ id?: number }>(
      "POST",
      `/repos/${this.#repository}/issues/${issue}/comments`,
      {
        body: renderPublicationMarker(marker),
      },
    );
    if (!Number.isSafeInteger(result.id) || (result.id ?? 0) <= 0) {
      throw new Error("GitHub omitted the immutable publication marker identity.");
    }
    return { id: result.id! };
  }

  async getCommit(sha: string): Promise<{
    message: string;
    parents: string[];
    sha: string;
  }> {
    const result = await this.#request<{
      commit?: { message?: string };
      parents?: Array<{ sha?: string }>;
      sha?: string;
    }>("GET", `/repos/${this.#repository}/commits/${sha}`);
    if (
      result.sha !== sha ||
      typeof result.commit?.message !== "string" ||
      !Array.isArray(result.parents) ||
      !result.parents.every(({ sha: parent }) =>
        /^[0-9a-f]{40}$/u.test(parent ?? ""),
      )
    ) {
      throw new Error("GitHub returned invalid remote completion history.");
    }
    return {
      message: result.commit.message,
      parents: result.parents.map(({ sha: parent }) => parent!),
      sha,
    };
  }

  async listIssueComments(
    issue: number,
  ): Promise<Array<{ body: string; id: number }>> {
    const comments: Array<{ body: string; id: number }> = [];
    for (let page = 1; ; page += 1) {
      const current = await this.#request<
        Array<{ body?: string; id?: number }>
      >(
        "GET",
        `/repos/${this.#repository}/issues/${issue}/comments?per_page=100&page=${page}`,
      );
      for (const comment of current) {
        if (
          typeof comment.body !== "string" ||
          !Number.isSafeInteger(comment.id) ||
          (comment.id ?? 0) <= 0
        ) {
          throw new Error("GitHub returned an invalid Issue comment.");
        }
        comments.push({ body: comment.body, id: comment.id! });
      }
      if (current.length < 100) return comments;
    }
  }

  async closeIssue(issue: number): Promise<void> {
    const result = await this.#request<{ number?: number; state?: string }>(
      "PATCH",
      `/repos/${this.#repository}/issues/${issue}`,
      { state: "closed" },
    );
    if (result.number !== issue || result.state !== "closed") {
      throw new Error("GitHub did not confirm Ticket closure.");
    }
  }

  async listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]> {
    const [owner] = this.#repository.split("/");
    const result: Array<{
      draft?: boolean;
      html_url?: string;
      node_id?: string;
      number?: number;
      state?: string;
    }> = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        base: input.base,
        head: `${owner}:${input.head}`,
        page: String(page),
        per_page: "100",
        state: "open",
      });
      const current = await this.#request<typeof result>(
        "GET",
        `/repos/${this.#repository}/pulls?${query}`,
      );
      result.push(...current);
      if (current.length < 100) break;
    }
    return result.map((pullRequest) => {
      if (
        typeof pullRequest.draft !== "boolean" ||
        typeof pullRequest.html_url !== "string" ||
        typeof pullRequest.node_id !== "string" ||
        pullRequest.node_id.length === 0 ||
        !Number.isSafeInteger(pullRequest.number) ||
        (pullRequest.number ?? 0) <= 0 ||
        pullRequest.state !== "open"
      ) {
        throw new Error("GitHub returned an invalid Integration pull request.");
      }
      return {
        draft: pullRequest.draft,
        nodeId: pullRequest.node_id,
        number: pullRequest.number!,
        state: pullRequest.state,
        url: pullRequest.html_url,
      };
    });
  }

  async createDraftPullRequest(input: {
    base: string;
    head: string;
    title: string;
  }): Promise<DraftPullRequest> {
    const result = await this.#request<{
      draft?: boolean;
      html_url?: string;
      node_id?: string;
      number?: number;
    }>("POST", `/repos/${this.#repository}/pulls`, {
      base: input.base,
      body: "This draft accumulates fully published Sandcastle Queue Tickets.",
      draft: true,
      head: input.head,
      title: input.title,
    });
    if (
      result.draft !== true ||
      typeof result.html_url !== "string" ||
      typeof result.node_id !== "string" ||
      result.node_id.length === 0 ||
      !Number.isSafeInteger(result.number) ||
      (result.number ?? 0) <= 0
    ) {
      throw new Error("GitHub omitted the created draft pull request identity.");
    }
    return {
      draft: true,
      nodeId: result.node_id,
      number: result.number!,
      url: result.html_url,
    };
  }

  async dispatchContinuation(payload: {
    inputs: {
      expected_head: string;
      operation: "continue";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void> {
    await this.#dispatchQueueWorkflow(payload);
  }

  async dispatchFinalReview(payload: {
    inputs: {
      expected_head: string;
      operation: "final-review";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void> {
    await this.#dispatchQueueWorkflow(payload);
  }

  async dispatchFinalFix(payload: {
    inputs: {
      expected_head: string;
      operation: "final-fix";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void> {
    await this.#dispatchQueueWorkflow(payload);
  }

  async dispatchFinalRereview(payload: {
    inputs: {
      expected_head: string;
      operation: "final-rereview";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void> {
    await this.#dispatchQueueWorkflow(payload);
  }

  async #dispatchQueueWorkflow(payload: {
    inputs: {
      expected_head: string;
      operation:
        | "continue"
        | "final-fix"
        | "final-rereview"
        | "final-review";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void> {
    await this.#request(
      "POST",
      `/repos/${this.#repository}/actions/workflows/sandcastle-queue.yml/dispatches`,
      payload,
      false,
      "retryable",
    );
  }

  async createFinalReviewMarker(
    pullRequest: number,
    marker: FinalReviewMarker,
  ): Promise<{ id: number }> {
    const result = await this.#request<{ id?: number }>(
      "POST",
      `/repos/${this.#repository}/issues/${pullRequest}/comments`,
      { body: renderFinalReviewMarker(marker) },
    );
    if (!Number.isSafeInteger(result.id) || (result.id ?? 0) <= 0) {
      throw new Error("GitHub omitted the immutable Final Review Marker identity.");
    }
    return { id: result.id! };
  }

  async createFinalFixMarker(
    pullRequest: number,
    marker: FinalFixMarker,
  ): Promise<{ id: number }> {
    const result = await this.#request<{ id?: number }>(
      "POST",
      `/repos/${this.#repository}/issues/${pullRequest}/comments`,
      { body: renderFinalFixMarker(marker) },
    );
    if (!Number.isSafeInteger(result.id) || (result.id ?? 0) <= 0) {
      throw new Error("GitHub omitted the immutable Final Fix Marker identity.");
    }
    return { id: result.id! };
  }

  async createFinalRereviewMarker(
    pullRequest: number,
    marker: FinalRereviewMarker,
  ): Promise<{ id: number }> {
    const result = await this.#request<{ id?: number }>(
      "POST",
      `/repos/${this.#repository}/issues/${pullRequest}/comments`,
      { body: renderFinalRereviewMarker(marker) },
    );
    if (!Number.isSafeInteger(result.id) || (result.id ?? 0) <= 0) {
      throw new Error(
        "GitHub omitted the immutable Final Rereview Marker identity.",
      );
    }
    return { id: result.id! };
  }

  async markPullRequestReady(nodeId: string): Promise<void> {
    const result = await this.#request<{
      data?: {
        markPullRequestReadyForReview?: {
          pullRequest?: { id?: string; isDraft?: boolean };
        };
      };
      errors?: unknown[];
    }>("POST", "/graphql", {
      query:
        "mutation MarkReady($pullRequestId: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { id isDraft } } }",
      variables: { pullRequestId: nodeId },
    });
    const pullRequest =
      result.data?.markPullRequestReadyForReview?.pullRequest;
    if (
      (Array.isArray(result.errors) && result.errors.length > 0) ||
      pullRequest?.id !== nodeId ||
      pullRequest.isDraft !== false
    ) {
      throw new Error("GitHub did not confirm the Integration pull request is ready.");
    }
  }
}
