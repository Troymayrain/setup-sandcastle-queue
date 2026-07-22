import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function createRepository(prefix) {
  const repository = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, ".python-version"), "3.12.8\n");
  return repository;
}

function createPipRepository() {
  const repository = createRepository("sandcastle-python-pip-");
  writeFileSync(
    join(repository, "requirements.txt"),
    "pytest==8.3.5\nmypy==1.14.1\nruff==0.9.3\n",
  );
  return repository;
}

function createUvRepository() {
  const repository = createRepository("sandcastle-python-uv-");
  writeFileSync(
    join(repository, "pyproject.toml"),
    `[project]
name = "fixture"
version = "1.0.0"
requires-python = "==3.12.8"
dependencies = ["pytest==8.3.5", "ruff==0.9.3"]
`,
  );
  writeFileSync(
    join(repository, "uv.lock"),
    `version = 1
revision = 1
requires-python = "==3.12.8"

[[package]]
name = "fixture"
version = "1.0.0"

[[package]]
name = "pytest"
version = "8.3.5"

[[package]]
name = "ruff"
version = "0.9.3"
`,
  );
  return repository;
}

function successfulRuntime(stdoutForEnvironment = "") {
  const calls = [];
  return {
    calls,
    runtime: {
      async run(command, phase) {
        calls.push({ command, phase });
        return {
          exitCode: 0,
          stdout: phase === "environment" ? stdoutForEnvironment : "",
        };
      },
    },
  };
}

