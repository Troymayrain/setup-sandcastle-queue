import { runCredentiallessFixtureLifecycle } from "./credentialless-fixture-lib.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const fixture = option("--fixture");
const candidateSha = option("--candidate-sha");
const output = option("--output");

try {
  await runCredentiallessFixtureLifecycle({ candidateSha, fixture, output });
} catch {
  process.stderr.write("Credentialless fixture lifecycle failed.\n");
  process.exitCode = 1;
}
