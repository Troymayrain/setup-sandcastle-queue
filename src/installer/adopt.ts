import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  ConfigurationError,
  InfrastructureError,
  type ProjectConfig,
} from "../config.js";
import { resolveGitHubRepository } from "../github/configure.js";
import { sha256 } from "../hash.js";
import {
  createInstallPlan,
  resolveRepositoryRoot,
  type AdoptionPlanMetadata,
  type AdoptionSkillExtension,
  type InstallPlan,
} from "./plan.js";
import {
  renderCandidateAssets,
  RUNTIME_SKILL_HASHES,
  RUNTIME_WRAPPER_CONTENT,
} from "./templates.js";

const runtimeSkillNames = ["code-review", "implement", "tdd"] as const;
type RuntimeSkillName = (typeof runtimeSkillNames)[number];

export interface LegacyQuiescence {
  activeWorkflowRuns: number[];
  integrationPullRequests: number[];
  optedOutPullRequests: number[];
}

export interface AdoptionMigration {
  action: "move-to-wrapper" | "restore-upstream";
  originalSha256: string;
  skill: RuntimeSkillName;
}

export interface AdoptionPreview {
  migrations: AdoptionMigration[];
  mode: "preview";
  plan: InstallPlan;
  quiescence: LegacyQuiescence;
}

interface GitHubWorkflowRunsResponse {
  total_count?: number;
  workflow_runs?: Array<{ id?: number }>;
}

interface GitHubPullRequest {
  body?: string | null;
  head?: { ref?: string };
  number?: number;
  title?: string;
}

interface SkillFile {
  content: Buffer;
  path: string;
}

function adoptionError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function invalidGitHubResponse(): InfrastructureError {
  return new InfrastructureError([
    {
      code: "GITHUB_API_INVALID_RESPONSE",
      message: "GitHub returned invalid adoption inspection data.",
    },
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function githubGet<T>(
  apiUrl: string,
  token: string,
  path: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/$/u, "")}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
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
        message: "Unable to reach the GitHub API for legacy adoption checks.",
      },
    ]);
  }
  if (response.status !== 200) {
    throw new InfrastructureError([
      {
        code: "GITHUB_API_FAILED",
        message: `GitHub adoption inspection failed with status ${response.status}.`,
      },
    ]);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw invalidGitHubResponse();
  }
}

function parsePullRequestOptOut(value?: string): number[] {
  if (value === undefined) {
    return [];
  }
  const values = value.split(",");
  if (
    values.length === 0 ||
    values.some((entry) => !/^[1-9][0-9]*$/u.test(entry))
  ) {
    throw adoptionError(
      "LEGACY_PR_OPT_OUT_INVALID",
      "Legacy integration PR opt-out must be a comma-separated list of PR numbers.",
    );
  }
  const numbers = values.map(Number);
  if (new Set(numbers).size !== numbers.length) {
    throw adoptionError(
      "LEGACY_PR_OPT_OUT_INVALID",
      "Legacy integration PR opt-out cannot contain duplicate PR numbers.",
    );
  }
  return numbers.sort((left, right) => left - right);
}

export function parseLegacyPullRequestOptOut(value?: string): number[] {
  return parsePullRequestOptOut(value);
}

function isLegacyIntegrationPullRequest(pullRequest: GitHubPullRequest): boolean {
  return /sandcastle/iu.test(
    [
      pullRequest.head?.ref ?? "",
      pullRequest.title ?? "",
      pullRequest.body ?? "",
    ].join("\n"),
  );
}

