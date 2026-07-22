import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export type BoundedJsonFileFailure =
  | "invalid-json"
  | "too-large"
  | "unavailable";

export type BoundedJsonFileResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: BoundedJsonFileFailure };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasExactShape(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  const allowed = new Set([...required, ...optional]);
  return (
    isRecord(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

/** Read an untrusted JSON file without following links or buffering past the limit. */
export async function readBoundedJsonFile(
  path: string,
  maximumBytes: number,
): Promise<BoundedJsonFileResult> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("maximumBytes must be a positive safe integer.");
  }

  try {
    const pathMetadata = await lstat(path);
    if (!pathMetadata.isFile() || pathMetadata.size > maximumBytes) {
      return {
        ok: false,
        reason: pathMetadata.size > maximumBytes ? "too-large" : "unavailable",
      };
    }
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  let source: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { ok: false, reason: "unavailable" };
    if (metadata.size > maximumBytes) {
      return { ok: false, reason: "too-large" };
    }

    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maximumBytes + 1 - size),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    if (size > maximumBytes) return { ok: false, reason: "too-large" };
    source = Buffer.concat(chunks, size);
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    await handle.close().catch(() => undefined);
  }

  try {
    return { ok: true, value: JSON.parse(source.toString("utf8")) as unknown };
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
}
