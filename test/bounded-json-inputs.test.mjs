import assert from "node:assert/strict";
import {
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("untrusted JSON input readers reject symbolic links", async () => {
  const api = await import("../dist/index.js");
  const directory = mkdtempSync(join(tmpdir(), "sandcastle-bounded-json-"));
  const target = join(directory, "target.json");
  const link = join(directory, "input.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, link);

  for (const [reader, code] of [
    [api.readReleaseBundleGateInput, "RELEASE_GATE_INPUT_UNAVAILABLE"],
    [api.readLiveE2EReleaseGateInput, "LIVE_E2E_INPUT_UNAVAILABLE"],
    [api.readLegacyDogfoodGateInput, "LEGACY_DOGFOOD_INPUT_UNAVAILABLE"],
    [api.readBatchDogfoodGateInput, "BATCH_DOGFOOD_INPUT_UNAVAILABLE"],
    [
      api.readCredentiallessFixtureMatrixInput,
      "CREDENTIALLESS_CI_INPUT_UNAVAILABLE",
    ],
  ]) {
    await assert.rejects(
      reader(link),
      (error) =>
        error instanceof api.ConfigurationError &&
        error.diagnostics.map((diagnostic) => diagnostic.code).includes(code),
      code,
    );
  }

  for (const [reader, errorType, code] of [
    [api.readProjectConfig, api.InfrastructureError, "CONFIG_READ_FAILED"],
    [api.readInstallPlan, api.InfrastructureError, "PLAN_READ_FAILED"],
    [
      api.readUninstallPlan,
      api.ConfigurationError,
      "UNINSTALL_PLAN_READ_FAILED",
    ],
    [api.readSpecSnapshot, api.ConfigurationError, "SPEC_SNAPSHOT_INVALID"],
  ]) {
    await assert.rejects(
      reader(link),
      (error) =>
        error instanceof errorType &&
        error.diagnostics.some((diagnostic) => diagnostic.code === code),
      code,
    );
  }

  await assert.rejects(
    api.readTicketPublicationInputs(link, link),
    (error) =>
      error instanceof api.ConfigurationError &&
      error.diagnostics.some(
        (diagnostic) => diagnostic.code === "PUBLICATION_INPUT_INVALID",
      ),
  );
});
