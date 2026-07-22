import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const candidateSha = "a".repeat(40);
const releaseEnvironment = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_JOB: "release-gate",
  GITHUB_RUN_ID: "9700",
};

function gateEvidence(kind, runId) {
  const evidence = {
    artifactId: `${runId}01`,
    candidateSha,
    conclusion: "success",
    kind,
    reportSha256: `${Number(runId) % 10}`.repeat(64),
    runId,
  };
  return kind === "legacy-dogfood" || kind === "batch-dogfood"
    ? { ...evidence, testedVersion: "0.1.0" }
    : evidence;
}

async function validInput() {
  const release = await import("../dist/index.js");
  const manifest = release.createReleaseSourceManifest(candidateSha);
  const npmSha = "1".repeat(64);
  const skillSha = "2".repeat(64);
  const packageContents = [
    "Dockerfile",
    "LICENSE",
    "OPERATIONS.md",
    "README.md",
    "RELEASE_NOTES.md",
    "SKILL.md",
    "THIRD_PARTY_NOTICES.md",
    "agents/openai.yaml",
    "assets/project-docs/sandcastle-queue.md",
    "control-plane/package-lock.json",
    "control-plane/package.json",
    "control-plane/runtime-package.json",
    "dist/cli.js",
    "dist/index.js",
    "package.json",
    "release-manifest.json",
    "schema/config.schema.json",
    "scripts/setup.mjs",
    "vendor/runtime-skills/implement/SKILL.md",
    "vendor/sandcastle-runtime/SKILL.md",
  ];
  return {
    artifacts: {
      controlPlaneImage: {
        dependencyLockSha256: manifest.controlPlaneLockSha256,
        digest: release.CONTROL_PLANE_IMAGE_DIGEST,
        manifest,
        platform: "linux/amd64",
        reference: release.CONTROL_PLANE_IMAGE,
        repository: release.CONTROL_PLANE_IMAGE_REPOSITORY,
        tag: manifest.tag,
        versions: {
          brokerSchema: 1,
          claudeCode: release.CLAUDE_CODE_VERSION,
          node: release.CONTROL_PLANE_NODE_VERSION,
          sandcastleQueue: manifest.version,
        },
      },
      githubRelease: {
        assets: [
          {
            filename: `setup-sandcastle-queue-${manifest.version}.tgz`,
            kind: "npm",
            sha256: npmSha,
          },
          {
            filename: `setup-sandcastle-queue-skill-${manifest.version}.tgz`,
            kind: "skill",
            sha256: skillSha,
          },
        ],
        manifest,
        tag: manifest.tag,
        targetCommitish: candidateSha,
      },
      npm: {
        contents: [...packageContents],
        filename: `setup-sandcastle-queue-${manifest.version}.tgz`,
        manifest,
        name: "setup-sandcastle-queue",
        sha256: npmSha,
        version: manifest.version,
      },
      skillSnapshot: {
        contents: [...packageContents],
        filename: `setup-sandcastle-queue-skill-${manifest.version}.tgz`,
        manifest,
        sha256: skillSha,
        version: manifest.version,
      },
    },
    candidateSha,
    gates: {
      batchDogfood: gateEvidence("batch-dogfood", "9704"),
      credentialless: gateEvidence("credentialless", "9701"),
      legacyDogfood: gateEvidence("legacy-dogfood", "9703"),
      liveE2E: gateEvidence("live-e2e", "9702"),
    },
    schemaVersion: 1,
    tag: manifest.tag,
  };
}

test("release gate accepts one candidate-bound SemVer across all distributions", async () => {
  const release = await import("../dist/index.js");
  const input = await validInput();
  const result = release.evaluateReleaseBundleGate(input, releaseEnvironment);

  assert.equal(result.ok, true);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.tag, "1.0.0");
  assert.equal(result.version, "1.0.0");
  assert.equal(result.image, release.CONTROL_PLANE_IMAGE);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.gates, {
    batchDogfoodRunId: "9704",
    credentiallessRunId: "9701",
    dogfoodVersion: "0.1.0",
    legacyDogfoodRunId: "9703",
    liveE2ERunId: "9702",
  });
});

test("release gate fails closed without all candidate-bound CI, live, and dogfood gates", async () => {
  const release = await import("../dist/index.js");
  const input = await validInput();
  input.gates.credentialless.candidateSha = "b".repeat(40);
  input.gates.liveE2E.conclusion = "failure";
  input.gates.legacyDogfood.testedVersion = "0.2.0";
  input.gates.batchDogfood.candidateSha = "b".repeat(40);

  const result = release.evaluateReleaseBundleGate(input, releaseEnvironment);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    [
      "RELEASE_CREDENTIALLESS_GATE_INVALID",
      "RELEASE_LIVE_E2E_GATE_INVALID",
      "RELEASE_LEGACY_DOGFOOD_GATE_INVALID",
      "RELEASE_BATCH_DOGFOOD_GATE_INVALID",
    ],
  );
});

