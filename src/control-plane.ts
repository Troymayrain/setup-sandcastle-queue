#!/usr/bin/env node

import { runCredentialBrokerProcess } from "./broker/server.js";
import { VERSION } from "./version.js";

const [command] = process.argv.slice(2);

if (!command || command === "version" || command === "--version") {
  process.stdout.write(`${VERSION}\n`);
} else if (command === "credential-broker") {
  await runCredentialBrokerProcess();
} else {
  process.stderr.write(
    "The requested Sandcastle control-plane operation is not available in this release.\n",
  );
  process.exitCode = 2;
}
