import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, connect, isIP } from "node:net";

import { ConfigurationError, isExactNetworkHost } from "../config.js";

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.175.48.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export function isPublicNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 6 && /^::ffff:/iu.test(address)) return false;
  return (
    (family === 4 && !blockedAddresses.check(address, "ipv4")) ||
    (family === 6 && !blockedAddresses.check(address, "ipv6"))
  );
}

async function resolvePublicAddress(
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicNetworkAddress(address))
  ) {
    throw configurationError(
      "SANDBOX_EGRESS_ADDRESS_FORBIDDEN",
      "An allowed egress host resolved to a non-public network address.",
    );
  }
  return addresses[0] as { address: string; family: 4 | 6 };
}

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

async function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  allowlist: Set<string>,
): Promise<void> {
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
  let resolved: { address: string; family: 4 | 6 };
  try {
    resolved = await resolvePublicAddress(target.hostname);
  } catch {
    deny(response);
    return;
  }
  const upstream = httpRequest({
    family: resolved.family,
    headers: { ...safeHeaders(request), host: target.host },
    host: resolved.address,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    port: 80,
  }, (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => deny(response, 502));
  request.pipe(upstream);
}

export async function runEgressProxyProcess(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const allowlist = readAllowlist(environment);
  const server = createServer((request, response) => {
    void proxyHttpRequest(request, response, allowlist);
  });
  server.on("connect", async (request, clientSocket, head) => {
    const match = request.url?.match(/^([^:]+):(\d+)$/u);
    const hostname = match?.[1] ?? "";
    const port = Number(match?.[2] ?? 0);
    if (!allowlist.has(hostname) || port !== 443) {
      clientSocket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    let resolved: { address: string; family: 4 | 6 };
    try {
      resolved = await resolvePublicAddress(hostname);
    } catch {
      clientSocket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    const upstream = connect({
      family: resolved.family,
      host: resolved.address,
      port,
    }, () => {
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
