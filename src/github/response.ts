import { InfrastructureError } from "../config.js";

const maximumGitHubResponseBytes = 16 * 1024 * 1024;

function invalidGitHubResponse(): InfrastructureError {
  return new InfrastructureError([
    {
      code: "GITHUB_API_INVALID_RESPONSE",
      message: "GitHub returned a response larger than the supported bound.",
    },
  ]);
}

/** 判断 GitHub REST Link header 是否声明了下一页。 */
export function hasNextGitHubPage(headers: Headers): boolean {
  return /(?:^|,)\s*<[^>]+>\s*;\s*rel="next"/iu.test(
    headers.get("link") ?? "",
  );
}

/** 读取不受信任的 GitHub REST 响应，并在解析前执行统一大小上限。 */
export async function readBoundedGitHubResponseText(
  response: Response,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > maximumGitHubResponseBytes
    ) {
      throw invalidGitHubResponse();
    }
  }
  if (!response.body) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumGitHubResponseBytes) {
      throw invalidGitHubResponse();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
