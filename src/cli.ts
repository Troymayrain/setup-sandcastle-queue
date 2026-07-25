#!/usr/bin/env node

import { createInterface } from "node:readline/promises";

import { VERSION } from "./version.js";
import { readQueueConfig } from "./mvp/config.js";
import { doctorOffline } from "./mvp/doctor.js";
import { CliError } from "./mvp/errors.js";
import {
  applyGitHubResources,
  inspectGitHubResources,
  previewGitHubResources,
  resolveProviderCredentials,
} from "./mvp/github.js";
import { applyInit, previewInit } from "./mvp/installer.js";

const args = process.argv.slice(2);
const command = args[0];
const promptInput = createInterface({ input: process.stdin, output: process.stdout });
const promptLines = promptInput[Symbol.asyncIterator]();

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

async function confirmPhrase(message: string, phrase: string): Promise<boolean> {
  process.stdout.write(message);
  const answer = await promptLines.next();
  process.stdout.write("\n");
  return !answer.done && answer.value.trim().toLowerCase() === phrase;
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
    } else {
      process.stdout.write(preview.patch);
      if (
        !(await confirmPhrase(
          "Apply these Project-controlled Assets? Type yes to continue: ",
          "yes",
        ))
      ) {
        process.stdout.write("Installation cancelled; no writes performed.\n");
        return;
      }
      await applyInit(process.cwd(), preview);
      process.stdout.write("Queue Template installed as Project-controlled Assets.\n");
    }

    const credentials = await resolveProviderCredentials(process.cwd(), process.env);
    if (!credentials) return;
    const githubPreview = await previewGitHubResources(config, process.env);
    writeJson({
      mode: "github-preview",
      repository: githubPreview.repository,
      resources: githubPreview.resources,
    });
    if (
      !(await confirmPhrase(
        "Configure these GitHub resources? Type yes to continue: ",
        "yes",
      ))
    ) {
      process.stdout.write("GitHub configuration skipped; local assets were preserved.\n");
      return;
    }
    const overwriteSecret =
      githubPreview.secretExists &&
      (await confirmPhrase(
        "Existing Provider secret will be preserved. Type overwrite-secret to replace it: ",
        "overwrite-secret",
      ));
    const result = await applyGitHubResources(
      process.cwd(),
      config,
      githubPreview,
      credentials,
      overwriteSecret,
      process.env,
    );
    writeJson(result);
    process.exitCode = result.ok ? 0 : 4;
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
      : await (async () => {
          const config = await readQueueConfig(
            `${process.cwd()}/.sandcastle/config.json`,
          );
          const remote = await inspectGitHubResources(config, process.env);
          return {
            ...local,
            checks: { ...local.checks, remote },
            mode: "full" as const,
            ok: local.ok && remote.status === "pass",
          };
        })();
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
} finally {
  promptInput.close();
}