test("python-pip plans exact direct dependencies and records the complete resolved environment", async () => {
  const { executeRuntimeAdapter, proposeRuntime } = await import(
    "../dist/index.js"
  );
  const proposal = await proposeRuntime(createPipRepository());

  assert.deepEqual(proposal.runtime, {
    adapter: "python-pip",
    confirmed: false,
    signals: [".python-version"],
    version: "3.12.8",
  });
  assert.deepEqual(proposal.commands, {
    tests: [{ argv: ["python", "-m", "pytest"] }],
    verification: [
      { argv: ["python", "-m", "mypy", "."] },
      { argv: ["python", "-m", "ruff", "check", "."] },
    ],
  });
  assert.deepEqual(
    {
      ...proposal.adapterPlan,
      environment: {
        ...proposal.adapterPlan.environment,
        inputs: proposal.adapterPlan.environment.inputs.map(({ path, sha256 }) => ({
          path,
          sha256: /^[a-f0-9]{64}$/u.test(sha256),
        })),
      },
    },
    {
      bootstrap: [
        {
          argv: [
            "python",
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--requirement",
            "requirements.txt",
          ],
        },
      ],
      environment: {
        inputs: [{ path: "requirements.txt", sha256: true }],
        probe: { argv: ["python", "-m", "pip", "freeze", "--all"] },
      },
      networkHosts: ["files.pythonhosted.org", "pypi.org"],
    },
  );

  const first = successfulRuntime(
    "mypy==1.14.1\npytest==8.3.5\nruff==0.9.3\ntransitive==4.2.0\n",
  );
  const bootstrapped = await executeRuntimeAdapter(
    proposal,
    { mode: "bootstrap" },
    first.runtime,
  );
  assert.equal(bootstrapped.status, "completed");
  assert.match(bootstrapped.environmentHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(first.calls.map(({ phase }) => phase), [
    "bootstrap",
    "environment",
    "tests",
    "verification",
    "verification",
  ]);

  const continuation = successfulRuntime(
    "mypy==1.14.1\npytest==8.3.5\nruff==0.9.3\ntransitive==4.3.0\n",
  );
  const drifted = await executeRuntimeAdapter(
    proposal,
    {
      expectedEnvironmentHash: bootstrapped.environmentHash,
      mode: "continuation",
    },
    continuation.runtime,
  );
  assert.equal(drifted.status, "environment-drift");
  assert.notEqual(drifted.environmentHash, bootstrapped.environmentHash);
  assert.deepEqual(continuation.calls.map(({ phase }) => phase), ["environment"]);
});

test("python-pip rejects ranges and unsafe requirement indirection", async () => {
  const { ConfigurationError, proposeRuntime } = await import("../dist/index.js");
  for (const requirement of ["pytest>=8.3.5\n", "-r shared.txt\n"]) {
    const repository = createPipRepository();
    writeFileSync(join(repository, "requirements.txt"), requirement);
    await assert.rejects(proposeRuntime(repository), (error) => {
      assert.equal(error instanceof ConfigurationError, true);
      assert.equal(error.diagnostics[0]?.code, "PIP_DEPENDENCY_NOT_EXACT");
      return true;
    });
  }
});

test("python-uv requires a valid lock and uses frozen mode for every phase", async () => {
  const { executeRuntimeAdapter, proposeRuntime } = await import(
    "../dist/index.js"
  );
  const repository = createUvRepository();
  const proposal = await proposeRuntime(repository);

  assert.equal(proposal.runtime.adapter, "python-uv");
  assert.deepEqual(proposal.adapterPlan.bootstrap, [
    { argv: ["uv", "sync", "--frozen"] },
  ]);
  assert.deepEqual(proposal.adapterPlan.networkHosts, [
    "files.pythonhosted.org",
    "pypi.org",
  ]);
  assert.equal(proposal.adapterPlan.environment.probe, undefined);
  assert.deepEqual(proposal.commands, {
    tests: [{ argv: ["uv", "run", "--frozen", "pytest"] }],
    verification: [
      { argv: ["uv", "run", "--frozen", "ruff", "check", "."] },
    ],
  });

  const first = successfulRuntime();
  const bootstrapped = await executeRuntimeAdapter(
    proposal,
    { mode: "bootstrap" },
    first.runtime,
  );
  assert.equal(bootstrapped.status, "completed");
  assert.deepEqual(first.calls.map(({ phase }) => phase), [
    "bootstrap",
    "tests",
    "verification",
  ]);

  writeFileSync(
    join(repository, "uv.lock"),
    `version = 1
revision = 1
requires-python = "==3.12.8"

[[package]]
name = "fixture"
version = "1.0.0"

[[package]]
name = "pytest"
version = "8.4.0"

[[package]]
name = "ruff"
version = "0.9.3"
`,
  );
  const changedProposal = await proposeRuntime(repository);
  const continuation = successfulRuntime();
  const drifted = await executeRuntimeAdapter(
    changedProposal,
    {
      expectedEnvironmentHash: bootstrapped.environmentHash,
      mode: "continuation",
    },
    continuation.runtime,
  );
  assert.equal(drifted.status, "environment-drift");
  assert.deepEqual(continuation.calls, []);
});

test("python-uv fails closed for a missing or malformed lock", async () => {
  const { ConfigurationError, proposeRuntime } = await import("../dist/index.js");
  const missing = createUvRepository();
  rmSync(join(missing, "uv.lock"));
  await assert.rejects(proposeRuntime(missing), (error) => {
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.diagnostics[0]?.code, "UV_LOCK_REQUIRED");
    return true;
  });

  const malformed = createUvRepository();
  writeFileSync(join(malformed, "uv.lock"), "version = 1\n[[package]]\nname = \"pytest\"\n");
  await assert.rejects(proposeRuntime(malformed), (error) => {
    assert.equal(error instanceof ConfigurationError, true);
    assert.equal(error.diagnostics[0]?.code, "UV_LOCK_INVALID");
    return true;
  });
});

test("adapter command failure is sanitized and stops later phases", async () => {
  const { InfrastructureError, executeRuntimeAdapter, proposeRuntime } =
    await import("../dist/index.js");
  const proposal = await proposeRuntime(createPipRepository());
  const calls = [];
  await assert.rejects(
    executeRuntimeAdapter(proposal, { mode: "bootstrap" }, {
      async run(command, phase) {
        calls.push({ command, phase });
        return {
          exitCode: phase === "bootstrap" ? 7 : 0,
          stdout: "secret resolver output",
        };
      },
    }),
    (error) => {
      assert.equal(error instanceof InfrastructureError, true);
      assert.deepEqual(error.diagnostics, [
        {
          code: "RUNTIME_BOOTSTRAP_FAILED",
          message: "The runtime adapter bootstrap command failed.",
        },
      ]);
      assert.equal(JSON.stringify(error).includes("secret resolver output"), false);
      return true;
    },
  );
  assert.deepEqual(calls.map(({ phase }) => phase), ["bootstrap"]);
});
