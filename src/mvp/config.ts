import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import { CliError } from "./errors.js";

export interface CommandSpec {
  argv: string[];
}

export interface QueueConfig {
  schemaVersion: 1;
  repository: {
    baseBranch: string;
    integrationBranch: string;
  };
  queue: {
    readyLabel: string;
    ownershipLabel: string;
  };
  runner: {
    runsOn: string;
  };
  commands: {
    bootstrap: CommandSpec[];
    test: CommandSpec[];
    verification: CommandSpec[];
  };
  models: {
    ticket: string;
    finalReview: string;
    finalFix: string;
  };
  execution: {
    hostFinalizationReserveMinutes: number;
  };
}

const schemaPath = fileURLToPath(
  new URL("../../schema/mvp-config.schema.json", import.meta.url),
);
const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function diagnostic(error: ErrorObject): { code: string; message: string; path: string } {
  if (error.instancePath === "/schemaVersion" && error.keyword === "const") {
    return {
      code: "UNSUPPORTED_SCHEMA",
      message: "Only schema version 1 is supported.",
      path: error.instancePath,
    };
  }
  if (error.keyword === "additionalProperties") {
    return {
      code: "UNKNOWN_FIELD",
      message: "Configuration contains an unknown field.",
      path: error.instancePath,
    };
  }
  if (error.keyword === "required") {
    return {
      code: "MISSING_FIELD",
      message: "Configuration is missing a required field.",
      path: error.instancePath,
    };
  }
  return {
    code: "INVALID_FIELD",
    message: "Configuration field does not satisfy the schema.",
    path: error.instancePath,
  };
}

function assertDirectCommands(config: QueueConfig): void {
  for (const [group, commands] of Object.entries(config.commands)) {
    for (const [index, command] of commands.entries()) {
      if (
        ["sh", "bash", "zsh", "cmd", "powershell", "pwsh"].includes(command.argv[0]!) ||
        command.argv.some((argument) => /\$\{|&&|\|\||[<>`]/u.test(argument))
      ) {
        throw new CliError(2, "CONFIG_INVALID", "Queue configuration is invalid.", {
          diagnostics: [
            {
              code: "UNSAFE_COMMAND",
              message: "Project commands must be direct argv arrays without shell parsing.",
              path: `/commands/${group}/${index}`,
            },
          ],
        });
      }
    }
  }
}

export function parseQueueConfig(candidate: unknown): QueueConfig {
  if (!validate(candidate)) {
    throw new CliError(2, "CONFIG_INVALID", "Queue configuration is invalid.", {
      diagnostics: (validate.errors ?? []).map(diagnostic),
    });
  }
  const config = candidate as QueueConfig;
  if (config.repository.baseBranch === config.repository.integrationBranch) {
    throw new CliError(2, "CONFIG_INVALID", "Queue configuration is invalid.", {
      diagnostics: [
        {
          code: "BRANCHES_COLLIDE",
          message: "Base and Integration Branches must be different.",
          path: "/repository/integrationBranch",
        },
      ],
    });
  }
  assertDirectCommands(config);
  return config;
}

export async function readQueueConfig(path: string): Promise<QueueConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new CliError(3, "CONFIG_READ_FAILED", "Unable to read Queue configuration.");
  }
  try {
    return parseQueueConfig(JSON.parse(source));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(2, "CONFIG_INVALID", "Queue configuration is not valid JSON.");
  }
}
