import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);

function config() {
  return {
    schemaVersion: 1,
    repository: {
      baseBranch: "main",
      integrationBranch: "sandcastle/integration",
    },
    queue: {
      ownershipLabel: "sandcastle",
      readyLabel: "ready-for-agent",
    },
    runner: { runsOn: "ubuntu-latest" },
    commands: {
      bootstrap: [],
      test: [{ argv: ["npm", "test"] }],
      verification: [],
    },
    models: {
      ticket: "ticket-model",
      finalReview: "review-model",
      finalFix: "fix-model",
    },
    execution: { hostFinalizationReserveMinutes: 15 },
  };
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "sandcastle-mvp-github-"));
  execFileSync("git", ["init", "--quiet", root]);
  writeFileSync(join(root, "README.md"), "# fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Sandcastle Test",
    "-c",
    "user.email=sandcastle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const configPath = join(root, "queue-config.json");
  writeFileSync(configPath, `${JSON.stringify(config(), null, 2)}\n`);
  return { configPath, root };
}

function runAsync(root, args, input, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath.pathname, ...args], {
      cwd: root,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr, stdout }));
    child.stdin.end(input);
  });
}

async function fakeGitHub({ createSecretAfterPreview = false } = {}) {
  const requests = [];
  const state = {
    labels: [{ name: "READY-FOR-AGENT" }],
    secret: false,
    variable: false,
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ body, method: request.method, url: request.url });
    const send = (status, value) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(value === undefined ? "" : JSON.stringify(value));
    };
    if (request.method === "GET" && request.url?.includes("/labels?")) {
      send(200, state.labels);
    } else if (
      request.method === "GET" &&
      request.url?.endsWith("/actions/secrets/ANTHROPIC_AUTH_TOKEN")
    ) {
      send(state.secret ? 200 : 404, state.secret ? { name: "ANTHROPIC_AUTH_TOKEN" } : undefined);
    } else if (
      request.method === "GET" &&
      request.url?.endsWith("/actions/variables/ANTHROPIC_BASE_URL")
    ) {
      send(state.variable ? 200 : 404, state.variable ? { name: "ANTHROPIC_BASE_URL" } : undefined);
      if (createSecretAfterPreview) state.secret = true;
    } else if (
      request.method === "GET" &&
      request.url?.endsWith("/actions/secrets/public-key")
    ) {
      send(200, { key: Buffer.alloc(32, 7).toString("base64"), key_id: "key-1" });
    } else if (request.method === "POST" && request.url?.endsWith("/labels")) {
      state.labels.push({ name: JSON.parse(body).name });
      send(201, JSON.parse(body));
    } else if (
      request.method === "PUT" &&
      request.url?.endsWith("/actions/secrets/ANTHROPIC_AUTH_TOKEN")
    ) {
      state.secret = true;
      send(201, {});
    } else if (
      request.method === "POST" &&
      request.url?.endsWith("/actions/variables")
    ) {
      state.variable = true;
      send(201, {});
    } else if (
      request.method === "PATCH"
    ) {
      send(500, { message: "variables must not be rewritten" });
    } else {
      send(500, { message: "unexpected request" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    requests,
    state,
  };
}

test("init separately confirms and configures only the four allowed GitHub resources", async () => {
  const fixture = repository();
  const github = await fakeGitHub();
  const secret = "provider-secret-must-never-print";
  const environment = {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_BASE_URL: "https://provider.example",
    GITHUB_API_URL: github.apiUrl,
    GITHUB_REPOSITORY: "acme/widget",
    GITHUB_TOKEN: "github-token",
  };
  try {
    const result = await runAsync(
      fixture.root,
      ["init", "--config", fixture.configPath],
      "yes\nyes\n",
      environment,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(secret), false);
    assert.deepEqual(
      github.requests.filter(({ method }) => method !== "GET").map(({ method, url }) => [method, url]),
      [
        ["POST", "/repos/acme/widget/labels"],
        ["PUT", "/repos/acme/widget/actions/secrets/ANTHROPIC_AUTH_TOKEN"],
        ["POST", "/repos/acme/widget/actions/variables"],
      ],
    );
    assert.equal(github.requests.some(({ body }) => body.includes(secret)), false);

    github.requests.length = 0;
    const preserved = await runAsync(
      fixture.root,
      ["init", "--config", fixture.configPath],
      "yes\n\n",
      environment,
    );
    assert.equal(preserved.status, 0, preserved.stderr);
    assert.equal(
      github.requests.some(
        ({ method, url }) =>
          method === "PUT" &&
          url?.endsWith("/actions/secrets/ANTHROPIC_AUTH_TOKEN"),
      ),
      false,
    );

    github.requests.length = 0;
    const overwritten = await runAsync(
      fixture.root,
      ["init", "--config", fixture.configPath],
      "yes\noverwrite-secret\n",
      environment,
    );
    assert.equal(overwritten.status, 0, overwritten.stderr);
    assert.equal(
      github.requests.some(
        ({ method, url }) =>
          method === "PUT" &&
          url?.endsWith("/actions/secrets/ANTHROPIC_AUTH_TOKEN"),
      ),
      true,
    );

    github.requests.length = 0;
    const doctor = await runAsync(
      fixture.root,
      ["doctor", "--json"],
      "",
      environment,
    );
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).checks.remote.status, "pass");
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});

test("tracked Queue-local credentials block every GitHub write without removing Project-controlled Assets", async () => {
  const fixture = repository();
  const github = await fakeGitHub();
  const local = await runAsync(
    fixture.root,
    ["init", "--config", fixture.configPath],
    "yes\n",
    process.env,
  );
  assert.equal(local.status, 0, local.stderr);
  writeFileSync(
    join(fixture.root, ".sandcastle", ".env"),
    "ANTHROPIC_AUTH_TOKEN=tracked-secret\nANTHROPIC_BASE_URL=https://provider.example\n",
  );
  execFileSync("git", ["-C", fixture.root, "add", ".sandcastle/.env"]);
  const environment = {
    ...process.env,
    GITHUB_API_URL: github.apiUrl,
    GITHUB_REPOSITORY: "acme/widget",
    GITHUB_TOKEN: "github-token",
  };
  try {
    const result = await runAsync(
      fixture.root,
      ["init", "--config", fixture.configPath],
      "yes\n",
      environment,
    );
    assert.equal(result.status, 4);
    assert.match(result.stdout, /TRACKED_CREDENTIAL_FILE/u);
    assert.equal(result.stdout.includes("tracked-secret"), false);
    assert.equal(github.requests.every(({ method }) => method === "GET"), true);
  } finally {
    await github.close();
  }
});

test("a secret created during confirmation is preserved without overwrite confirmation", async () => {
  const fixture = repository();
  const github = await fakeGitHub({ createSecretAfterPreview: true });
  const environment = {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: "must-not-overwrite",
    ANTHROPIC_BASE_URL: "https://provider.example",
    GITHUB_API_URL: github.apiUrl,
    GITHUB_REPOSITORY: "acme/widget",
    GITHUB_TOKEN: "github-token",
  };
  try {
    const result = await runAsync(
      fixture.root,
      ["init", "--config", fixture.configPath],
      "yes\nyes\n",
      environment,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      github.requests.some(({ method }) => method === "PUT"),
      false,
    );
  } finally {
    await github.close();
  }
});
