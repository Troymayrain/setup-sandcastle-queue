import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cliPath = new URL("../dist/cli.js", import.meta.url);
const image = `ghcr.io/acme/sandcastle-control@sha256:${"c".repeat(64)}`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function createRepository() {
  const repository = mkdtempSync(join(tmpdir(), "sandcastle-ticket-repository-"));
  execFileSync("git", ["init", "--quiet", repository]);
  mkdirSync(join(repository, "src"));
  writeFileSync(join(repository, "README.md"), "# fixture\n");
  writeFileSync(join(repository, "src", "feature.js"), "export const ticket = 0;\n");
  execFileSync("git", ["-C", repository, "add", "."]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Sandcastle Test",
    "-c",
    "user.email=sandcastle@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return repository;
}

function writeConfig({ failing = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-ticket-config-"));
  const path = join(directory, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      queue: {
        ownershipLabel: "sandcastle",
        readyLabel: "ready-for-agent",
      },
      runtime: { adapter: "node-npm", version: "22.22.2" },
      commands: {
        tests: [{ argv: ["node", failing ? "failing-tests.mjs" : "tests.mjs"] }],
        verification: [{ argv: ["node", "verify.mjs"] }],
      },
      provider: {
        kind: "anthropic-compatible",
        models: { ticket: "ticket-model" },
      },
      execution: {
        jobTimeoutMinutes: 350,
        maxTicketsPerRun: 3,
        minimumRemainingMinutes: 140,
        processingBudgetMinutes: 300,
        ticketTimeoutMinutes: 120,
      },
      audit: { retentionDays: 30 },
    })}\n`,
  );
  return path;
}

function issueSnapshot(number, title, body) {
  return {
    body,
    bodySha256: sha256(body),
    comments: [],
    id: 3000 + number,
    number,
    title,
    titleSha256: sha256(title),
    updatedAt: "2026-07-22T00:00:00Z",
    url: `https://github.com/acme/widget/issues/${number}`,
  };
}

function writeSnapshot(ticket) {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-ticket-snapshot-"));
  const parent = issueSnapshot(1, "Parent PRD", "Trusted parent specification.");
  const child = issueSnapshot(
    ticket,
    `Ticket ${ticket}`,
    `## Parent\n\n#1\n\n## Work\n\nImplement Ticket ${ticket}.`,
  );
  const snapshot = {
    parent,
    specHash: sha256(canonicalJson({ parent, ticket: child })),
    ticket: child,
  };
  const path = join(directory, "snapshot.json");
  writeFileSync(path, `${JSON.stringify(snapshot)}\n`);
  return path;
}

function writeSeam() {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-ticket-seam-"));
  const path = join(directory, "seam.json");
  writeFileSync(
    path,
    `${JSON.stringify({
      confirmed: true,
      description:
        "Real CLI in a temporary Git repository with host-observed Docker calls.",
      schemaVersion: 1,
    })}\n`,
  );
  return path;
}

function createTicketDocker(
  repository,
  { noChange = false, selfSignedOnly = false } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-ticket-docker-"));
  const logPath = join(directory, "calls.jsonl");
  const executable = join(directory, "docker");
  writeFileSync(logPath, "");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, env: process.env }) + "\\n");
