#!/usr/bin/env node

import {
  runPinnedAgentDriver,
  runPinnedFinalFixDriver,
  runPinnedFinalReviewDriver,
} from "./agent/driver.js";
import { runCredentialBrokerProcess } from "./broker/server.js";
import { ConfigurationError, InfrastructureError } from "./config.js";
import { runEgressProxyProcess } from "./sandbox/egress-proxy.js";
import { VERSION } from "./version.js";
import {
  runWorkflowHostCommand,
  runWorkflowTicketDriver,
} from "./workflow/host.js";

const arguments_ = process.argv.slice(2);
const [command] = arguments_;

if (!command || command === "version" || command === "--version") {
  process.stdout.write(`${VERSION}\n`);
} else if (command === "credential-broker") {
  try {
    await runCredentialBrokerProcess();
  } catch (error) {
    report(error);
  }
} else if (command === "egress-proxy") {
  try {
    await runEgressProxyProcess();
  } catch (error) {
    report(error);
  }
} else if (command === "agent-driver") {
  try {
    await runPinnedAgentDriver(arguments_.slice(1));
  } catch (error) {
    report(error);
  }
} else if (command === "final-review-driver") {
  try {
    await runPinnedFinalReviewDriver(arguments_.slice(1));
  } catch (error) {
    report(error);
  }
} else if (command === "final-fix-driver") {
  try {
    await runPinnedFinalFixDriver(arguments_.slice(1));
  } catch (error) {
    report(error);
  }
} else if (command === "workflow-host") {
  try {
    const result = await runWorkflowHostCommand(
      process.cwd(),
      arguments_.slice(1),
    );
    process.stdout.write(
      `${JSON.stringify({ command, ok: true, result, version: VERSION })}\n`,
    );
    process.exitCode = workflowHostFailed(result.result) ? 4 : 0;
  } catch (error) {
    report(error);
  }
} else if (command === "ticket-driver") {
  try {
    const result = await runWorkflowTicketDriver(
      process.cwd(),
      arguments_.slice(1),
    );
    process.stdout.write(
      `${JSON.stringify({ command, ok: true, result, version: VERSION })}\n`,
    );
  } catch (error) {
    report(error);
  }
} else {
  process.stderr.write(
    "The requested Sandcastle control-plane operation is not available in this release.\n",
  );
  process.exitCode = 2;
}

function workflowHostFailed(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as { status?: unknown }).status === "failed"
  );
}

function report(error: unknown): void {
  if (error instanceof ConfigurationError) {
    process.stdout.write(
      `${JSON.stringify({ category: "configuration", diagnostics: error.diagnostics, ok: false, version: VERSION })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (error instanceof InfrastructureError) {
    process.stdout.write(
      `${JSON.stringify({ category: "infrastructure", diagnostics: error.diagnostics, ok: false, version: VERSION })}\n`,
    );
    process.exitCode = 3;
    return;
  }
  throw error;
}
