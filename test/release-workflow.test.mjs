import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/publish.yml", "utf8");

function step(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const next = workflow.indexOf("      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

test("npm publication is manual, candidate-bound, and single-artifact", () => {

  assert.match(workflow, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  (?:push|release|workflow_run):/mu);
  assert.match(workflow, /candidate_sha:/u);
  assert.match(workflow, /release_tag:/u);
  assert.match(workflow, /node-version: 22\.22\.2/u);
  assert.equal(workflow.match(/npm pack --json/gu)?.length, 1);
  assert.equal(workflow.match(/npm publish /gu)?.length, 1);
  assert.equal(workflow.match(/NODE_AUTH_TOKEN:/gu)?.length, 1);
  assert.equal(workflow.match(/secrets\.NPM_TOKEN/gu)?.length, 1);
  assert.equal(workflow.match(/test\/release-smoke\.mjs/gu)?.length, 2);
  assert.match(workflow, /npm view "setup-sandcastle-queue@\$VERSION" dist\.integrity/u);
  assert.doesNotMatch(workflow, /ghcr\.io|docker build|gh release|skill snapshot/iu);
});

test("publish rebinds current main immediately before its npm side effect", () => {
  const publish = step("Publish the exact candidate tarball");
  assert.match(publish, /if: steps\.preflight\.outputs\.publication == 'absent'/u);
  assert.match(publish, /git ls-remote origin refs\/heads\/main/u);
  assert.match(publish, /release-guard\.mjs candidate/u);
  assert.doesNotMatch(publish, /npm view/u);
  assert.ok(
    publish.indexOf("release-guard.mjs candidate") < publish.indexOf("npm publish"),
  );
});

test("registry and tag conflicts fail before publish and tag creation", () => {
  const preflight = step("Preflight npm version and release tag");
  const publish = step("Publish the exact candidate tarball");
  const tag = step("Create or verify the candidate-bound SemVer tag");
  assert.match(preflight, /release-guard\.mjs registry/u);
  assert.match(preflight, /release-guard\.mjs tag/u);
  assert.match(preflight, /publication=.*GITHUB_OUTPUT/u);
  assert.ok(workflow.indexOf(preflight) < workflow.indexOf(publish));
  assert.ok(workflow.indexOf(publish) < workflow.indexOf(tag));
  assert.match(tag, /release-guard\.mjs checkout/u);
  assert.doesNotMatch(tag, /refs\/heads\/main|release-guard\.mjs candidate/u);
  assert.ok(tag.indexOf("release-guard.mjs checkout") < tag.indexOf("gh api"));
});

test("credentials are scoped to their only authorized side-effect steps", () => {
  const publish = step("Publish the exact candidate tarball");
  const tag = step("Create or verify the candidate-bound SemVer tag");
  assert.match(publish, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/u);
  assert.doesNotMatch(publish, /GH_TOKEN:/u);
  assert.match(tag, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.doesNotMatch(tag, /NODE_AUTH_TOKEN:|NPM_TOKEN/u);
  assert.equal(workflow.match(/NODE_AUTH_TOKEN:/gu)?.length, 1);
  assert.equal(workflow.match(/GH_TOKEN:/gu)?.length, 1);
});

test("GitHub write permission is isolated to the post-publish tag job", () => {
  const publishJob = workflow.slice(
    workflow.indexOf("  publish:\n"),
    workflow.indexOf("  tag:\n"),
  );
  const tagJob = workflow.slice(workflow.indexOf("  tag:\n"));
  assert.match(publishJob, /permissions:\n      contents: read/u);
  assert.doesNotMatch(publishJob, /contents: write/u);
  assert.match(tagJob, /needs:\n      - candidate\n      - publish/u);
  assert.match(tagJob, /permissions:\n      contents: write/u);
  assert.doesNotMatch(tagJob, /NPM_TOKEN|NODE_AUTH_TOKEN|npm publish/u);
});