if (argv[0] === "run" && argv.includes("--detach")) {
  process.stdout.write("fake-proxy-container\\n");
  process.exit(0);
}
if (argv[0] !== "run" || !argv.includes("--sandcastle-phase")) {
  if (argv.includes("failing-tests.mjs")) process.exit(9);
  process.exit(0);
}
function mountSource(target) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] !== "--mount") continue;
    const fields = Object.fromEntries(argv[index + 1].split(",").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0 ? [part, true] : [part.slice(0, separator), part.slice(separator + 1)];
    }));
    if (fields.dst === target) return fields.src;
  }
  throw new Error("missing mount " + target);
}
const phase = argv[argv.indexOf("--sandcastle-phase") + 1];
const outputArgument = argv[argv.indexOf("--output") + 1];
const outputDirectory = mountSource("/sandcastle/output");
const inputDirectory = mountSource("/sandcastle/input");
const outputPath = outputArgument.replace("/sandcastle/output", outputDirectory);
const contract = JSON.parse(readFileSync(inputDirectory + "/contract.json", "utf8"));
function observe(id, name, input = {}) {
  if (${JSON.stringify(selfSignedOnly)}) return;
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] },
  }) + "\\n");
}
if (phase === "implementation") {
  observe("implement-" + contract.sessionId, "Skill", { skill: "implement" });
  observe("tdd-" + contract.sessionId, "Skill", { skill: "tdd" });
  if (${JSON.stringify(noChange)}) {
    const head = execFileSync("git", ["-C", ${JSON.stringify(repository)}, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(outputPath, JSON.stringify({
      events: [
        { kind: "skill-tool-result", ok: true, sequence: 1, skill: "implement", toolCallId: "implement-" + contract.sessionId },
        { kind: "skill-tool-result", ok: true, sequence: 2, skill: "tdd", toolCallId: "tdd-" + contract.sessionId },
      ],
      head,
      phase,
      schemaVersion: 1,
      sessionId: contract.sessionId,
      status: "no-change",
      ticket: contract.ticket,
    }) + "\\n");
    process.exit(0);
  }
  writeFileSync(${JSON.stringify(join(repository, "src", "feature.js"))}, "export const ticket = " + contract.ticket + ";\\n");
  observe("workspace-" + contract.sessionId, "Write", { file_path: "src/feature.js" });
  execFileSync("git", ["-C", ${JSON.stringify(repository)}, "add", "src/feature.js"]);
  execFileSync("git", ["-C", ${JSON.stringify(repository)}, "-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "commit", "--quiet", "-m", "agent intermediate"]);
  const head = execFileSync("git", ["-C", ${JSON.stringify(repository)}, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(outputPath, JSON.stringify({
    events: [
      { kind: "skill-tool-result", ok: true, sequence: 1, skill: "implement", toolCallId: "implement-" + contract.sessionId },
      { kind: "skill-tool-result", ok: true, sequence: 2, skill: "tdd", toolCallId: "tdd-" + contract.sessionId },
      { kind: "workspace-change", sequence: 3 },
    ],
    head,
    phase,
    schemaVersion: 1,
    sessionId: contract.sessionId,
    status: "implemented",
    ticket: contract.ticket,
  }) + "\\n");
} else if (phase === "review") {
  observe("review-" + contract.sessionId, "Skill", { skill: "code-review" });
  const head = execFileSync("git", ["-C", ${JSON.stringify(repository)}, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(outputPath, JSON.stringify({
    events: [
      { kind: "skill-tool-result", ok: true, sequence: 1, skill: "code-review", toolCallId: "review-" + contract.sessionId },
    ],
    findings: [],
    fixedPoint: contract.review.fixedPoint,
    head,
    phase,
    schemaVersion: 1,
    sessionId: contract.sessionId,
    ticket: contract.ticket,
    verificationHash: contract.review.verificationHash,
  }) + "\\n");
}
`,
  );
  chmodSync(executable, 0o755);
  return {
    executable,
    calls() {
      return readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

function processEnvironment(docker, ticket) {
  const scope = `ticket:${ticket}`;
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: "https://api.example.com",
    ANTHROPIC_AUTH_TOKEN: "real-provider-token-must-not-enter-agent",
    GITHUB_TOKEN: "github-token-must-not-enter-agent",
    SANDCASTLE_BATCH_ID: "p1-aaaaaaaaaaaa-r9001",
    SANDCASTLE_BROKER_BASE_URL:
      `http://sandcastle-broker:8081/batches/p1-aaaaaaaaaaaa-r9001/scopes/${encodeURIComponent(scope)}`,
    SANDCASTLE_DOCKER_BIN: docker.executable,
    SANDCASTLE_SCOPE: scope,
    SANDCASTLE_SESSION_TOKEN: `session-token-for-ticket-${ticket}`,
  };
}

function processArgs({ before, config, seam, snapshot, ticket }) {
  return [
    cliPath.pathname,
    "process-ticket",
    "--config",
    config,
    "--ticket",
    String(ticket),
    "--snapshot",
    snapshot,
    "--seam",
    seam,
    "--before-head",
    before,
    "--image",
    image,
    "--agent-driver-json",
    '["sandcastle-queue","agent-driver"]',
  ];
}

test("each Ticket gets a fresh context with host verification before fixed-point review", () => {
  const repository = createRepository();
  const docker = createTicketDocker(repository);
  const config = writeConfig();
  const seam = writeSeam();
  const results = [];

  for (const ticket of [2, 3]) {
    const before = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const result = spawnSync(
      process.execPath,
      processArgs({
        before,
        config,
        seam,
        snapshot: writeSnapshot(ticket),
        ticket,
      }),
      {
        cwd: repository,
        encoding: "utf8",
        env: processEnvironment(docker, ticket),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "process-ticket");
    assert.equal(output.result.status, "reviewed");
    assert.equal(output.result.ticket, ticket);
    assert.equal(output.result.beforeHead, before);
    assert.match(output.result.head, /^[a-f0-9]{40}$/u);
    assert.match(output.result.verificationHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(output.result.findings, []);
    assert.deepEqual(Object.keys(output.result.toolCalls).sort(), [
      "codeReview",
      "implement",
      "tdd",
    ]);
    results.push(output.result);
  }
  assert.equal(results[0].sessionId === results[1].sessionId, false);

  const stageRuns = docker.calls().filter(
    ({ argv }) =>
      argv[0] === "run" &&
      !argv.includes("egress-proxy") &&
      !argv.includes("credential-broker"),
  );
  const observedCommands = stageRuns.map(({ argv }) => {
    const imageIndex = argv.indexOf(image);
    const entrypoint = argv[argv.indexOf("--entrypoint") + 1];
    return [entrypoint, ...argv.slice(imageIndex + 1)];
  });
  assert.deepEqual(observedCommands, [
    [
      "sandcastle-queue",
      "agent-driver",
      "--sandcastle-phase",
      "implementation",
      "--contract",
      "/sandcastle/input/contract.json",
      "--output",
      "/sandcastle/output/implementation.json",
    ],
    ["node", "tests.mjs"],
    ["node", "verify.mjs"],
    [
      "sandcastle-queue",
      "agent-driver",
      "--sandcastle-phase",
      "review",
      "--contract",
      "/sandcastle/input/contract.json",
      "--output",
      "/sandcastle/output/review.json",
    ],
    [
      "sandcastle-queue",
      "agent-driver",
      "--sandcastle-phase",
      "implementation",
      "--contract",
      "/sandcastle/input/contract.json",
      "--output",
      "/sandcastle/output/implementation.json",
    ],
    ["node", "tests.mjs"],
    ["node", "verify.mjs"],
    [
      "sandcastle-queue",
      "agent-driver",
      "--sandcastle-phase",
      "review",
      "--contract",
      "/sandcastle/input/contract.json",
      "--output",
      "/sandcastle/output/review.json",
    ],
  ]);
  const agentRuns = stageRuns.filter(({ argv }) => argv.includes("--sandcastle-phase"));
  assert.equal(
    agentRuns.every(({ argv }) =>
      argv.some(
        (argument) =>
          argument.includes("dst=/sandcastle/input") && argument.includes("readonly"),
      ),
    ),
    true,
  );
  assert.equal(
    JSON.stringify(
      docker.calls().filter(({ argv }) => !argv.includes("credential-broker")),
    ).includes("real-provider-token-must-not-enter-agent"),
    false,
  );
  assert.equal(
    JSON.stringify(docker.calls()).includes("github-token-must-not-enter-agent"),
    false,
  );
});

test("host test failure blocks review even after Agent reports implementation success", () => {
  const repository = createRepository();
  const docker = createTicketDocker(repository);
  const before = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const result = spawnSync(
    process.execPath,
    processArgs({
      before,
      config: writeConfig({ failing: true }),
      seam: writeSeam(),
      snapshot: writeSnapshot(2),
      ticket: 2,
    }),
    {
      cwd: repository,
      encoding: "utf8",
      env: processEnvironment(docker, 2),
    },
  );

  assert.equal(result.status, 2, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).diagnostics[0].code,
    "TICKET_VERIFICATION_FAILED",
  );
  const stageRuns = docker.calls().filter(
    ({ argv }) =>
      argv[0] === "run" &&
      !argv.includes("egress-proxy") &&
      !argv.includes("credential-broker"),
  );
  assert.equal(stageRuns.some(({ argv }) => argv.includes("failing-tests.mjs")), true);
  assert.equal(
    stageRuns.some(
      ({ argv }) =>
        argv.includes("--sandcastle-phase") && argv.includes("review"),
    ),
    false,
  );
});

test("a verified zero-diff Agent result waits for human no-change acceptance without review", () => {
  const repository = createRepository();
  const docker = createTicketDocker(repository, { noChange: true });
  const before = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const result = spawnSync(
    process.execPath,
    processArgs({
      before,
      config: writeConfig(),
      seam: writeSeam(),
      snapshot: writeSnapshot(2),
      ticket: 2,
    }),
    {
      cwd: repository,
      encoding: "utf8",
      env: processEnvironment(docker, 2),
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout).result;
  assert.equal(outcome.status, "waiting-no-change");
  assert.equal(outcome.beforeHead, before);
  assert.equal(outcome.head, before);
  assert.deepEqual(Object.keys(outcome.toolCalls).sort(), ["implement", "tdd"]);
  const stageRuns = docker.calls().filter(
    ({ argv }) =>
      argv[0] === "run" &&
      !argv.includes("egress-proxy") &&
      !argv.includes("credential-broker"),
  );
  assert.equal(stageRuns.length, 1);
  assert.equal(stageRuns[0].argv.includes("implementation"), true);
  assert.equal(stageRuns[0].argv.includes("review"), false);
});

test("missing pre-confirmed spec or testing seam blocks before sandbox launch", () => {
  const repository = createRepository();
  const docker = createTicketDocker(repository);
  const before = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const base = [
    cliPath.pathname,
    "process-ticket",
    "--config",
    writeConfig(),
    "--ticket",
    "2",
    "--before-head",
    before,
    "--image",
    image,
    "--agent-driver-json",
    '["sandcastle-queue","agent-driver"]',
  ];
  const missingSpec = spawnSync(
    process.execPath,
    [...base, "--seam", writeSeam()],
    {
      cwd: repository,
      encoding: "utf8",
      env: processEnvironment(docker, 2),
    },
  );
  const missingSeam = spawnSync(
    process.execPath,
    [...base, "--snapshot", writeSnapshot(2)],
    {
      cwd: repository,
      encoding: "utf8",
      env: processEnvironment(docker, 2),
    },
  );

  assert.equal(missingSpec.status, 2, missingSpec.stderr);
  assert.equal(
    JSON.parse(missingSpec.stdout).diagnostics[0].code,
    "TICKET_SPEC_MISSING",
  );
  assert.equal(missingSeam.status, 2, missingSeam.stderr);
  assert.equal(
    JSON.parse(missingSeam.stdout).diagnostics[0].code,
    "TESTING_SEAM_MISSING",
  );
  assert.deepEqual(docker.calls(), []);
});

test("Agent-authored text cannot impersonate host-observed Skill tool results", () => {
  const repository = createRepository();
  const docker = createTicketDocker(repository, { selfSignedOnly: true });
  const before = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const result = spawnSync(
    process.execPath,
    processArgs({
      before,
      config: writeConfig(),
      seam: writeSeam(),
      snapshot: writeSnapshot(2),
      ticket: 2,
    }),
    {
      cwd: repository,
      encoding: "utf8",
      env: processEnvironment(docker, 2),
    },
  );

  assert.equal(result.status, 2, result.stderr);
  assert.equal(
    JSON.parse(result.stdout).diagnostics[0].code,
    "TICKET_SKILL_RECEIPT_MISSING",
  );
});
