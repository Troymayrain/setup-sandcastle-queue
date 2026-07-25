import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { activateAndSelectFrontier } from "./frontier.js";
import { RestFrontierGitHub } from "./github-frontier.js";
import { executeWorkUnit, type WorkUnitRole } from "./work-unit.js";

interface ToolConfig {
  queue: {
    ownershipLabel: string;
    readyLabel: string;
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
  if (operation === "start" || operation === "continue" || operation === "resume") {
    return "ticket";
  }
  return operation;
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
  if (operation === "start" || operation === "continue" || operation === "resume") {
    const result = await activateAndSelectFrontier(
      new RestFrontierGitHub(process.env),
      {
        ownership: config.queue.ownershipLabel,
        ready: config.queue.readyLabel,
      },
      operation === "start",
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "conflict" ? 4 : 0;
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
