import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("npm package contains only the replacement CLI surface", () => {
  const packageMetadata = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal("exports" in packageMetadata, false);
  assert.deepEqual(packageMetadata.bin, {
    "sandcastle-queue": "./dist/cli.js",
  });

  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { encoding: "utf8" },
    ),
  );
  const paths = packed[0].files.map(({ path }) => path).sort();
  const templatePaths = execFileSync(
    "git",
    ["ls-files", "assets/queue-template/tool"],
    { encoding: "utf8" },
  ).trim().split("\n");
  const mvpOutputs = [
    "config",
    "doctor",
    "errors",
    "github",
    "installer",
    "template",
  ].flatMap((name) => [
    `dist/mvp/${name}.d.ts`,
    `dist/mvp/${name}.js`,
    `dist/mvp/${name}.js.map`,
  ]);
  const expected = [
    "LICENSE",
    "OPERATIONS.md",
    "README.md",
    "dist/canonical-json.js",
    "dist/cli.js",
    "dist/hash.js",
    "dist/version.js",
    "package.json",
    "schema/mvp-config.schema.json",
    ...mvpOutputs,
    ...templatePaths,
  ].sort();

  assert.deepEqual(paths, expected);
});
