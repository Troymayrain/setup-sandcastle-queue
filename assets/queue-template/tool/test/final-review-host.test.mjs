import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeFinalReviewHost } from "../dist/host-boundary.js";

function git(cwd, arguments_) {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

test("temporary Final Review merge applies Integration HEAD onto latest base", async () => {
  const root = mkdtempSync(join(tmpdir(), "queue-final-review-host-"));
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repository, "shared.txt"), "common\n");
  git(repository, ["add", "shared.txt"]);
  git(repository, ["commit", "-m", "common"]);
  git(repository, ["branch", "sandcastle/integration"]);

  writeFileSync(join(repository, "base.txt"), "latest base\n");
  git(repository, ["add", "base.txt"]);
  git(repository, ["commit", "-m", "latest base"]);
  const baseHead = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["switch", "sandcastle/integration"]);
  writeFileSync(join(repository, "integration.txt"), "queue work\n");
  git(repository, ["add", "integration.txt"]);
  git(repository, ["commit", "-m", "queue work"]);
  const integrationHead = git(repository, ["rev-parse", "HEAD"]);
  git(repository, [
    "push",
    remote,
    "main:refs/heads/main",
    "sandcastle/integration:refs/heads/sandcastle/integration",
  ]);

  const host = new NodeFinalReviewHost(
    repository,
    {
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "github-secret",
    },
    {},
    remote,
  );
  const temporary = await host.createTemporaryMerge({
    baseBranch: "main",
    expectedIntegrationHead: integrationHead,
    integrationBranch: "sandcastle/integration",
  });
  try {
    assert.equal(temporary.baseHead, baseHead);
    assert.equal(temporary.integrationHead, integrationHead);
    assert.deepEqual(
      git(temporary.path, ["show", "--no-patch", "--format=%P", "HEAD"]).split(
        " ",
      ),
      [baseHead, integrationHead],
    );
    assert.equal(await temporary.includes(integrationHead), true);
    assert.equal(await temporary.includes("f".repeat(40)), false);
    assert.equal(await temporary.unchanged(), true);
  } finally {
    await temporary.remove();
  }
  assert.equal(existsSync(temporary.path), false);
  assert.equal(
    git(repository, ["rev-parse", "sandcastle/integration"]),
    integrationHead,
  );
});
