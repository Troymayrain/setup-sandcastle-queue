import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeIntegrationHost } from "../dist/host-boundary.js";

function git(repository, arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repository,
    encoding: "utf8",
  }).trim();
}

test("Host adopts one attributable dirty Final Fix worktree as a linear commit", async (t) => {
  const repository = mkdtempSync(join(tmpdir(), "queue-final-fix-adopt-"));
  t.after(() => rmSync(repository, { force: true, recursive: true }));
  git(repository, ["init", "--initial-branch=main"]);
  mkdirSync(join(repository, ".sandcastle", "worktrees"), { recursive: true });
  writeFileSync(join(repository, "app.txt"), "before\n");
  git(repository, ["add", "--all"]);
  git(repository, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  const expectedHead = git(repository, ["rev-parse", "HEAD"]);
  const branch = "sandcastle/queue-final-fix/fixture";
  const preservedWorktreePath = join(
    repository,
    ".sandcastle",
    "worktrees",
    "candidate",
  );
  git(repository, [
    "worktree",
    "add",
    "-b",
    branch,
    preservedWorktreePath,
    expectedHead,
  ]);
  writeFileSync(join(preservedWorktreePath, "app.txt"), "after\n");

  const host = new NodeIntegrationHost(
    repository,
    {
      GITHUB_REPOSITORY: "acme/widget",
      GITHUB_TOKEN: "github-token",
    },
    {},
  );
  const adoptedHead = await host.adoptFinalFixChanges({
    branch,
    expectedHead,
    preservedWorktreePath,
  });

  assert.equal(git(repository, ["rev-parse", "HEAD"]), adoptedHead);
  assert.equal(
    git(repository, ["show", "--no-patch", "--format=%P", adoptedHead]),
    expectedHead,
  );
  assert.equal(git(repository, ["rev-list", "--count", `${expectedHead}..HEAD`]), "1");
  assert.equal(git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(existsSync(preservedWorktreePath), false);
  assert.throws(
    () => git(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]),
  );
});

test("Host rejects an unregistered repository inside the worktree directory", async (t) => {
  const repository = mkdtempSync(join(tmpdir(), "queue-final-fix-forged-"));
  t.after(() => rmSync(repository, { force: true, recursive: true }));
  git(repository, ["init", "--initial-branch=main"]);
  const worktrees = join(repository, ".sandcastle", "worktrees");
  mkdirSync(worktrees, { recursive: true });
  writeFileSync(join(repository, "app.txt"), "before\n");
  git(repository, ["add", "--all"]);
  git(repository, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  const expectedHead = git(repository, ["rev-parse", "HEAD"]);
  const branch = "sandcastle/queue-final-fix/forged";
  const preservedWorktreePath = join(worktrees, "forged");
  git(repository, ["clone", "--no-hardlinks", repository, preservedWorktreePath]);
  git(preservedWorktreePath, ["checkout", "-b", branch, expectedHead]);
  writeFileSync(join(preservedWorktreePath, "app.txt"), "forged\n");
  const host = new NodeIntegrationHost(
    repository,
    { GITHUB_REPOSITORY: "acme/widget", GITHUB_TOKEN: "github-token" },
    {},
  );

  await assert.rejects(
    host.adoptFinalFixChanges({ branch, expectedHead, preservedWorktreePath }),
    /registered Final Fix worktree/u,
  );
  assert.equal(git(repository, ["rev-parse", "HEAD"]), expectedHead);

  const outsideRoot = mkdtempSync(join(tmpdir(), "queue-final-fix-outside-"));
  t.after(() => rmSync(outsideRoot, { force: true, recursive: true }));
  const outsidePath = join(outsideRoot, "candidate");
  const outsideBranch = "sandcastle/queue-final-fix/outside";
  git(repository, ["clone", "--no-hardlinks", repository, outsidePath]);
  git(outsidePath, ["checkout", "-b", outsideBranch, expectedHead]);
  writeFileSync(join(outsidePath, "app.txt"), "outside\n");
  await assert.rejects(
    host.adoptFinalFixChanges({
      branch: outsideBranch,
      expectedHead,
      preservedWorktreePath: outsidePath,
    }),
    /outside the Queue boundary/u,
  );
  assert.equal(git(repository, ["rev-parse", "HEAD"]), expectedHead);
});

test("Host cleans up a registered Final Fix worktree rejected as clean", async (t) => {
  const repository = mkdtempSync(join(tmpdir(), "queue-final-fix-clean-"));
  t.after(() => rmSync(repository, { force: true, recursive: true }));
  git(repository, ["init", "--initial-branch=main"]);
  mkdirSync(join(repository, ".sandcastle", "worktrees"), { recursive: true });
  writeFileSync(join(repository, "app.txt"), "before\n");
  git(repository, ["add", "--all"]);
  git(repository, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  const expectedHead = git(repository, ["rev-parse", "HEAD"]);
  const branch = "sandcastle/queue-final-fix/clean";
  const preservedWorktreePath = join(
    repository,
    ".sandcastle",
    "worktrees",
    "clean",
  );
  git(repository, [
    "worktree",
    "add",
    "-b",
    branch,
    preservedWorktreePath,
    expectedHead,
  ]);
  const host = new NodeIntegrationHost(
    repository,
    { GITHUB_REPOSITORY: "acme/widget", GITHUB_TOKEN: "github-token" },
    {},
  );

  await assert.rejects(
    host.adoptFinalFixChanges({
      branch,
      expectedHead: "0".repeat(40),
      preservedWorktreePath,
    }),
    /registered Final Fix worktree/u,
  );
  await assert.rejects(
    host.adoptFinalFixChanges({
      branch: "sandcastle/queue-final-fix/wrong",
      expectedHead,
      preservedWorktreePath,
    }),
    /registered Final Fix worktree/u,
  );
  assert.equal(existsSync(preservedWorktreePath), true);

  await assert.rejects(
    host.adoptFinalFixChanges({ branch, expectedHead, preservedWorktreePath }),
    /cannot be attributed/u,
  );
  assert.equal(existsSync(preservedWorktreePath), false);
  assert.throws(
    () => git(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]),
  );
  assert.equal(git(repository, ["rev-parse", "HEAD"]), expectedHead);
});
