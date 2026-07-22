import { createServer } from "node:http";

async function body(request) {
  let source = "";
  for await (const chunk of request) {
    source += chunk;
    if (source.length > 1024 * 1024) {
      throw new Error("request too large");
    }
  }
  return source ? JSON.parse(source) : null;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

export async function startGitHubContractServer() {
  const requests = [];
  const comments = [{ body: "existing", id: 301 }];
  const branches = new Map([["main", "a".repeat(40)]]);
  const commits = [];
  const pullRequests = [];
  const attempts = { rateLimit: 0, transient: 0 };
  const server = createServer(async (request, response) => {
    const requestBody = await body(request).catch(() => null);
    requests.push({ body: requestBody, method: request.method, url: request.url });

    if (request.url === "/repos/acme/widget/issues?state=all&per_page=2&page=1") {
      json(
        response,
        200,
        [
          { id: 101, number: 1, state: "open", title: "Parent" },
          {
            body: "## Parent\n\n#1\n",
            id: 102,
            labels: [{ name: "ready-for-agent" }],
            number: 2,
            state: "open",
            title: "Stale list copy",
          },
        ],
        {
          link: `<http://127.0.0.1:${server.address().port}/repos/acme/widget/issues?state=all&per_page=2&page=2>; rel="next"`,
        },
      );
      return;
    }
    if (request.url === "/repos/acme/widget/issues?state=all&per_page=2&page=2") {
      json(response, 200, [
        {
          body: "## Parent\n\n#1\n",
          id: 103,
          labels: [],
          number: 3,
          state: "closed",
          title: "Second page",
        },
      ]);
      return;
    }
    if (request.url === "/repos/acme/widget/issues/2") {
      json(response, 200, {
        assignees: [],
        body: "## Parent\n\n#1\n",
        id: 102,
        issue_dependencies_summary: { blocked_by: 0 },
        labels: [{ name: "ready-for-agent" }, { name: "sandcastle" }],
        number: 2,
        state: "open",
        title: "Fresh direct read",
      });
      return;
    }
    if (request.url === "/repos/acme/widget/issues/2/dependencies/blocked_by") {
      json(response, 200, [{ id: 900, number: 9, state: "closed" }]);
      return;
    }
    if (request.url === "/repos/acme/widget/issues/2/comments") {
      if (request.method === "POST") {
        const comment = { body: requestBody?.body, id: 302 };
        comments.push(comment);
        json(response, 201, comment);
      } else {
        json(response, 200, comments);
      }
      return;
    }
    if (request.url === "/repos/acme/widget/git/ref/heads/main") {
      json(response, 200, { object: { sha: branches.get("main") }, ref: "refs/heads/main" });
      return;
    }
    if (request.url === "/repos/acme/widget/git/refs/heads/sandcastle%2Factive") {
      if (request.method === "POST") {
        branches.set("sandcastle/active", requestBody?.sha);
        json(response, 201, {
          object: { sha: requestBody?.sha },
          ref: "refs/heads/sandcastle/active",
        });
      } else if (request.method === "PATCH") {
        branches.set("sandcastle/active", requestBody?.sha);
        json(response, 200, {
          object: { sha: requestBody?.sha },
          ref: "refs/heads/sandcastle/active",
        });
      } else {
        json(response, 200, {
          object: { sha: branches.get("sandcastle/active") },
          ref: "refs/heads/sandcastle/active",
        });
      }
      return;
    }
    if (request.url === "/repos/acme/widget/git/commits") {
      const commit = { ...requestBody, sha: "b".repeat(40) };
      commits.push(commit);
      json(response, 201, commit);
      return;
    }
    if (request.url === "/repos/acme/widget/commits?sha=sandcastle%2Factive") {
      json(response, 200, commits);
      return;
    }
    if (request.url === "/repos/acme/widget/pulls") {
      if (request.method === "POST") {
        const pullRequest = {
          ...requestBody,
          draft: true,
          number: 41,
          state: "open",
        };
        pullRequests.push(pullRequest);
        json(response, 201, pullRequest);
      } else {
        json(response, 200, pullRequests);
      }
      return;
    }
    if (request.url === "/repos/acme/widget/pulls/41" && request.method === "PATCH") {
      Object.assign(pullRequests[0], requestBody);
      json(response, 200, pullRequests[0]);
      return;
    }
    if (request.url === "/contract/rate-limit") {
      attempts.rateLimit += 1;
      if (attempts.rateLimit === 1) {
        json(response, 429, { message: "rate limited" }, { "retry-after": "0" });
      } else {
        json(response, 200, { ok: true });
      }
      return;
    }
    if (request.url === "/contract/transient") {
      attempts.transient += 1;
      if (attempts.transient === 1) {
        json(response, 503, { message: "temporarily unavailable" });
      } else {
        json(response, 200, { ok: true });
      }
      return;
    }
    json(response, 404, { message: "Not Found" });
  });
  await listen(server);
  return {
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    attempts,
    close: () => close(server),
    requests,
  };
}

export async function startAnthropicContractServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const requestBody = await body(request).catch(() => null);
    requests.push({
      batch: request.headers["x-sandcastle-batch"],
      body: requestBody,
      model: requestBody?.model,
      session: request.headers["x-sandcastle-session"],
    });
    if (request.url !== "/v1/messages" || request.method !== "POST") {
      json(response, 404, { error: { type: "not_found" } });
      return;
    }
    if (request.headers.authorization !== "Bearer session-token") {
      json(response, 401, { error: { type: "authentication_error" } });
      return;
    }
    if (!["ticket-model", "fast-model"].includes(requestBody?.model)) {
      json(response, 400, { error: { type: "model_not_allowed" } });
      return;
    }
    if (requestBody?.metadata?.scenario === "error") {
      json(response, 529, { error: { type: "overloaded_error" } });
      return;
    }
    if (requestBody?.stream !== true) {
      json(response, 400, { error: { type: "stream_required" } });
      return;
    }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_contract"}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n');
    response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  await listen(server);
  return {
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => close(server),
    requests,
  };
}
