import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("candidate tarball passes the clean-install user-path smoke", () => {
  const temporary = mkdtempSync(join(tmpdir(), "sandcastle-queue-candidate-"));
  try {
    const packed = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
        { encoding: "utf8" },
      ),
    );
    const tarball = join(temporary, packed[0].filename);
    const smoke = spawnSync(
      process.execPath,
      [
        "test/release-smoke.mjs",
        "--package",
        tarball,
        "--expected-version",
        "1.0.0",
      ],
      { encoding: "utf8" },
    );
    assert.equal(smoke.status, 0, smoke.stderr);
    assert.deepEqual(JSON.parse(smoke.stdout), {
      ok: true,
      package: tarball,
      version: "1.0.0",
    });
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
});
