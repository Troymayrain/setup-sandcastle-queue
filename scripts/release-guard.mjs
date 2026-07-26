import process from "node:process";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const value = option(name);
  if (value === undefined) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

export function assertCandidateCheckout(candidate, actual) {
  if (!/^[a-f0-9]{40}$/u.test(candidate)) {
    throw new Error("candidate SHA must be a full lowercase commit SHA");
  }
  if (actual !== candidate) {
    throw new Error("checked-out commit does not match candidate SHA");
  }
}

export function assertCandidateIsCurrentMain(candidate, actual, main) {
  assertCandidateCheckout(candidate, actual);
  if (main !== candidate) {
    throw new Error("candidate SHA is no longer current main");
  }
}

export function classifyPublishedIntegrity(expected, published) {
  if (published === "") {
    return "absent";
  }
  if (published !== expected) {
    throw new Error("npm version already exists with different integrity");
  }
  return "exact";
}

export function classifyTag(candidate, existing) {
  if (existing === "") {
    return "create";
  }
  if (existing !== candidate) {
    throw new Error("release tag already points to a different commit");
  }
  return "exact";
}

function main() {
  const command = process.argv[2];
  if (command === "candidate") {
    assertCandidateIsCurrentMain(
      required("--candidate"),
      required("--actual"),
      required("--main"),
    );
    return;
  }
  if (command === "checkout") {
    assertCandidateCheckout(required("--candidate"), required("--actual"));
    return;
  }
  if (command === "registry") {
    process.stdout.write(
      `${classifyPublishedIntegrity(required("--expected"), required("--published"))}\n`,
    );
    return;
  }
  if (command === "tag") {
    process.stdout.write(
      `${classifyTag(required("--candidate"), required("--existing"))}\n`,
    );
    return;
  }
  throw new Error(
    "Usage: release-guard.mjs <candidate|checkout|registry|tag> [options]",
  );
}

if (process.argv[1]?.endsWith("release-guard.mjs")) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
