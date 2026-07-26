import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const packageSpec = option("--package");
const expectedVersion = option("--expected-version");
if (!packageSpec || !expectedVersion) {
  process.stderr.write(
    "release-smoke requires --package <tarball-or-spec> and --expected-version <version>.\n",
  );
  process.exit(2);
}

const temporary = mkdtempSync(join(tmpdir(), "sandcastle-queue-release-smoke-"));
const consumer = join(temporary, "consumer");
const target = join(temporary, "target");
const configPath = join(temporary, "queue-config.json");
const environment = { ...process.env };
for (const name of [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "GITHUB_REPOSITORY",
  "GITHUB_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
]) {
  delete environment[name];
}

try {
  mkdirSync(consumer);
  mkdirSync(target);
  writeFileSync(
    join(consumer, "package.json"),
    '{"name":"release-smoke-consumer","private":true,"version":"1.0.0"}\n',
  );
  const installSpec = packageSpec.endsWith(".tgz")
    ? resolve(packageSpec)
    : packageSpec;
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", installSpec],
    { cwd: consumer, env: environment, stdio: "pipe" },
  );
  const cli = join(consumer, "node_modules", ".bin", "sandcastle-queue");

  assert.equal(
    execFileSync(cli, ["--version"], {
      cwd: target,
      encoding: "utf8",
      env: environment,
    }).trim(),
    expectedVersion,
  );
  assert.match(
    execFileSync(cli, ["--help"], {
      cwd: target,
      encoding: "utf8",
      env: environment,
    }),
    /sandcastle-queue init --config <path>/u,
  );

  execFileSync("git", ["init", "-b", "main"], { cwd: target, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Release Smoke"], { cwd: target });
  execFileSync("git", ["config", "user.email", "release-smoke@example.invalid"], {
    cwd: target,
  });
  writeFileSync(join(target, "README.md"), "# release smoke\n");
  execFileSync("git", ["add", "README.md"], { cwd: target });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: target, stdio: "pipe" });
  writeFileSync(
    configPath,
    `${JSON.stringify({
      commands: {
        bootstrap: [],
        test: [{ argv: ["node", "--version"] }],
        verification: [],
      },
      execution: { hostFinalizationReserveMinutes: 15 },
      models: {
        finalFix: "release-smoke-model",
        finalReview: "release-smoke-model",
        ticket: "release-smoke-model",
      },
      queue: {
        ownershipLabel: "sandcastle",
        readyLabel: "ready-for-agent",
      },
      repository: {
        baseBranch: "main",
        integrationBranch: "sandcastle/integration",
      },
      runner: { runsOn: "ubuntu-latest" },
      schemaVersion: 1,
    })}\n`,
  );

  const initialized = spawnSync(cli, ["init", "--config", configPath], {
    cwd: target,
    encoding: "utf8",
    env: environment,
    input: "yes\n",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.match(initialized.stdout, /diff --git a\/.sandcastle\/config.json/u);
  assert.match(initialized.stdout, /Queue Template installed as Project-controlled Assets/u);

  const doctor = spawnSync(cli, ["doctor", "--offline", "--json"], {
    cwd: target,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(doctor.status, 0, doctor.stderr);
  const result = JSON.parse(doctor.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "offline");
  assert.deepEqual(result.checks.remote, { status: "not-run" });

  process.stdout.write(
    `${JSON.stringify({ ok: true, package: packageSpec, version: expectedVersion })}\n`,
  );
} finally {
  rmSync(temporary, { force: true, recursive: true });
}
