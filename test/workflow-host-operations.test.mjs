import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const operations = [
  "accept-no-change",
  "process",
  "review-only",
  "final-fix",
  "abort",
  "complete-no-change",
  "finalize-batch",
  "remote-doctor",
];

test("workflow-host executes every managed operation through the host runtime", async () => {
  const { runWorkflowHostCommand } = await import("../dist/index.js");
  const calls = [];
  const runtime = Object.fromEntries(
    operations.map((operation) => [
      operation,
      async ({ arguments: arguments_, environment, repositoryPath }) => {
        calls.push({
          arguments: arguments_,
          operation,
          repositoryPath,
          runId: environment.GITHUB_RUN_ID,
        });
        return { operation, status: "observed" };
      },
    ]),
  );

  for (const [index, operation] of operations.entries()) {
    const result = await runWorkflowHostCommand(
      "/repository",
      ["--operation", operation],
      {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_RUN_ID: String(9700 + index),
        SANDCASTLE_OPERATION: operation,
      },
      runtime,
    );
    assert.deepEqual(result, {
      operation,
      result: { operation, status: "observed" },
    });
  }

  assert.deepEqual(
    calls.map(({ operation }) => operation),
    operations,
  );
  assert.equal(calls.every(({ repositoryPath }) => repositoryPath === "/repository"), true);
});

test("workflow-host rejects mismatched dispatch inputs before any host command", async () => {
  const { ConfigurationError, runWorkflowHostCommand } = await import(
    "../dist/index.js"
  );
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-workflow-input-"));
  const repository = join(directory, "repository");
  const binaryDirectory = join(directory, "bin");
  const eventPath = join(directory, "event.json");
  const sideEffectLog = join(directory, "side-effects.log");
  mkdirSync(repository);
  mkdirSync(binaryDirectory);
  writeFileSync(
    eventPath,
    `${JSON.stringify({
      inputs: {
        batch_id: "p1-aaaaaaaaaaaa-r9700",
        expected_head: "a".repeat(40),
        operation: "resume",
      },
    })}\n`,
  );
  for (const command of ["docker", "gh", "git"]) {
    const executable = join(binaryDirectory, command);
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf "%s\\n" "$0" >> "$SANDCASTLE_SIDE_EFFECT_LOG"\nexit 99\n',
    );
    chmodSync(executable, 0o755);
  }

  await assert.rejects(
    runWorkflowHostCommand(
      repository,
      [
        "--operation",
        "process",
        "--mode",
        "continue",
        "--batch-id",
        "p1-aaaaaaaaaaaa-r9700",
        "--expected-head",
        "a".repeat(40),
      ],
      {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_RUN_ID: "9700",
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        SANDCASTLE_OPERATION: "process",
        SANDCASTLE_SIDE_EFFECT_LOG: sideEffectLog,
      },
    ),
    (error) =>
      error instanceof ConfigurationError &&
      error.diagnostics.some(
        ({ code }) => code === "WORKFLOW_DISPATCH_INPUT_MISMATCH",
      ),
  );
  assert.equal(existsSync(sideEffectLog), false);
});

test("workflow Ticket inputs reject intermediate-length Git object IDs", async () => {
  const { ConfigurationError, runWorkflowTicketDriver } = await import(
    "../dist/index.js"
  );
  const image = `ghcr.io/acme/sandcastle-control@sha256:${"b".repeat(64)}`;

  for (const length of [41, 63]) {
    await assert.rejects(
      runWorkflowTicketDriver(
        "/repository-must-not-be-read",
        [
          "--batch-id",
          "p1-aaaaaaaaaaaa-r9700",
          "--before-head",
          "a".repeat(length),
          "--ticket",
          "2",
          "--config",
          ".sandcastle/config.json",
          "--image",
          image,
        ],
        { SANDCASTLE_CONTROL_PLANE_IMAGE: image },
      ),
      (error) =>
        error instanceof ConfigurationError &&
        error.diagnostics.some(
          ({ code }) => code === "WORKFLOW_TICKET_INPUT_INVALID",
        ),
    );
  }
});
