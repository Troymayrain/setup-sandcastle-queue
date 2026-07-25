import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { activateAndSelectFrontier } from "./frontier.js";
import { RestGitHubHost } from "./github-host.js";
import { NodeTicketHost } from "./host-boundary.js";
import {
  executeProcessingRun,
  type CommandSpec,
} from "./processing-run.js";
import { reconcilePublication } from "./reconciliation.js";
import { executeWorkUnit, type WorkUnitRole } from "./work-unit.js";

interface ToolConfig {
  commands: {
    bootstrap: CommandSpec[];
    test: CommandSpec[];
    verification: CommandSpec[];
  };
  queue: {
    ownershipLabel: string;
    readyLabel: string;
  };
  repository: {
    baseBranch: string;
    integrationBranch: string;
  };
  models: {
    finalFix: string;
    finalReview: string;
    ticket: string;
  };
}

type Operation =
  | "start"
  | "continue"
  | "resume"
  | "final-review"
  | "final-fix"
  | "final-rereview";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function roleFor(operation: Operation): WorkUnitRole {
  if (isProcessingOperation(operation)) {
    return "ticket";
  }
  return operation;
}

function isProcessingOperation(
  operation: Operation,
): operation is "start" | "continue" | "resume" {
  return operation === "start" || operation === "continue" || operation === "resume";
}

function modelFor(role: WorkUnitRole, config: ToolConfig): string {
  if (role === "ticket") return config.models.ticket;
  if (role === "final-fix") return config.models.finalFix;
  return config.models.finalReview;
}

async function readStrictConfig(repository: string): Promise<ToolConfig> {
  const [source, schemaSource] = await Promise.all([
    readFile(join(repository, ".sandcastle", "config.json"), "utf8"),
    readFile(join(repository, ".sandcastle", "config.schema.json"), "utf8"),
  ]);
  const candidate: unknown = JSON.parse(source);
  const schema = JSON.parse(schemaSource) as object;
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(candidate)) {
    throw new Error("Queue configuration failed strict schema validation.");
  }
  return candidate as ToolConfig;
}

async function main(): Promise<void> {
  const operation = option("--operation") as Operation | undefined;
  if (
    !operation ||
    ![
      "start",
      "continue",
      "resume",
      "final-review",
      "final-fix",
      "final-rereview",
    ].includes(operation)
  ) {
    process.stderr.write("Usage: queue-tool --operation <operation>\n");
    process.exitCode = 2;
    return;
  }
  const repository = resolve(option("--repository") ?? join(process.cwd(), "../.."));
  const config = await readStrictConfig(repository);
  if (isProcessingOperation(operation)) {
    if (operation !== "start") {
      process.stdout.write(
        `${JSON.stringify({
          reason: "continuation-not-yet-enabled",
          status: "conflict",
        })}\n`,
      );
      process.exitCode = 4;
      return;
    }
    const github = new RestGitHubHost(process.env);
    const reconciliation = await reconcilePublication(
      {
        baseBranch: config.repository.baseBranch,
        integrationBranch: config.repository.integrationBranch,
      },
      github,
    );
    if (
      reconciliation.status === "conflict" ||
      reconciliation.status === "reconciled"
    ) {
      process.stdout.write(`${JSON.stringify(reconciliation)}\n`);
      process.exitCode = reconciliation.status === "conflict" ? 4 : 0;
      return;
    }
    const result = await activateAndSelectFrontier(
      github,
      {
        ownership: config.queue.ownershipLabel,
        ready: config.queue.readyLabel,
      },
      operation === "start",
    );
    if (result.status !== "ready") {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.status === "conflict" ? 4 : 0;
      return;
    }
    const published = await executeProcessingRun(
      {
        baseBranch: config.repository.baseBranch,
        commands: config.commands,
        environment: process.env,
        integrationBranch: config.repository.integrationBranch,
        model: config.models.ticket,
        promptFile: join(repository, ".sandcastle", "prompts", "ticket.md"),
        repository,
        ticket: { body: result.body, number: result.ticket },
      },
      new NodeTicketHost(repository, process.env, github),
    );
    process.stdout.write(
      `${JSON.stringify({ activated: result.activated, ...published })}\n`,
    );
    return;
  }
  const role = roleFor(operation);
  const promptRole = role === "final-rereview" ? "final-review" : role;
  const promptFile = join(repository, ".sandcastle", "prompts", `${promptRole}.md`);
  const result = await executeWorkUnit({
    cwd: repository,
    environment: process.env,
    model: modelFor(role, config),
    promptFile,
    role,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
