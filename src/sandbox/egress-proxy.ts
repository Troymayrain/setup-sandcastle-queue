import { request as httpRequest } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";

import { ConfigurationError, isExactNetworkHost } from "../config.js";

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function readAllowlist(environment: NodeJS.ProcessEnv): Set<string> {
  const source = environment.SANDCASTLE_EGRESS_ALLOWLIST ?? "";
  const hosts = source ? source.split(",") : [];
  if (
    hosts.some((host) => !isExactNetworkHost(host)) ||
    new Set(hosts).size !== hosts.length
  ) {
    throw configurationError(
      "SANDBOX_HOST_INVALID",
      "Egress proxy allowlist must contain unique exact public DNS host names.",
    );
  }
  return new Set(hosts);
}

function deny(response: ServerResponse, status = 403): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end('{"code":"SANDBOX_EGRESS_DENIED"}\n');
}

function safeHeaders(request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  const blocked = new Set([
    "connection",
    "host",
    "proxy-authorization",
    "proxy-connection",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [name, value] of Object.entries(request.headers)) {
    if (!blocked.has(name) && value !== undefined) {
      headers[name] = value;
    }
  }
  return headers;
}

function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  allowlist: Set<string>,
): void {
  let target: URL;
  try {
    target = new URL(request.url ?? "");
  } catch {
    deny(response, 400);
    return;
  }
  if (
    target.protocol !== "http:" ||
    target.port && target.port !== "80" ||
    !allowlist.has(target.hostname)
  ) {
    deny(response);
    return;
  }
  const upstream = httpRequest(
    target,
    {
      headers: { ...safeHeaders(request), host: target.host },
      method: request.method,
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => deny(response, 502));
  request.pipe(upstream);
}

export async function runEgressProxyProcess(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const allowlist = readAllowlist(environment);
  const server = createServer((request, response) => {
    proxyHttpRequest(request, response, allowlist);
  });
  server.on("connect", (request, clientSocket, head) => {
    const match = request.url?.match(/^([^:]+):(\d+)$/u);
    const hostname = match?.[1] ?? "";
    const port = Number(match?.[2] ?? 0);
    if (!allowlist.has(hostname) || port !== 443) {
      clientSocket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    const upstream = connect(port, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      clientSocket.destroy();
    });
  });
  const portSource = environment.SANDCASTLE_EGRESS_PORT ?? "8080";
  if (!/^[1-9][0-9]{0,4}$/u.test(portSource) || Number(portSource) > 65_535) {
    throw configurationError(
      "SANDBOX_PROXY_PORT_INVALID",
      "SANDCASTLE_EGRESS_PORT must be a valid non-zero TCP port.",
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(portSource), "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write(
    `${JSON.stringify({ event: "ready", hostCount: allowlist.size })}\n`,
  );
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
