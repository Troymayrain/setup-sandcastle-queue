import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  claudeCode,
  run,
  type RunOptions,
  type RunResult,
} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

export type WorkUnitRole =
  | "ticket"
  | "final-review"
  | "final-fix"
  | "final-rereview";

interface RunResultLike {
  branch: string;
  commits: Array<{ sha: string }>;
  iterations: Array<{ sessionId?: string }>;
  preservedWorktreePath?: string;
  stdout: string;
}

export interface SandcastleBoundary {
  claudeCode: (
    model: string,
    options: {
      captureSessions: true;
      env: Record<string, string>;
      permissionMode?: "plan";
    },
  ) => unknown;
  docker: (options: {
    env: Record<string, string>;
    imageName: string;
  }) => unknown;
  run: (options: Record<string, unknown>) => Promise<RunResultLike>;
}

export interface WorkUnitOptions {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  model: string;
  promptFile: string;
  role: WorkUnitRole;
  signal?: AbortSignal;
}

export interface WorkUnitResult {
  branch: string;
  commits: string[];
  preservedWorktreePath?: string;
  role: WorkUnitRole;
  sessionId: string;
  status: "complete";
  streamSummary: RawStreamSummary;
  verdict?: "needs-fix" | "pass";
}

export interface RawStreamSummary {
  jsonLines: number;
  lineCount: number;
  textLines: number;
}

const realBoundary: SandcastleBoundary = {
  claudeCode: (model, options) => claudeCode(model, options),
  docker: (options) => docker(options),
  run: (options) => run(options as unknown as RunOptions) as Promise<RunResult>,
};

function providerEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const token = environment.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = environment.ANTHROPIC_BASE_URL;
  if (!token || !baseUrl) {
    throw new Error(
      "ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL are required at the Agent execution boundary.",
    );
  }
  return {
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: baseUrl,
  };
}

function sessionId(result: RunResultLike): string {
  const ids = result.iterations
    .map((iteration) => iteration.sessionId)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (ids.length !== 1) {
    throw new Error("A work unit must produce exactly one fresh Agent session.");
  }
  return ids[0]!;
}

export function parseRawAgentStream(source: string): RawStreamSummary {
  const lines = source.split(/\r?\n/u).filter((line) => line.length > 0);
  let jsonLines = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
      jsonLines += 1;
    } catch {
      // Sandcastle file logging can interleave typed text with raw JSON lines.
    }
  }
  return {
    jsonLines,
    lineCount: lines.length,
    textLines: lines.length - jsonLines,
  };
}

export async function executeWorkUnit(
  options: WorkUnitOptions,
  boundary: SandcastleBoundary = realBoundary,
): Promise<WorkUnitResult> {
  const temporary = await mkdtemp(join(tmpdir(), "sandcastle-agent-stream-"));
  const rawStreamPath = join(temporary, "agent-stream.log");
  const handle = await open(rawStreamPath, "wx", 0o600);
  await handle.close();

  try {
    const reviewRole =
      options.role === "final-review" || options.role === "final-rereview";
    let result: RunResultLike;
    try {
      result = await boundary.run({
      agent: boundary.claudeCode(options.model, {
        captureSessions: true,
        env: providerEnvironment(options.environment),
        ...(reviewRole ? { permissionMode: "plan" as const } : {}),
      }),
      branchStrategy: { type: "merge-to-head" },
      cwd: resolve(options.cwd),
      logging: { path: rawStreamPath, type: "file", verbose: true },
      maxIterations: 1,
      name: `queue-${options.role}`,
      promptFile: resolve(options.promptFile),
      sandbox: boundary.docker({
        env: {},
        imageName: "sandcastle-queue-template:local",
      }),
      signal: options.signal,
      });
    } catch (error) {
      parseRawAgentStream(await readFile(rawStreamPath, "utf8"));
      throw error;
    }

    const streamSummary = parseRawAgentStream(
      await readFile(rawStreamPath, "utf8"),
    );
    const candidateVerdict = reviewRole ? result.stdout.trim() : undefined;
    if (
      reviewRole &&
      candidateVerdict !== "pass" &&
      candidateVerdict !== "needs-fix"
    ) {
      throw new Error("Final Review verdict must be exactly pass or needs-fix.");
    }
    const verdict =
      candidateVerdict === "pass" || candidateVerdict === "needs-fix"
        ? candidateVerdict
        : undefined;
    return {
      branch: result.branch,
      commits: result.commits.map(({ sha }) => sha),
      ...(result.preservedWorktreePath
        ? { preservedWorktreePath: result.preservedWorktreePath }
        : {}),
      role: options.role,
      sessionId: sessionId(result),
      status: "complete",
      streamSummary,
      ...(reviewRole ? { verdict } : {}),
    };
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}