test("release gate rejects mismatched artifacts and never retains untrusted payloads", async () => {
  const release = await import("../dist/index.js");
  const input = await validInput();
  const secret = "npm-token-from-untrusted-build-output";
  input.artifacts.npm.contents.push("src/private-release-helper.ts");
  input.artifacts.npm.upstreamError = secret;
  input.artifacts.controlPlaneImage.digest = `sha256:${"f".repeat(64)}`;

  const result = release.evaluateReleaseBundleGate(input, releaseEnvironment);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["RELEASE_NPM_ARTIFACT_INVALID", "RELEASE_IMAGE_ARTIFACT_INVALID"],
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("release gate runs only in the dedicated credentialless manual job", async () => {
  const release = await import("../dist/index.js");
  const input = await validInput();
  const wrongEvent = release.evaluateReleaseBundleGate(input, {
    ...releaseEnvironment,
    GITHUB_EVENT_NAME: "push",
  });
  const exposedSecret = release.evaluateReleaseBundleGate(input, {
    ...releaseEnvironment,
    NPM_TOKEN: "must-not-enter-release-gate",
  });

  assert.deepEqual(
    wrongEvent.diagnostics.map(({ code }) => code),
    ["RELEASE_GATE_CONTEXT_INVALID"],
  );
  assert.deepEqual(
    exposedSecret.diagnostics.map(({ code }) => code),
    ["RELEASE_GATE_SECRET_EXPOSED"],
  );
});

test("release workflow and target template pin the immutable control-plane image", async () => {
  const release = await import("../dist/index.js");
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const dockerfile = readFileSync(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  const releaseNotes = readFileSync(
    new URL("../RELEASE_NOTES.md", import.meta.url),
    "utf8",
  );
  const templates = readFileSync(
    new URL("../src/installer/templates.ts", import.meta.url),
    "utf8",
  );
  const trigger = workflow.match(/\non:\n([\s\S]*?)\npermissions:/u)?.[1] ?? "";

  assert.match(trigger, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(trigger, /^  (?:pull_request|push|schedule):/mu);
  assert.match(workflow, /verify-release-bundle/u);
  assert.match(workflow, /verify-fixture-matrix/u);
  assert.match(workflow, /verify-live-e2e/u);
  assert.match(workflow, /verify-legacy-dogfood/u);
  assert.match(workflow, /verify-batch-dogfood/u);
  assert.match(workflow, /legacy_dogfood_run_id/u);
  assert.match(workflow, /batch_dogfood_run_id/u);
  assert.match(workflow, /dogfood_release_version/u);
  assert.match(workflow, /npm publish/u);
  assert.match(workflow, /gh release create/u);
  assert.match(workflow, /--target "\$CANDIDATE_SHA"/u);
  assert.match(workflow, /--notes-file RELEASE_NOTES\.md/u);
  assert.match(workflow, /ghcr\.io\/troymayrain\/setup-sandcastle-queue-control-plane/u);
  assert.match(workflow, /claude[^\n]*--version/u);
  assert.match(workflow, /environment: release/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(
    dockerfile,
    /FROM node:22\.22\.2-bookworm-slim@sha256:[a-f0-9]{64}/u,
  );
  assert.match(dockerfile, /@anthropic-ai\/claude-code/u);
  assert.match(dockerfile, /2\.1\.217/u);
  assert.match(
    dockerfile,
    /snapshot\.debian\.org\/archive\/debian\/\$\{DEBIAN_SNAPSHOT\}/u,
  );
  assert.match(dockerfile, /DEBIAN_SNAPSHOT=20260722T000000Z/u);
  assert.match(dockerfile, /org\.opencontainers\.image\.version="1\.0\.0"/u);
  assert.match(dockerfile, /npm ci --ignore-scripts/u);
  assert.match(dockerfile, /USER node/u);
  assert.doesNotMatch(`${workflow}\n${dockerfile}\n${templates}`, /:latest\b/u);
  assert.match(templates, /ghcr\.io\/troymayrain\/setup-sandcastle-queue-control-plane@sha256:/u);
  assert.match(release.CONTROL_PLANE_IMAGE, /@sha256:[a-f0-9]{64}$/u);
  assert.match(releaseNotes, /支持边界/u);
  assert.match(releaseNotes, /已知限制/u);
  assert.match(releaseNotes, /安全模型/u);
  assert.match(releaseNotes, /0\.1\.x/u);
});