export async function inspectLegacyQuiescence(
  repositoryPath: string,
  integrationPullRequestOptOut: number[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LegacyQuiescence> {
  const token = environment.GITHUB_TOKEN;
  if (!token) {
    throw adoptionError(
      "GITHUB_TOKEN_MISSING",
      "GITHUB_TOKEN is required to verify that a legacy installation is quiescent.",
    );
  }
  const repository = await resolveGitHubRepository(repositoryPath);
  const apiUrl = environment.GITHUB_API_URL ?? "https://api.github.com";
  const workflowPath = `/repos/${repository}/actions/workflows/sandcastle.yml/runs`;
  const [queued, inProgress, pullRequests] = await Promise.all([
    githubGet<GitHubWorkflowRunsResponse>(
      apiUrl,
      token,
      `${workflowPath}?status=queued&per_page=100&page=1`,
    ),
    githubGet<GitHubWorkflowRunsResponse>(
      apiUrl,
      token,
      `${workflowPath}?status=in_progress&per_page=100&page=1`,
    ),
    githubGet<GitHubPullRequest[]>(
      apiUrl,
      token,
      `/repos/${repository}/pulls?state=open&per_page=100&page=1`,
    ),
  ]);
  if (
    !Array.isArray(queued.workflow_runs) ||
    !Array.isArray(inProgress.workflow_runs) ||
    typeof queued.total_count !== "number" ||
    typeof inProgress.total_count !== "number" ||
    queued.total_count < queued.workflow_runs.length ||
    inProgress.total_count < inProgress.workflow_runs.length ||
    [...queued.workflow_runs, ...inProgress.workflow_runs].some(
      (run) =>
        !isRecord(run) ||
        typeof run.id !== "number" ||
        !Number.isSafeInteger(run.id) ||
        run.id <= 0,
    ) ||
    !Array.isArray(pullRequests) ||
    pullRequests.some(
      (pullRequest) =>
        !isRecord(pullRequest) ||
        typeof pullRequest.number !== "number" ||
        !Number.isSafeInteger(pullRequest.number) ||
        pullRequest.number <= 0 ||
        typeof pullRequest.title !== "string" ||
        (pullRequest.body !== null &&
          pullRequest.body !== undefined &&
          typeof pullRequest.body !== "string") ||
        !isRecord(pullRequest.head) ||
        typeof pullRequest.head.ref !== "string",
    )
  ) {
    throw invalidGitHubResponse();
  }
  const activeWorkflowRuns = [
    ...(queued.workflow_runs ?? []),
    ...(inProgress.workflow_runs ?? []),
  ]
    .flatMap(({ id }) => (typeof id === "number" ? [id] : []))
    .sort((left, right) => left - right);
  if (activeWorkflowRuns.length > 0) {
    throw adoptionError(
      "LEGACY_WORKFLOW_ACTIVE",
      "Legacy adoption requires all queued and running Sandcastle workflows to finish.",
    );
  }

  const integrationPullRequests = pullRequests
    .filter(isLegacyIntegrationPullRequest)
    .flatMap(({ number }) => (typeof number === "number" ? [number] : []))
    .sort((left, right) => left - right);
  if (
    integrationPullRequestOptOut.some(
      (number) => !integrationPullRequests.includes(number),
    )
  ) {
    throw adoptionError(
      "LEGACY_PR_OPT_OUT_INVALID",
      "A confirmed legacy integration PR opt-out does not match an open Sandcastle PR.",
    );
  }
  const unmanagedPullRequests = integrationPullRequests.filter(
    (number) => !integrationPullRequestOptOut.includes(number),
  );
  if (unmanagedPullRequests.length > 0) {
    throw adoptionError(
      "LEGACY_INTEGRATION_PR_OPEN",
      "Legacy integration PRs must be completed or explicitly opted out before adoption.",
    );
  }

  return {
    activeWorkflowRuns,
    integrationPullRequests,
    optedOutPullRequests: [...integrationPullRequestOptOut],
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function collectSkillFiles(
  root: string,
  current: string = root,
  files: SkillFile[] = [],
): Promise<SkillFile[]> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectSkillFiles(root, absolute, files);
    } else if (entry.isFile()) {
      files.push({
        content: await readFile(absolute),
        path: relative(root, absolute).split("\\").join("/"),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function hashSkillFiles(files: SkillFile[]): string {
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(Buffer.from(file.path), file.content);
  }
  return sha256(Buffer.concat(chunks));
}

function addedLines(before: string, after: string): string[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lengths = Array.from(
    { length: beforeLines.length + 1 },
    () => new Uint32Array(afterLines.length + 1),
  );
  for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
    for (let right = afterLines.length - 1; right >= 0; right -= 1) {
      lengths[left]![right] =
        beforeLines[left] === afterLines[right]
          ? 1 + lengths[left + 1]![right + 1]!
          : Math.max(lengths[left + 1]![right]!, lengths[left]![right + 1]!);
    }
  }
  const additions: string[] = [];
  let left = 0;
  let right = 0;
  while (right < afterLines.length) {
    if (
      left < beforeLines.length &&
      beforeLines[left] === afterLines[right]
    ) {
      left += 1;
      right += 1;
    } else if (
      left < beforeLines.length &&
      lengths[left + 1]![right]! >= lengths[left]![right + 1]!
    ) {
      left += 1;
    } else {
      additions.push(afterLines[right] ?? "");
      right += 1;
    }
  }
  return additions;
}

async function detectSkillExtensions(
  root: string,
  config: ProjectConfig,
): Promise<AdoptionSkillExtension[]> {
  const expectedAssets = renderCandidateAssets(config);
  const extensions: AdoptionSkillExtension[] = [];
  for (const skill of runtimeSkillNames) {
    const skillRoot = join(root, ".agents", "skills", skill);
    if (!(await pathExists(skillRoot))) {
      continue;
    }
    const currentFiles = await collectSkillFiles(skillRoot);
    const currentHash = hashSkillFiles(currentFiles);
    if (currentHash === RUNTIME_SKILL_HASHES[skill]) {
      continue;
    }
    const expectedPrefix = `.agents/skills/${skill}/`;
    const expectedFiles = new Map(
      expectedAssets
        .filter(({ path }) => path.startsWith(expectedPrefix))
        .map(({ content, path }) => [path.slice(expectedPrefix.length), content]),
    );
    const migratedSections: string[] = [];
    for (const current of currentFiles) {
      const expected = expectedFiles.get(current.path) ?? "";
      if (current.content.equals(Buffer.from(expected))) {
        continue;
      }
      const additions = addedLines(expected, current.content.toString("utf8"));
      if (additions.some((line) => line.length > 0)) {
        migratedSections.push(
          `#### ${current.path}\n\n${additions.join("\n").trim()}\n`,
        );
      }
    }
    const content = migratedSections.join("\n").trim();
    if (content && !/sandcastle/iu.test(content)) {
      throw adoptionError(
        "LEGACY_SKILL_PATCH_UNCLASSIFIED",
        `The locally patched ${skill} skill contains changes that are not identifiable as Sandcastle extensions.`,
      );
    }
    extensions.push({ content, originalSha256: currentHash, skill });
  }
  return extensions;
}

function adoptedRuntimeWrapper(extensions: AdoptionSkillExtension[]): string {
  const migrated = extensions.filter(({ content }) => content.length > 0);
  if (migrated.length === 0) {
    return RUNTIME_WRAPPER_CONTENT;
  }
  const sections = migrated
    .map(({ content, skill }) => `### ${skill}\n\n${content}`)
    .join("\n\n");
  return `${RUNTIME_WRAPPER_CONTENT.trimEnd()}\n\n## Adopted legacy Sandcastle extensions\n\n${sections}\n`;
}

export async function createAdoptionPreview(
  repository: string,
  config: ProjectConfig,
  integrationPullRequestOptOut: number[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AdoptionPreview> {
  const root = await resolveRepositoryRoot(repository);
  const quiescence = await inspectLegacyQuiescence(
    root,
    integrationPullRequestOptOut,
    environment,
  );
  const skillExtensions = await detectSkillExtensions(root, config);
  const adoption: AdoptionPlanMetadata = {
    integrationPullRequestOptOut: [...integrationPullRequestOptOut],
    runtimeWrapper: adoptedRuntimeWrapper(skillExtensions),
    schemaVersion: 1,
    skillExtensions,
  };
  const plan = await createInstallPlan(root, config, { adoption });
  if (plan.installationState === "fresh") {
    throw adoptionError(
      "LEGACY_INSTALLATION_NOT_FOUND",
      "No unmanaged Sandcastle assets were found to adopt.",
    );
  }
  if (plan.installationState === "managed") {
    throw adoptionError(
      "INSTALLATION_ALREADY_MANAGED",
      "The repository already has managed Sandcastle installation state.",
    );
  }
  return {
    migrations: skillExtensions.map(({ content, originalSha256, skill }) => ({
      action: content ? "move-to-wrapper" : "restore-upstream",
      originalSha256,
      skill,
    })),
    mode: "preview",
    plan,
    quiescence,
  };
}
