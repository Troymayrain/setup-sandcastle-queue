import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { ConfigurationError } from "../config.js";

function pathError(code: string, message: string, path: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path }]);
}

export function resolveSafeRepositoryTarget(
  repositoryRoot: string,
  assetPath: string,
): string {
  const target = join(repositoryRoot, assetPath);
  const fromRoot = relative(repositoryRoot, target);
  if (
    assetPath.length === 0 ||
    isAbsolute(assetPath) ||
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw pathError(
      "INSTALL_PATH_OUTSIDE_REPOSITORY",
      "A managed installation path must remain inside the repository.",
      assetPath,
    );
  }
  return target;
}

export async function assertSafeRepositoryParents(
  repositoryRoot: string,
  assetPath: string,
): Promise<string> {
  const target = resolveSafeRepositoryTarget(repositoryRoot, assetPath);
  const relativeParent = relative(repositoryRoot, dirname(target));
  if (!relativeParent) return target;

  let cursor = repositoryRoot;
  for (const segment of relativeParent.split(sep)) {
    cursor = join(cursor, segment);
    let metadata;
    try {
      metadata = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return target;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw pathError(
        "INSTALL_PATH_SYMLINK_FORBIDDEN",
        "Managed installation paths cannot traverse a symbolic-link parent.",
        assetPath,
      );
    }
    if (!metadata.isDirectory()) {
      throw pathError(
        "INSTALL_PATH_PARENT_INVALID",
        "Managed installation path parents must be directories.",
        assetPath,
      );
    }
  }
  return target;
}
