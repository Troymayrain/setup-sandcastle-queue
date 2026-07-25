import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { withoutExecutionCredentials } from "./credential-environment.js";
import { RestFrontierGitHub } from "./github-frontier.js";
import {
  completionMessage,
  type CompletionMetadata,
  type PublicationMarker,
} from "./publication-facts.js";
import type {
  DraftPullRequest,
  IntegrationPullRequest,
  TicketHostBoundary,
} from "./processing-run.js";

const executeFile = promisify(execFile);

export class NodeTicketHost implements TicketHostBoundary {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #github: RestFrontierGitHub;
  readonly #repository: string;
  readonly #remoteUrl: string;

  constructor(
    repository: string,
    environment: NodeJS.ProcessEnv,
    github: RestFrontierGitHub,
  ) {
    const repositoryName = environment.GITHUB_REPOSITORY;
    const token = environment.GITHUB_TOKEN;
    if (
      !repositoryName ||
      !token ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repositoryName)
    ) {
      throw new Error("Host GitHub environment is incomplete.");
    }
    this.#environment = this.#gitEnvironment(environment, token);
    this.#github = github;
    this.#repository = repository;
    this.#remoteUrl = `https://github.com/${repositoryName}.git`;
  }

  #gitEnvironment(
    environment: NodeJS.ProcessEnv,
    token: string,
  ): NodeJS.ProcessEnv {
    const result = withoutExecutionCredentials(environment);
    result.GIT_CONFIG_COUNT = "1";
    result.GIT_CONFIG_GLOBAL = "/dev/null";
    result.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    result.GIT_CONFIG_NOSYSTEM = "1";
    result.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(
      `x-access-token:${token}`,
    ).toString("base64")}`;
    result.GIT_NO_REPLACE_OBJECTS = "1";
    result.GIT_PAGER = "cat";
    result.GIT_TERMINAL_PROMPT = "0";
    return result;
  }

  async #git(arguments_: string[]): Promise<string> {
    try {
      const { stdout } = await executeFile("git", arguments_, {
        cwd: this.#repository,
        encoding: "utf8",
        env: this.#environment,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout.trim();
    } catch {
      throw new Error("A required Host Git operation failed.");
    }
  }

  async #assertBranchName(branch: string): Promise<void> {
    await this.#git(["check-ref-format", `refs/heads/${branch}`]);
  }

  async checkoutIntegration(branch: string, head: string): Promise<void> {
    await this.#assertBranchName(branch);
    const remoteRef = `refs/remotes/sandcastle-queue/${branch}`;
    await this.#git([
      "fetch",
      "--no-tags",
      this.#remoteUrl,
      `+refs/heads/${branch}:${remoteRef}`,
    ]);
    if ((await this.#git(["rev-parse", "--verify", remoteRef])) !== head) {
      throw new Error("Fetched Integration Branch does not match the verified remote HEAD.");
    }
    await this.#git(["checkout", "-B", branch, head]);
  }

  async annotateCompletionCommit(
    metadata: CompletionMetadata,
  ): Promise<string> {
    const original = await this.#git(["log", "-1", "--format=%B", "HEAD"]);
    const message = completionMessage(original, metadata);
    await this.#git([
      "-c",
      "user.name=Sandcastle Queue",
      "-c",
      "user.email=sandcastle-queue@users.noreply.github.com",
      "commit",
      "--amend",
      "--no-gpg-sign",
      "-m",
      message,
    ]);
    return this.localHead();
  }

  closeIssue(issue: number): Promise<void> {
    return this.#github.closeIssue(issue);
  }

  async commitParents(commit: string): Promise<string[]> {
    const parents = await this.#git(["show", "--no-patch", "--format=%P", commit]);
    return parents ? parents.split(/\s+/u) : [];
  }

  createDraftPullRequest(input: {
    base: string;
    head: string;
    title: string;
  }): Promise<DraftPullRequest> {
    return this.#github.createDraftPullRequest(input);
  }

  async createIntegrationBranch(branch: string, head: string): Promise<void> {
    await this.#assertBranchName(branch);
    await this.#github.createIntegrationBranch(branch, head);
  }

  createPublicationMarker(
    issue: number,
    marker: PublicationMarker,
  ): Promise<{ id: number }> {
    return this.#github.createPublicationMarker(issue, marker);
  }

  async isClean(): Promise<boolean> {
    return (await this.#git(["status", "--porcelain=v1", "--untracked-files=all"])) === "";
  }

  listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]> {
    return this.#github.listIntegrationPullRequests(input);
  }

  localHead(): Promise<string> {
    return this.#git(["rev-parse", "--verify", "HEAD"]);
  }

  async pushIntegration(
    branch: string,
    before: string,
    after: string,
  ): Promise<void> {
    await this.#assertBranchName(branch);
    if ((await this.localHead()) !== after) {
      throw new Error("Local HEAD changed before publication.");
    }
    const parents = await this.commitParents(after);
    if (parents.length !== 1 || parents[0] !== before) {
      throw new Error("Completion history changed before publication.");
    }
    await this.#git([
      "push",
      this.#remoteUrl,
      `${after}:refs/heads/${branch}`,
    ]);
  }

  remoteHead(branch: string): Promise<string | null> {
    return this.#github.remoteHead(branch);
  }

  async runCommand(
    argv: string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<void> {
    const [command, ...arguments_] = argv;
    if (!command) throw new Error("Project command argv cannot be empty.");
    try {
      await executeFile(command, arguments_, {
        cwd: this.#repository,
        encoding: "utf8",
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      throw new Error("A configured project command failed.");
    }
  }
}
