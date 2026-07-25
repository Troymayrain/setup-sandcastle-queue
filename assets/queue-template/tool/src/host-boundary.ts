import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { withoutExecutionCredentials } from "./credential-environment.js";
import type { FinalFixBoundary } from "./final-fix.js";
import type { FinalRereviewBoundary } from "./final-rereview.js";
import type { FinalReviewBoundary } from "./final-review.js";
import type {
  FinalFixMarker,
  FinalRereviewMarker,
  FinalReviewMarker,
} from "./final-review-facts.js";
import { RestGitHubHost } from "./github-host.js";
import type {
  DraftPullRequest,
  IntegrationPullRequest,
} from "./integration-pull-request.js";
import {
  completionMessage,
  type CompletionMetadata,
  type PublicationMarker,
} from "./publication-facts.js";
import type { TicketHostBoundary } from "./processing-run.js";

const executeFile = promisify(execFile);

function gitEnvironment(
  environment: NodeJS.ProcessEnv,
  token?: string,
): NodeJS.ProcessEnv {
  const result = withoutExecutionCredentials(environment);
  result.GIT_CONFIG_COUNT = token ? "1" : "0";
  result.GIT_CONFIG_GLOBAL = "/dev/null";
  result.GIT_CONFIG_NOSYSTEM = "1";
  if (token) {
    result.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    result.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(
      `x-access-token:${token}`,
    ).toString("base64")}`;
  } else {
    delete result.GIT_CONFIG_KEY_0;
    delete result.GIT_CONFIG_VALUE_0;
  }
  result.GIT_NO_REPLACE_OBJECTS = "1";
  result.GIT_PAGER = "cat";
  result.GIT_SSH_COMMAND = "/bin/false";
  result.GIT_TERMINAL_PROMPT = "0";
  return result;
}

async function executeGit(
  repository: string,
  environment: NodeJS.ProcessEnv,
  arguments_: string[],
): Promise<string> {
  try {
    const { stdout } = await executeFile("git", arguments_, {
      cwd: repository,
      encoding: "utf8",
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new Error("A required Host Git operation failed.");
  }
}

export class NodeTicketHost implements TicketHostBoundary, FinalFixBoundary {
  readonly #github: RestGitHubHost;
  readonly #localGitEnvironment: NodeJS.ProcessEnv;
  readonly #networkGitEnvironment: NodeJS.ProcessEnv;
  readonly #repository: string;
  readonly #remoteUrl: string;

  constructor(
    repository: string,
    environment: NodeJS.ProcessEnv,
    github: RestGitHubHost,
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
    this.#localGitEnvironment = gitEnvironment(environment);
    this.#networkGitEnvironment = gitEnvironment(environment, token);
    this.#github = github;
    this.#repository = repository;
    this.#remoteUrl = `https://github.com/${repositoryName}.git`;
  }

  async #git(arguments_: string[], network = false): Promise<string> {
    return executeGit(
      this.#repository,
      network ? this.#networkGitEnvironment : this.#localGitEnvironment,
      arguments_,
    );
  }

  async #assertBranchName(branch: string): Promise<void> {
    await this.#git(["check-ref-format", `refs/heads/${branch}`]);
  }

  async checkoutIntegration(branch: string, head: string): Promise<void> {
    await this.#assertBranchName(branch);
    const remoteRef = `refs/remotes/sandcastle-queue/${branch}`;
    await this.#git(
      [
        "fetch",
        "--no-tags",
        this.#remoteUrl,
        `+refs/heads/${branch}:${remoteRef}`,
      ],
      true,
    );
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

  createFinalFixMarker(
    pullRequest: number,
    marker: FinalFixMarker,
  ): Promise<{ id: number }> {
    return this.#github.createFinalFixMarker(pullRequest, marker);
  }

  dispatchContinuation(payload: {
    inputs: {
      expected_head: string;
      operation: "continue";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void> {
    return this.#github.dispatchContinuation(payload);
  }

  dispatchFinalRereview(payload: {
    inputs: {
      expected_head: string;
      operation: "final-rereview";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void> {
    return this.#github.dispatchFinalRereview(payload);
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

  listIssueComments(
    issue: number,
  ): Promise<Array<{ body: string; id: number }>> {
    return this.#github.listIssueComments(issue);
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
    await this.#git(
      ["push", this.#remoteUrl, `${after}:refs/heads/${branch}`],
      true,
    );
  }

  remoteHead(branch: string): Promise<string | null> {
    return this.#github.remoteHead(branch);
  }

  async runCommand(
    argv: string[],
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<void> {
    const [command, ...arguments_] = argv;
    if (!command) throw new Error("Project command argv cannot be empty.");
    try {
      await executeFile(command, arguments_, {
        cwd: this.#repository,
        encoding: "utf8",
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
        signal,
      });
    } catch {
      throw new Error("A configured project command failed.");
    }
  }
}

export class NodeFinalReviewHost
  implements FinalReviewBoundary, FinalRereviewBoundary
{
  readonly #github: RestGitHubHost;
  readonly #localGitEnvironment: NodeJS.ProcessEnv;
  readonly #networkGitEnvironment: NodeJS.ProcessEnv;
  readonly #repository: string;
  readonly #remoteUrl: string;

  constructor(
    repository: string,
    environment: NodeJS.ProcessEnv,
    github: RestGitHubHost,
    remoteUrl?: string,
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
    this.#github = github;
    this.#localGitEnvironment = gitEnvironment(environment);
    this.#networkGitEnvironment = gitEnvironment(environment, token);
    this.#repository = repository;
    this.#remoteUrl =
      remoteUrl ?? `https://github.com/${repositoryName}.git`;
  }

  async #assertBranchName(branch: string): Promise<void> {
    await executeGit(this.#repository, this.#localGitEnvironment, [
      "check-ref-format",
      `refs/heads/${branch}`,
    ]);
  }

  createFinalReviewMarker(
    pullRequest: number,
    marker: FinalReviewMarker,
  ): Promise<{ id: number }> {
    return this.#github.createFinalReviewMarker(pullRequest, marker);
  }

  createFinalRereviewMarker(
    pullRequest: number,
    marker: FinalRereviewMarker,
  ): Promise<{ id: number }> {
    return this.#github.createFinalRereviewMarker(pullRequest, marker);
  }

  async createTemporaryMerge(input: {
    baseBranch: string;
    expectedIntegrationHead: string;
    integrationBranch: string;
  }): Promise<{
    baseHead: string;
    integrationHead: string;
    path: string;
    remove(): Promise<void>;
    unchanged(): Promise<boolean>;
  }> {
    await Promise.all([
      this.#assertBranchName(input.baseBranch),
      this.#assertBranchName(input.integrationBranch),
    ]);
    const baseRef = "refs/remotes/sandcastle-queue/final-review-base";
    const integrationRef =
      "refs/remotes/sandcastle-queue/final-review-integration";
    await executeGit(this.#repository, this.#networkGitEnvironment, [
      "fetch",
      "--no-tags",
      this.#remoteUrl,
      `+refs/heads/${input.baseBranch}:${baseRef}`,
      `+refs/heads/${input.integrationBranch}:${integrationRef}`,
    ]);
    const [baseHead, integrationHead] = await Promise.all([
      executeGit(this.#repository, this.#localGitEnvironment, [
        "rev-parse",
        "--verify",
        baseRef,
      ]),
      executeGit(this.#repository, this.#localGitEnvironment, [
        "rev-parse",
        "--verify",
        integrationRef,
      ]),
    ]);
    if (integrationHead !== input.expectedIntegrationHead) {
      throw new Error("Fetched Integration Branch changed before Final Review.");
    }

    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "sandcastle-final-review-"),
    );
    const path = join(temporaryRoot, "merge");
    let worktreeAdded = false;
    const remove = async (): Promise<void> => {
      if (worktreeAdded) {
        await executeGit(this.#repository, this.#localGitEnvironment, [
          "worktree",
          "remove",
          "--force",
          path,
        ]);
        worktreeAdded = false;
      }
      await rm(temporaryRoot, { force: true, recursive: true });
    };
    try {
      await executeGit(this.#repository, this.#localGitEnvironment, [
        "worktree",
        "add",
        "--detach",
        path,
        baseHead,
      ]);
      worktreeAdded = true;
      await executeGit(path, this.#localGitEnvironment, [
        "-c",
        "user.name=Sandcastle Queue",
        "-c",
        "user.email=sandcastle-queue@users.noreply.github.com",
        "merge",
        "--no-ff",
        "--no-edit",
        integrationHead,
      ]);
      const mergeHead = await executeGit(path, this.#localGitEnvironment, [
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
      return {
        baseHead,
        integrationHead,
        path,
        remove,
        unchanged: async () => {
          const [head, status] = await Promise.all([
            executeGit(path, this.#localGitEnvironment, [
              "rev-parse",
              "--verify",
              "HEAD",
            ]),
            executeGit(path, this.#localGitEnvironment, [
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
            ]),
          ]);
          return head === mergeHead && status === "";
        },
      };
    } catch {
      await remove();
      throw new Error("The latest base could not be temporarily merged.");
    }
  }

  dispatchContinuation(payload: {
    inputs: {
      expected_head: string;
      operation: "continue";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void> {
    return this.#github.dispatchContinuation(payload);
  }

  dispatchFinalFix(payload: {
    inputs: {
      expected_head: string;
      operation: "final-fix";
      predecessor_run_id: string;
    };
    ref: string;
  }): Promise<void> {
    return this.#github.dispatchFinalFix(payload);
  }

  listIntegrationPullRequests(input: {
    base: string;
    head: string;
  }): Promise<IntegrationPullRequest[]> {
    return this.#github.listIntegrationPullRequests(input);
  }

  listIssueComments(
    issue: number,
  ): Promise<Array<{ body: string; id: number }>> {
    return this.#github.listIssueComments(issue);
  }

  markPullRequestReady(nodeId: string): Promise<void> {
    return this.#github.markPullRequestReady(nodeId);
  }

  remoteHead(branch: string): Promise<string | null> {
    return this.#github.remoteHead(branch);
  }

  async runCommand(
    path: string,
    argv: string[],
    environment: NodeJS.ProcessEnv,
  ): Promise<void> {
    const [command, ...arguments_] = argv;
    if (!command) throw new Error("Project command argv cannot be empty.");
    try {
      await executeFile(command, arguments_, {
        cwd: path,
        encoding: "utf8",
        env: environment,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      throw new Error("A configured project command failed.");
    }
  }

}
