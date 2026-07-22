import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}

async function startProviderServer(providerSecret) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const parsedBody = JSON.parse(body);
    requests.push({
      authorization: request.headers.authorization,
      body,
      method: request.method,
      url: request.url,
      xApiKey: request.headers["x-api-key"],
    });
    if (parsedBody.model === "stream-model") {
      response.setHeader("content-type", "text/event-stream");
      response.write(
        `event: message_start\ndata: ${JSON.stringify({
          message: { usage: { input_tokens: 2 } },
          type: "message_start",
        })}\n\n`,
      );
      response.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          delta: { text: "stream-private-response", type: "text_delta" },
          type: "content_block_delta",
        })}\n\n`,
      );
      response.end(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 7 },
        })}\n\n`,
      );
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        content: [{ text: "provider-private-response", type: "text" }],
        model: parsedBody.model,
        usage: { input_tokens: 3, output_tokens: 5 },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    providerSecret,
    requests,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function startBroker(environment) {
  const child = spawn(process.execPath, [cliPath.pathname, "broker"], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const messages = [];
  const waiters = [];
  let stdout = "";
  let stderr = "";
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      const waiterIndex = waiters.findIndex((waiter) => waiter.match(message));
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  function next(match, timeoutMs = 5_000) {
    const index = messages.findIndex(match);
    if (index >= 0) {
      return Promise.resolve(messages.splice(index, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiters.push(waiter);
      const timeout = setTimeout(() => {
        const pendingIndex = waiters.indexOf(waiter);
        if (pendingIndex >= 0) {
          waiters.splice(pendingIndex, 1);
        }
        reject(new Error(`Timed out waiting for broker message; stderr=${stderr}`));
      }, timeoutMs);
      waiter.resolve = (message) => {
        clearTimeout(timeout);
        resolve(message);
      };
    });
  }

  let sequence = 0;
  async function command(command) {
    sequence += 1;
    const id = String(sequence);
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    return next((message) => message.id === id);
  }

  return {
    child,
    command,
    next,
    output: () => ({ stderr, stdout }),
  };
}

function messageRequest(session, { batch = "batch-a", model = "ticket-model", scope = "ticket:2" } = {}) {
  const baseUrl = new URL(session.baseUrl);
  const segments = baseUrl.pathname.split("/");
  segments[2] = encodeURIComponent(batch);
  segments[4] = encodeURIComponent(scope);
  baseUrl.pathname = `${segments.join("/")}/v1/messages`;
  return fetch(baseUrl, {
    body: JSON.stringify({
      max_tokens: 16,
      messages: [{ content: "sandbox-private-prompt", role: "user" }],
      model,
    }),
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

test("broker scopes short-lived session credentials without recording payloads", async () => {
  const providerSecret = "provider-secret-must-never-leak";
  const provider = await startProviderServer(providerSecret);
  const broker = startBroker({
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: providerSecret,
    ANTHROPIC_BASE_URL: provider.url,
  });
  try {
    const ready = await broker.next((message) => message.event === "ready");
    assert.match(ready.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);

    const first = await broker.command({
      batchId: "batch-a",
      command: "create-session",
      models: ["ticket-model", "stream-model"],
      scope: "ticket:2",
      ttlSeconds: 60,
    });
    const second = await broker.command({
      batchId: "batch-a",
      command: "create-session",
      models: ["ticket-model"],
      scope: "ticket:3",
      ttlSeconds: 60,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.result.token === second.result.token, false);
    assert.equal(first.result.baseUrl.includes("batch-a"), true);
    assert.equal(first.result.baseUrl.includes("ticket%3A2"), true);

    const allowed = await messageRequest(first.result);
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).content[0].text, "provider-private-response");
    assert.equal(provider.requests.length, 1);
    assert.equal(
      provider.requests[0].authorization === `Bearer ${providerSecret}`,
      true,
    );
    assert.equal(provider.requests[0].xApiKey === providerSecret, true);
    assert.equal(provider.requests[0].body.includes(first.result.token), false);

    const streamed = await messageRequest(first.result, { model: "stream-model" });
    assert.equal(streamed.status, 200);
    const streamBody = await streamed.text();
    assert.match(streamBody, /stream-private-response/u);
    assert.match(streamBody, /"output_tokens":7/u);

    const wrongBatch = await messageRequest(first.result, { batch: "batch-b" });
    assert.equal(wrongBatch.status, 403);
    assert.equal((await wrongBatch.json()).code, "BROKER_BATCH_MISMATCH");
    const wrongScope = await messageRequest(first.result, { scope: "ticket:3" });
    assert.equal(wrongScope.status, 403);
    assert.equal((await wrongScope.json()).code, "BROKER_SCOPE_MISMATCH");
    const wrongModel = await messageRequest(first.result, { model: "unapproved-model" });
    assert.equal(wrongModel.status, 403);
    assert.equal((await wrongModel.json()).code, "BROKER_MODEL_NOT_ALLOWED");
    assert.equal(provider.requests.length, 2);

    const revoked = await broker.command({
      command: "revoke-session",
      token: first.result.token,
    });
    assert.equal(revoked.ok, true);
    const afterRevocation = await messageRequest(first.result);
    assert.equal(afterRevocation.status, 401);
    assert.equal((await afterRevocation.json()).code, "BROKER_TOKEN_REVOKED");

    const expiring = await broker.command({
      batchId: "batch-a",
      command: "create-session",
      models: ["ticket-model"],
      scope: "ticket:4",
      ttlSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const expired = await messageRequest(expiring.result, { scope: "ticket:4" });
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).code, "BROKER_TOKEN_EXPIRED");

    const audit = await broker.command({ command: "read-audit" });
    assert.equal(audit.ok, true);
    assert.equal(audit.result.length, 7);
    for (const event of audit.result) {
      assert.deepEqual(Object.keys(event).sort(), [
        "latencyMs",
        "model",
        "status",
        "timestamp",
        "usage",
      ]);
    }
    assert.deepEqual(audit.result[0].usage, {
      inputTokens: 3,
      outputTokens: 5,
    });
    assert.deepEqual(audit.result[1].usage, {
      inputTokens: 2,
      outputTokens: 7,
    });
    const auditJson = JSON.stringify(audit.result);
    for (const sensitive of [
      providerSecret,
      first.result.token,
      second.result.token,
      "sandbox-private-prompt",
      "provider-private-response",
      "stream-private-response",
    ]) {
      assert.equal(auditJson.includes(sensitive), false);
    }

    const stopped = await broker.command({ command: "shutdown" });
    assert.equal(stopped.ok, true);
    await new Promise((resolve, reject) => {
      broker.child.once("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`broker exited with ${code}`));
        }
      });
    });
    const output = broker.output();
    assert.equal(output.stderr, "");
    assert.equal(output.stdout.includes(providerSecret), false);
    assert.equal(broker.child.spawnargs.includes(providerSecret), false);
  } finally {
    if (broker.child.exitCode === null) {
      broker.child.kill("SIGTERM");
    }
    await provider.close();
  }
});
