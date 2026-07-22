import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  publishRunAudit,
  type PublishedRunAudit,
  type RunAuditOutcome,
  type RunAuditReviewEvidence,
  type RunAuditTicketEvidence,
} from "../audit/run.js";
import { canonicalJson } from "../canonical-json.js";
import { ConfigurationError, InfrastructureError } from "../config.js";
import { isGitObjectId } from "../git/object-id.js";
import { resolveRepositoryRoot } from "../git/repository.js";
import { sha256 } from "../hash.js";
import { uploadWorkflowArtifact } from "./artifact.js";
import { WorkflowGitHubClient } from "./github.js";

const batchIdPattern = /^p([1-9][0-9]*)-[a-f0-9]{12}-r[1-9][0-9]*$/u;
const imagePattern =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;
const lockfileCandidates = [
  ".mvn/wrapper/maven-wrapper.properties",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "gradle.lockfile",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
];

export interface PublishWorkflowRunAuditOptions {
  batchId: string;
  configPath: string;
  endHead: string;
  environment: NodeJS.ProcessEnv;
  finishedAt: string;
  outcome: RunAuditOutcome;
  predecessorRunId: string | null;
  repositoryPath: string;
  review?: RunAuditReviewEvidence;
  reviewedHead: string | null;
  runtimeImage: string;
  startHead: string;
  startedAt: string;
  tickets: RunAuditTicketEvidence[];
}

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

async function boundedFile(path: string): Promise<Buffer | null> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) {
      throw infrastructureError(
        "AUDIT_DEPENDENCY_INVALID",
        "A dependency identity file exceeds the supported audit bound.",
      );
    }
    const content = await readFile(path);
    if (content.length > 16 * 1024 * 1024) {
      throw infrastructureError(
        "AUDIT_DEPENDENCY_INVALID",
        "A dependency identity file exceeds the supported audit bound.",
      );
    }
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function dependencyHashes(root: string): Promise<{
  lockfile: string;
  runtimeSkills: string;
}> {
  const lockfiles = await Promise.all(
    lockfileCandidates.map(async (path) => {
      const content = await boundedFile(join(root, path));
      return content ? { path, sha256: sha256(content) } : null;
    }),
  );
  const skillsLock = await boundedFile(join(root, "skills-lock.json"));
  return {
    lockfile: sha256(
      canonicalJson(lockfiles.filter((value) => value !== null)),
    ),
    runtimeSkills: sha256(skillsLock ?? Buffer.from("missing-skills-lock\n")),
  };
}

async function targetBaseHead(
  client: WorkflowGitHubClient,
): Promise<string> {
  const metadata = await client.get<{ default_branch?: string }>(
    `/repos/${client.repository}`,
  );
  const defaultBranch = metadata.data?.default_branch;
  if (!defaultBranch) {
    throw infrastructureError(
      "AUDIT_TARGET_BASE_INVALID",
      "GitHub omitted the default branch while publishing the run audit.",
    );
  }
  const reference = await client.get<{ object?: { sha?: string } }>(
    `/repos/${client.repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
  );
  const head = reference.data?.object?.sha;
  if (!isGitObjectId(head)) {
    throw infrastructureError(
      "AUDIT_TARGET_BASE_INVALID",
      "GitHub omitted the default branch HEAD while publishing the run audit.",
    );
  }
  return head as string;
}

/** Publish one immutable, sanitized workflow-host run record and remove its local copy. */
export async function publishWorkflowRunAudit(
  options: PublishWorkflowRunAuditOptions,
): Promise<PublishedRunAudit> {
  const identity = options.batchId.match(batchIdPattern);
  const runId = options.environment.GITHUB_RUN_ID;
  if (
    !identity ||
    !runId ||
    !/^[1-9][0-9]*$/u.test(runId) ||
    !isGitObjectId(options.startHead) ||
    !isGitObjectId(options.endHead) ||
    !imagePattern.test(options.runtimeImage)
  ) {
    throw configurationError(
      "AUDIT_EVIDENCE_INVALID",
      "Workflow run audit requires fixed Batch, run, HEAD, and image identities.",
    );
  }
  const root = await resolveRepositoryRoot(options.repositoryPath);
  const client = new WorkflowGitHubClient(options.environment);
  const [dependencies, targetBase] = await Promise.all([
    dependencyHashes(root),
    targetBaseHead(client),
  ]);
  const temporaryParent = options.environment.RUNNER_TEMP ?? tmpdir();
  await mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = await mkdtemp(join(temporaryParent, "sandcastle-run-audit-"));
  const artifactPath = join(temporaryRoot, "run-audit.json");
  try {
    return await publishRunAudit(
      root,
      options.configPath,
      {
        batch: {
          branch: `sandcastle/${options.batchId}`,
          id: options.batchId,
          parent: Number(identity[1]),
        },
        dependencies,
        heads: {
          end: options.endHead,
          reviewed: options.reviewedHead,
          start: options.startHead,
          targetBase,
        },
        outcome: options.outcome,
        predecessorRunId: options.predecessorRunId,
        runId,
        runtimeImage: options.runtimeImage,
        ...(options.review === undefined ? {} : { review: options.review }),
        schemaVersion: 1,
        tickets: options.tickets,
        timing: {
          finishedAt: options.finishedAt,
          startedAt: options.startedAt,
        },
      },
      artifactPath,
      { uploadArtifact: uploadWorkflowArtifact },
      options.environment,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}
