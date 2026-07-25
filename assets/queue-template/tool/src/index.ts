import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { executeWorkUnit, type WorkUnitRole } from "./work-unit.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const role = option("--role") as WorkUnitRole | undefined;
  const model = option("--model");
  const promptFile = option("--prompt-file");
  if (
    !role ||
    !["ticket", "final-review", "final-fix", "final-rereview"].includes(role) ||
    !model ||
    !promptFile
  ) {
    process.stderr.write(
      "Usage: queue-tool --role <role> --model <model> --prompt-file <path>\n",
    );
    process.exitCode = 2;
    return;
  }
  await readFile(resolve(promptFile), "utf8");
  const result = await executeWorkUnit({
    cwd: process.cwd(),
    environment: process.env,
    model,
    promptFile,
    role,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main();
