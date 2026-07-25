#!/usr/bin/env node

import { createInterface } from "node:readline/promises";

import { VERSION } from "./version.js";
import { readQueueConfig } from "./mvp/config.js";
import { doctorOffline } from "./mvp/doctor.js";
import { CliError } from "./mvp/errors.js";
import { applyInit, previewInit } from "./mvp/installer.js";

const args = process.argv.slice(2);
const command = args[0];

const help = `Sandcastle Queue Setup

Usage:
  sandcastle-queue init --config <path>
  sandcastle-queue doctor [--offline] [--json]
  sandcastle-queue --help
  sandcastle-queue --version
`;

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function writeJson(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function confirm(): Promise<boolean> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question("Apply these Project-controlled Assets? Type yes to continue: ");
    process.stdout.write("\n");
    return answer.trim().toLowerCase() === "yes";
  } finally {
    input.close();
  }
}

async function main(): Promise<void> {
  if (command === undefined) {
    process.stdout.write(help);
    return;
  }
  if (command === "--help" && args.length === 1) {
    process.stdout.write(help);
    return;
  }
  if (command === "--version" && args.length === 1) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "init") {
    const configPath = option("--config");
    if (!configPath || args.length !== 3 || args[1] !== "--config") {
      throw new CliError(2, "CLI_USAGE_ERROR", "init requires --config <path>.");
    }
    const config = await readQueueConfig(configPath);
    const preview = await previewInit(process.cwd(), config);
    if (preview === null) {
      process.stdout.write("Queue Template is already initialized; no writes performed.\n");
      return;
    }
    process.stdout.write(preview.patch);
    if (!(await confirm())) {
      process.stdout.write("Installation cancelled; no writes performed.\n");
      return;
    }
    await applyInit(process.cwd(), preview);
    process.stdout.write("Queue Template installed as Project-controlled Assets.\n");
    return;
  }
  if (command === "doctor") {
    const flags = args.slice(1);
    if (
      flags.some((flag) => flag !== "--offline" && flag !== "--json") ||
      new Set(flags).size !== flags.length
    ) {
      throw new CliError(2, "CLI_USAGE_ERROR", "doctor accepts only --offline and --json.");
    }
    const offline = args.includes("--offline");
    const local = await doctorOffline(process.cwd());
    const result = offline
      ? local
      : {
          ...local,
          checks: {
            ...local.checks,
            remote: { code: "REMOTE_NOT_CONFIGURED", status: "fail" as const },
          },
          mode: "full" as const,
          ok: false,
        };
    if (args.includes("--json")) {
      writeJson(result);
    } else {
      process.stdout.write(result.ok ? "Offline doctor passed.\n" : "Offline doctor failed.\n");
    }
    process.exitCode = result.ok ? 0 : 4;
    return;
  }
  throw new CliError(2, "CLI_COMMAND_UNKNOWN", "Unknown sandcastle-queue command.");
}

try {
  await main();
} catch (error) {
  if (error instanceof CliError) {
    writeJson({
      code: error.code,
      message: error.message,
      ok: false,
      ...(error.details ?? {}),
    });
    process.exitCode = error.exitCode;
  } else {
    throw error;
  }
}
