import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import {
  createQueueAuditRecord,
  writeQueueAuditEvidence,
} from "./audit.js";
import { RestGitHubHost } from "./github-host.js";
import {
  NodeFinalReviewHost,
  NodeIntegrationHost,
} from "./host-boundary.js";
import { executeWorkUnit } from "./work-unit.js";
import {
  executeWorkflowHostOperation,
  type WorkflowHostConfig,
  type WorkflowHostOperation,
} from "./workflow-host.js";

const operations = [
  "start",
  "continue",
  "resume",
  "final-review",
  "final-fix",
  "final-rereview",
] as const;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requestedOperation(): WorkflowHostOperation | undefined {
  const candidate = option("--operation");
  return operations.find((operation) => operation === candidate);
}

async function readStrictConfig(repository: string): Promise<WorkflowHostConfig> {
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
  return candidate as WorkflowHostConfig;
}

async function main(): Promise<
  | {
      expectedHead?: string;
      operation: WorkflowHostOperation;
      result: { status: string };
    }
  | undefined
> {
  const operation = requestedOperation();
  if (!operation) {
    process.stderr.write("Usage: queue-tool --operation <operation>\n");
    process.exitCode = 2;
    return;
  }
  const repository = resolve(option("--repository") ?? join(process.cwd(), "../.."));
  const config = await readStrictConfig(repository);
  const result = await executeWorkflowHostOperation(
    {
      config,
      environment: process.env,
      expectedHead: option("--expected-head") || undefined,
      operation,
      predecessorRunId: option("--predecessor-run-id") || undefined,
      promptFiles: {
        finalFix: join(repository, ".sandcastle", "prompts", "final-fix.md"),
        finalReview: join(
          repository,
          ".sandcastle",
          "prompts",
          "final-review.md",
        ),
        ticket: join(repository, ".sandcastle", "prompts", "ticket.md"),
      },
      repository,
    },
    () => {
      const github = new RestGitHubHost(process.env);
      return {
        finalReviewHost: new NodeFinalReviewHost(
          repository,
          process.env,
          github,
        ),
        github,
        integrationHost: new NodeIntegrationHost(
          repository,
          process.env,
          github,
        ),
        runWorkUnit: executeWorkUnit,
      };
    },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "conflict" ? 4 : 0;
  return {
    expectedHead: option("--expected-head") || undefined,
    operation,
    result,
  };
}

const startedAt = Date.now();
try {
  const completed = await main();
  if (completed) {
    await writeQueueAuditEvidence(
      createQueueAuditRecord({
        durationMs: Date.now() - startedAt,
        expectedHead: completed.expectedHead,
        operation: completed.operation,
        result: completed.result,
        runId: process.env.GITHUB_RUN_ID ?? "",
      }),
      process.env,
    );
  }
} catch (error) {
  const operation = requestedOperation();
  if (operation) {
    await writeQueueAuditEvidence(
      createQueueAuditRecord({
        durationMs: Date.now() - startedAt,
        expectedHead: option("--expected-head"),
        operation,
        result: { status: "failure" },
        runId: process.env.GITHUB_RUN_ID ?? "",
      }),
      process.env,
    );
  }
  throw error;
}
