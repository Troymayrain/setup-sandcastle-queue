import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  CREDENTIALLESS_FIXTURE_IDS,
  FIXTURE_LIFECYCLE_STEPS,
} from "../dist/index.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const fixture = option("--fixture");
const candidateSha = option("--candidate-sha");
const output = option("--output");
if (!fixture || !CREDENTIALLESS_FIXTURE_IDS.includes(fixture)) {
  fail("A supported --fixture is required.");
}
if (!candidateSha || !/^[a-f0-9]{40}$/u.test(candidateSha)) {
  fail("An exact --candidate-sha is required.");
}
if (!output) {
  fail("An --output path is required.");
}
if (process.env.SANDCASTLE_FIXTURE_CONTAINER_BUILT !== "true") {
  fail("Fixture evidence requires a successful container build and run.");
}
for (const name of [
  "ANTHROPIC_AUTH_TOKEN",
  "LIVE_E2E_DISPATCH_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "SANDCASTLE_RELEASE_TOKEN",
]) {
  if (process.env[name]) {
    fail("Credentialless fixture execution received a forbidden credential.");
  }
}

const lifecyclePattern = `^credentialless fixture ${fixture} completes the observable lifecycle$`;
const suites = [
  ["--test-name-pattern", lifecyclePattern, "test/credentialless-fixture-lifecycle.test.mjs"],
  ["test/audit.test.mjs"],
  ["test/frontier.test.mjs"],
  ["test/sandbox-policy.test.mjs"],
];
if (fixture === "existing-install") {
  suites.push(["test/installer-apply.test.mjs"]);
} else if (fixture === "adopt") {
  suites.push(["test/adopt.test.mjs"]);
} else if (fixture === "upgrade") {
  suites.push(["test/upgrade.test.mjs"]);
}

for (const arguments_ of suites) {
  const completed = spawnSync(process.execPath, ["--test", ...arguments_], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (completed.status !== 0) {
    process.exit(completed.status ?? 1);
  }
}

const evidence = {
  candidateSha,
  fixture,
  observations: {
    audit: true,
    repository: true,
    sandbox: true,
    tracker: true,
  },
  schemaVersion: 1,
  steps: FIXTURE_LIFECYCLE_STEPS.map((id) => ({ id, status: "pass" })),
  usedCredentials: false,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
