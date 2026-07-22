import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  ANTHROPIC_CONTRACT_CAPABILITIES,
  GITHUB_CONTRACT_CAPABILITIES,
} from "../dist/index.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const candidateSha = option("--candidate-sha");
const output = option("--output");
if (!candidateSha || !/^[a-f0-9]{40}$/u.test(candidateSha) || !output) {
  process.stderr.write("Contract CI requires --candidate-sha and --output.\n");
  process.exit(2);
}
for (const name of [
  "ANTHROPIC_AUTH_TOKEN",
  "LIVE_E2E_DISPATCH_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "SANDCASTLE_RELEASE_TOKEN",
]) {
  if (process.env[name]) {
    process.stderr.write("Contract CI received a forbidden credential.\n");
    process.exit(2);
  }
}

const completed = spawnSync(
  process.execPath,
  [
    "--test",
    "test/api-contract-ci.test.mjs",
    "test/credential-broker.test.mjs",
    "test/frontier.test.mjs",
    "test/ticket-publish.test.mjs",
  ],
  { stdio: "inherit" },
);
if (completed.status !== 0) {
  process.exit(completed.status ?? 1);
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  `${JSON.stringify({
    contracts: {
      anthropic: [...ANTHROPIC_CONTRACT_CAPABILITIES],
      candidateSha,
      github: [...GITHUB_CONTRACT_CAPABILITIES],
    },
    schemaVersion: 1,
  })}\n`,
  { mode: 0o600 },
);
