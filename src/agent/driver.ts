import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

import { ConfigurationError, InfrastructureError } from "../config.js";
import { readBoundedJsonFile } from "../json.js";

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function infrastructureError(code: string, message: string): InfrastructureError {
  return new InfrastructureError([{ code, message }]);
}

function optionValue(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

async function readContract(path: string): Promise<void> {
  const result = await readBoundedJsonFile(path, 2 * 1024 * 1024);
  if (!result.ok) {
    throw configurationError(
      "AGENT_DRIVER_CONTRACT_INVALID",
      "The host-controlled Agent contract is unavailable or invalid.",
    );
  }
}

async function runClaude(
  prompt: string,
  output: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const executable = environment.SANDCASTLE_CLAUDE_BIN ?? "claude";
  const status = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        "--print",
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "bypassPermissions",
        prompt,
      ],
      {
        env: environment,
        stdio: ["ignore", "inherit", "ignore"],
      },
    );
    child.once("error", () =>
      reject(
        infrastructureError(
          "AGENT_DRIVER_UNAVAILABLE",
          "The pinned Claude Code runtime could not be started.",
        ),
      ),
    );
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (status !== 0) {
    throw infrastructureError(
      "AGENT_DRIVER_FAILED",
      "The pinned Agent runtime exited unsuccessfully.",
    );
  }
  try {
    await access(output);
  } catch {
    throw configurationError(
      "AGENT_DRIVER_EVIDENCE_MISSING",
      "The Agent runtime did not produce the required phase evidence.",
    );
  }
}

export async function runPinnedAgentDriver(
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const phase = optionValue(arguments_, "--sandcastle-phase");
  const contract = optionValue(arguments_, "--contract");
  const output = optionValue(arguments_, "--output");
  if (
    (phase !== "implementation" && phase !== "review") ||
    contract !== "/sandcastle/input/contract.json" ||
    output !== `/sandcastle/output/${phase}.json` ||
    arguments_.length !== 6
  ) {
    throw configurationError(
      "AGENT_DRIVER_ARGUMENT_INVALID",
      "The pinned agent driver requires one host-controlled phase, contract, and output path.",
    );
  }
  await readContract(contract);
  const prompt = [
    "Use the project skill `sandcastle-runtime` to execute the host-controlled Ticket contract.",
    `Phase: ${phase}.`,
    `Read-only contract: ${contract}.`,
    `Write only the required machine-readable phase evidence to ${output}.`,
    "Invoke the required Skill tools through the client; plain-text claims are not evidence.",
    "Do not commit, push, mutate GitHub, or include prompts, responses, tokens, or environment values in evidence.",
  ].join("\n");
  await runClaude(prompt, output, environment);
}

export async function runPinnedFinalReviewDriver(
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const axis = optionValue(arguments_, "--axis");
  const contract = optionValue(arguments_, "--contract");
  const output = optionValue(arguments_, "--output");
  const outputName = axis?.toLocaleLowerCase("en-US");
  if (
    (axis !== "Spec" && axis !== "Standards") ||
    contract !== "/sandcastle/input/contract.json" ||
    output !== `/sandcastle/output/final-review-${outputName}.json` ||
    arguments_.length !== 6
  ) {
    throw configurationError(
      "FINAL_REVIEW_DRIVER_ARGUMENT_INVALID",
      "The final review driver requires one host-controlled axis, contract, and output path.",
    );
  }
  await readContract(contract);
  const prompt = [
    "Invoke the project `code-review` Skill tool for the host-controlled cumulative review contract.",
    `Review axis: ${axis}.`,
    `Read-only contract: ${contract}.`,
    `Write the required machine-readable axis result to ${output}.`,
    "The result must copy the fixed reviewedHead, verificationHash, specificationHash, sessionId, and axis from the contract.",
    "Use marker `sandcastle-final-review-result`, schemaVersion 1, a bounded findings array, and skill `{ok:true, receiptId}` where receiptId is the real successful code-review tool call ID.",
    "Do not modify the workspace, commit, push, call GitHub, or retain prompts, responses, tokens, environment values, or raw output.",
  ].join("\n");
  await runClaude(prompt, output, environment);
}

export async function runPinnedFinalFixDriver(
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const contract = optionValue(arguments_, "--contract");
  const output = optionValue(arguments_, "--output");
  if (
    contract !== "/sandcastle/input/contract.json" ||
    output !== "/sandcastle/output/final-fix.json" ||
    arguments_.length !== 4
  ) {
    throw configurationError(
      "FINAL_FIX_DRIVER_ARGUMENT_INVALID",
      "The final fix driver requires one host-controlled contract and output path.",
    );
  }
  await readContract(contract);
  const prompt = [
    "Implement only the actionable findings in the host-controlled final fix contract.",
    "Invoke the project `implement` Skill tool, then invoke `tdd` before the first workspace change.",
    `Read-only contract: ${contract}.`,
    `Write machine-readable evidence to ${output}.`,
    "Use schemaVersion 1, phase `final-fix`, status `fixed`, the contract sessionId, and ordered skill-tool-result/workspace-change events with real tool call IDs.",
    "Do not commit, push, call GitHub, edit protected control-plane paths, or retain prompts, responses, tokens, environment values, or raw output.",
  ].join("\n");
  await runClaude(prompt, output, environment);
}
