import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { InfrastructureError } from "../config.js";
import { createHostGitEnvironment } from "./environment.js";

function infrastructureError(): InfrastructureError {
  return new InfrastructureError([
    {
      code: "GIT_FAILED",
      message: "Unable to inspect the target Git repository.",
    },
  ]);
}

function git(repository: string, arguments_: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      "git",
      arguments_,
      {
        cwd: repository,
        encoding: "utf8",
        env: createHostGitEnvironment(),
        maxBuffer: 16 * 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error) {
          reject(infrastructureError());
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

export async function resolveRepositoryRoot(repository: string): Promise<string> {
  return (await git(repository, ["rev-parse", "--show-toplevel"])).trim();
}

export async function resolveRepositoryGitPath(
  repository: string,
  relativePath: string,
): Promise<string> {
  const root = await resolveRepositoryRoot(repository);
  const gitPath = (await git(root, ["rev-parse", "--git-path", relativePath])).trim();
  return isAbsolute(gitPath) ? gitPath : resolve(root, gitPath);
}
