import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ConfigurationError,
  InfrastructureError,
  type CommandSpec,
} from "../config.js";
import { sha256 } from "../hash.js";
import { resolveRepositoryRoot } from "../installer/plan.js";

export type BuiltInAdapter =
  | "go-module"
  | "java-maven"
  | "node-npm"
  | "python-pip"
  | "python-uv";

export interface RuntimeProposal {
  adapterPlan?: RuntimeAdapterPlan;
  commands: {
    tests: CommandSpec[];
    verification: CommandSpec[];
  };
  runtime: {
    adapter: BuiltInAdapter;
    confirmed: boolean;
    signals: string[];
    version: string;
  };
}

export interface RuntimeEnvironmentInput {
  path: string;
  sha256: string;
}

export interface RuntimeAdapterPlan {
  bootstrap: CommandSpec[];
  environment: {
    inputs: RuntimeEnvironmentInput[];
    probe?: CommandSpec;
  };
  networkHosts: string[];
}

interface RuntimeConfirmation {
  adapter: BuiltInAdapter;
  version: string;
}

function detectionError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "/runtime" }]);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function exactVersion(value: string): string | null {
  const normalized = value.trim().replace(/^={1,2}/u, "").replace(/^v/u, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
    normalized,
  )
    ? normalized
    : null;
}

function pythonDependencyName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?$/u.test(
    value,
  );
}

function pythonDependencyVersion(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9.!+_-]*$/u.test(value) &&
    !value.includes("*")
  );
}

function assertExactPipRequirements(source: string): void {
  const requirements = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (
    requirements.length === 0 ||
    requirements.some((line) => {
      const equality = line.indexOf("==");
      return (
        equality <= 0 ||
        line.indexOf("==", equality + 2) >= 0 ||
        !pythonDependencyName(line.slice(0, equality)) ||
        !pythonDependencyVersion(line.slice(equality + 2))
      );
    })
  ) {
    throw detectionError(
      "PIP_DEPENDENCY_NOT_EXACT",
      "Python/pip direct dependencies must use exact name==version requirements.",
    );
  }
}

function assertValidUvLock(source: string): void {
  const version = source.match(/^version\s*=\s*([0-9]+)\s*$/mu)?.[1];
  const packages = source.split(/^\[\[package\]\]\s*$/mu).slice(1);
  if (
    version !== "1" ||
    packages.length === 0 ||
    packages.some((block) => {
      const name = block.match(/^name\s*=\s*["']([^"']+)["']\s*$/mu)?.[1];
      const packageVersion = block.match(
        /^version\s*=\s*["']([^"']+)["']\s*$/mu,
      )?.[1];
      return (
        !name ||
        !pythonDependencyName(name) ||
        !packageVersion ||
        !pythonDependencyVersion(packageVersion)
      );
    })
  ) {
    throw detectionError(
      "UV_LOCK_INVALID",
      "Python/uv requires a valid versioned lock with exact package versions.",
    );
  }
}

function environmentInput(path: string, source: string): RuntimeEnvironmentInput {
  return { path, sha256: sha256(source) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertValidNpmLock(
  source: string,
  packageName: unknown,
): void {
  let candidate: unknown;
  try {
    candidate = JSON.parse(source) as unknown;
  } catch {
    candidate = null;
  }
  if (
    !isRecord(candidate) ||
    (candidate.lockfileVersion !== 2 && candidate.lockfileVersion !== 3) ||
    !isRecord(candidate.packages) ||
    (typeof packageName === "string" &&
      typeof candidate.name === "string" &&
      candidate.name !== packageName)
  ) {
    throw detectionError(
      "NPM_LOCK_INVALID",
      "Node/npm requires a supported package lock matching the application manifest.",
    );
  }
}

interface GoRequirement {
  module: string;
  version: string;
}

function validGoModulePath(value: string): boolean {
  return (
    value.length <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._~+/-]*$/u.test(value) &&
    !value.includes("..")
  );
}

function exactGoModuleVersion(value: string): boolean {
  return /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
    value,
  );
}

function parseGoRequirements(source: string): GoRequirement[] {
  const requirements: GoRequirement[] = [];
  let inBlock = false;
  for (const sourceLine of source.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line === "require (") {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const candidate = inBlock
      ? line
      : line.startsWith("require ")
        ? line.slice("require ".length).trim()
        : null;
    if (candidate === null || candidate.length === 0 || candidate.startsWith("//")) {
      continue;
    }
    const fields = candidate.replace(/\s+\/\/\s+indirect$/u, "").split(/\s+/u);
    if (
      fields.length !== 2 ||
      !fields[0] ||
      !fields[1] ||
      !validGoModulePath(fields[0]) ||
      !exactGoModuleVersion(fields[1])
    ) {
      throw detectionError(
        "GO_MODULE_INVALID",
        "Go module requirements must use exact module versions.",
      );
    }
    requirements.push({ module: fields[0], version: fields[1] });
  }
  if (inBlock) {
    throw detectionError(
      "GO_MODULE_INVALID",
      "The Go module requirement block is incomplete.",
    );
  }
  return requirements;
}

function assertValidGoSum(source: string, requirements: GoRequirement[]): void {
  const checksums = new Set<string>();
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.some((line) => {
      const match = line.match(
        /^(\S+) (v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\/go\.mod)? h1:[A-Za-z0-9+/]{43}=$/u,
      );
      if (!match?.[1] || !match[2] || !validGoModulePath(match[1])) return true;
      checksums.add(`${match[1]}@${match[2]}`);
      return false;
    }) ||
    requirements.some(
      ({ module, version }) => !checksums.has(`${module}@${version}`),
    )
  ) {
    throw detectionError(
      "GO_SUM_INVALID",
      "go.sum must contain valid module checksums for every required dependency.",
    );
  }
}

async function nodeProposal(
  repository: string,
  confirmation?: RuntimeConfirmation,
): Promise<RuntimeProposal | null> {
  const lockPath = join(repository, "package-lock.json");
  const packagePath = join(repository, "package.json");
  if (!(await pathExists(packagePath))) {
    return null;
  }
  if (!(await pathExists(lockPath))) {
    throw detectionError(
      "NPM_LOCK_REQUIRED",
      "Node/npm projects require package-lock.json for reproducible execution.",
    );
  }

  let packageMetadata: {
    engines?: { node?: unknown };
    name?: unknown;
    scripts?: Record<string, unknown>;
  };
  let packageSource: string;
  try {
    packageSource = await readFile(packagePath, "utf8");
    packageMetadata = JSON.parse(packageSource) as typeof packageMetadata;
  } catch {
    throw detectionError(
      "RUNTIME_METADATA_INVALID",
      "package.json is not valid JSON.",
    );
  }
  const lockSource = await readFile(lockPath, "utf8");
  assertValidNpmLock(lockSource, packageMetadata.name);

  const versions: Array<{ source: string; version: string }> = [];
  let hasInvalidVersionDeclaration = false;
  const nvmrcPath = join(repository, ".nvmrc");
  if (await pathExists(nvmrcPath)) {
    const version = exactVersion(await readFile(nvmrcPath, "utf8"));
    if (version) {
      versions.push({ source: ".nvmrc", version });
    } else {
      hasInvalidVersionDeclaration = true;
    }
  }
  if (typeof packageMetadata.engines?.node === "string") {
    const version = exactVersion(packageMetadata.engines.node);
    if (version) {
      versions.push({ source: "package.json#engines.node", version });
    } else {
      hasInvalidVersionDeclaration = true;
    }
  } else if (packageMetadata.engines?.node !== undefined) {
    hasInvalidVersionDeclaration = true;
  }
  if (hasInvalidVersionDeclaration) {
    throw detectionError(
      "RUNTIME_VERSION_INVALID",
      "Every detected runtime declaration must use an exact x.y.z version.",
    );
  }

  const distinctVersions = [...new Set(versions.map(({ version }) => version))];
  if (
    confirmation &&
    (confirmation.adapter !== "node-npm" ||
      !distinctVersions.includes(confirmation.version))
  ) {
    throw detectionError(
      "RUNTIME_CONFIRMATION_INVALID",
      "The confirmed runtime does not match a detected project declaration.",
    );
  }
  if (distinctVersions.length !== 1 && !confirmation) {
    throw detectionError(
      distinctVersions.length > 1
        ? "RUNTIME_VERSION_CONFLICT"
        : "RUNTIME_VERSION_UNDETERMINED",
      distinctVersions.length > 1
        ? "Project runtime declarations disagree on the exact Node.js version."
        : "An exact Node.js runtime version could not be determined.",
    );
  }
  if (typeof packageMetadata.scripts?.test !== "string") {
    throw detectionError(
      "MISSING_TEST_COMMAND",
      "No supported test command could be proposed for the detected runtime.",
    );
  }

  const verification = ["typecheck", "lint", "build"]
    .filter((name) => typeof packageMetadata.scripts?.[name] === "string")
    .map((name) => ({ argv: ["npm", "run", name] }));
  return {
    adapterPlan: {
      bootstrap: [{ argv: ["npm", "ci"] }],
      environment: {
        inputs: [
          environmentInput("package-lock.json", lockSource),
          environmentInput("package.json", packageSource),
        ],
      },
      networkHosts: ["registry.npmjs.org"],
    },
    commands: {
      tests: [{ argv: ["npm", "test"] }],
      verification,
    },
    runtime: {
      adapter: "node-npm",
      confirmed: confirmation !== undefined,
      signals: versions.map(({ source }) => source),
      version: confirmation?.version ?? (distinctVersions[0] as string),
    },
  };
}

async function goProposal(
  repository: string,
  confirmation?: RuntimeConfirmation,
): Promise<RuntimeProposal | null> {
  const modulePath = join(repository, "go.mod");
  if (!(await pathExists(modulePath))) return null;
  const moduleSource = await readFile(modulePath, "utf8");
  const moduleName = moduleSource.match(/^module\s+(\S+)\s*$/mu)?.[1];
  if (!moduleName || !validGoModulePath(moduleName)) {
    throw detectionError(
      "GO_MODULE_INVALID",
      "go.mod must declare one valid module path.",
    );
  }
  const requirements = parseGoRequirements(moduleSource);
  const sumPath = join(repository, "go.sum");
  const hasSum = await pathExists(sumPath);
  if (requirements.length > 0 && !hasSum) {
    throw detectionError(
      "GO_SUM_REQUIRED",
      "Go modules with dependencies require go.sum checksum evidence.",
    );
  }
  const sumSource = hasSum ? await readFile(sumPath, "utf8") : "";
  if (hasSum) assertValidGoSum(sumSource, requirements);

  const versions: Array<{ source: string; version: string }> = [];
  const goVersion = moduleSource.match(/^go\s+(\S+)\s*$/mu)?.[1];
  if (!goVersion || !exactVersion(goVersion)) {
    throw detectionError(
      "RUNTIME_VERSION_INVALID",
      "Every detected runtime declaration must use an exact x.y.z version.",
    );
  }
  versions.push({ source: "go.mod#go", version: exactVersion(goVersion)! });
  const toolchain = moduleSource.match(/^toolchain\s+go(\S+)\s*$/mu)?.[1];
  if (toolchain) {
    const version = exactVersion(toolchain);
    if (!version) {
      throw detectionError(
        "RUNTIME_VERSION_INVALID",
        "Every detected runtime declaration must use an exact x.y.z version.",
      );
    }
    versions.push({ source: "go.mod#toolchain", version });
  }
  const distinctVersions = [...new Set(versions.map(({ version }) => version))];
  if (
    confirmation &&
    (confirmation.adapter !== "go-module" ||
      !distinctVersions.includes(confirmation.version))
  ) {
    throw detectionError(
      "RUNTIME_CONFIRMATION_INVALID",
      "The confirmed runtime does not match a detected project declaration.",
    );
  }
  if (distinctVersions.length !== 1 && !confirmation) {
    throw detectionError(
      "RUNTIME_VERSION_CONFLICT",
      "Project runtime declarations disagree on the exact Go version.",
    );
  }
  return {
    adapterPlan: {
      bootstrap: [
        { argv: ["go", "mod", "download"] },
        { argv: ["go", "mod", "verify"] },
      ],
      environment: {
        inputs: [
          environmentInput("go.mod", moduleSource),
          ...(hasSum ? [environmentInput("go.sum", sumSource)] : []),
        ],
      },
      networkHosts: [
        "proxy.golang.org",
        "storage.googleapis.com",
        "sum.golang.org",
      ],
    },
    commands: {
      tests: [{ argv: ["go", "test", "./..."] }],
      verification: [{ argv: ["go", "vet", "./..."] }],
    },
    runtime: {
      adapter: "go-module",
      confirmed: confirmation !== undefined,
      signals: versions.map(({ source }) => source),
      version: confirmation?.version ?? distinctVersions[0]!,
    },
  };
}

async function pythonProposal(
  repository: string,
  confirmation?: RuntimeConfirmation,
): Promise<RuntimeProposal | null> {
  const uvLockPath = join(repository, "uv.lock");
  const requirementsPath = join(repository, "requirements.txt");
  const pyprojectPath = join(repository, "pyproject.toml");
  const hasUvLock = await pathExists(uvLockPath);
  const hasRequirements = await pathExists(requirementsPath);
  const hasPyproject = await pathExists(pyprojectPath);
  if (!hasUvLock && !hasRequirements && !hasPyproject) {
    return null;
  }
  if (!hasUvLock && hasPyproject && !hasRequirements) {
    throw detectionError(
      "UV_LOCK_REQUIRED",
      "Python/uv projects require uv.lock before execution can be proposed.",
    );
  }
  if (hasUvLock && !hasPyproject) {
    throw detectionError(
      "UV_LOCK_INVALID",
      "Python/uv requires uv.lock beside pyproject.toml.",
    );
  }
  const adapter: BuiltInAdapter = hasUvLock ? "python-uv" : "python-pip";
  const versions: Array<{ source: string; version: string }> = [];
  let hasInvalidVersionDeclaration = false;
  const pythonVersionPath = join(repository, ".python-version");
  if (await pathExists(pythonVersionPath)) {
    const version = exactVersion(await readFile(pythonVersionPath, "utf8"));
    if (version) {
      versions.push({ source: ".python-version", version });
    } else {
      hasInvalidVersionDeclaration = true;
    }
  }
  const requirements = hasRequirements
    ? await readFile(requirementsPath, "utf8")
    : "";
  if (adapter === "python-pip") {
    assertExactPipRequirements(requirements);
  }
  const pyproject = hasPyproject ? await readFile(pyprojectPath, "utf8") : "";
  const uvLock = hasUvLock ? await readFile(uvLockPath, "utf8") : "";
  if (adapter === "python-uv") {
    assertValidUvLock(uvLock);
  }
  let dependencyText = requirements;
  if (hasPyproject) {
    dependencyText += `\n${pyproject}`;
    const match = pyproject.match(/^requires-python\s*=\s*["']([^"']+)["']/mu);
    if (match?.[1]) {
      const version = exactVersion(match[1]);
      if (version) {
        versions.push({ source: "pyproject.toml#requires-python", version });
      } else {
        hasInvalidVersionDeclaration = true;
      }
    }
  }

  if (hasInvalidVersionDeclaration) {
    throw detectionError(
      "RUNTIME_VERSION_INVALID",
      "Every detected runtime declaration must use an exact x.y.z version.",
    );
  }

  const distinctVersions = [...new Set(versions.map(({ version }) => version))];
  if (
    confirmation &&
    (confirmation.adapter !== adapter ||
      !distinctVersions.includes(confirmation.version))
  ) {
    throw detectionError(
      "RUNTIME_CONFIRMATION_INVALID",
      "The confirmed runtime does not match a detected project declaration.",
    );
  }
  if (distinctVersions.length !== 1 && !confirmation) {
    throw detectionError(
      distinctVersions.length > 1
        ? "RUNTIME_VERSION_CONFLICT"
        : "RUNTIME_VERSION_UNDETERMINED",
      distinctVersions.length > 1
        ? "Project runtime declarations disagree on the exact Python version."
        : "An exact Python runtime version could not be determined.",
    );
  }
  if (!/(?:^|[^A-Za-z0-9_-])pytest(?:[^A-Za-z0-9_-]|$)/u.test(dependencyText)) {
    throw detectionError(
      "MISSING_TEST_COMMAND",
      "No supported test command could be proposed for the detected runtime.",
    );
  }

  const commandPrefix =
    adapter === "python-uv"
      ? ["uv", "run", "--frozen"]
      : ["python", "-m"];
  const verification: CommandSpec[] = [];
  if (/(?:^|[^A-Za-z0-9_-])mypy(?:[^A-Za-z0-9_-]|$)/u.test(dependencyText)) {
    verification.push({ argv: [...commandPrefix, "mypy", "."] });
  }
  if (/(?:^|[^A-Za-z0-9_-])ruff(?:[^A-Za-z0-9_-]|$)/u.test(dependencyText)) {
    verification.push({ argv: [...commandPrefix, "ruff", "check", "."] });
  }
  return {
    adapterPlan:
      adapter === "python-uv"
        ? {
            bootstrap: [{ argv: ["uv", "sync", "--frozen"] }],
            environment: {
              inputs: [
                environmentInput("pyproject.toml", pyproject),
                environmentInput("uv.lock", uvLock),
              ],
            },
            networkHosts: ["files.pythonhosted.org", "pypi.org"],
          }
        : {
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
              inputs: [environmentInput("requirements.txt", requirements)],
              probe: { argv: ["python", "-m", "pip", "freeze", "--all"] },
            },
            networkHosts: ["files.pythonhosted.org", "pypi.org"],
          },
    commands: {
      tests: [{ argv: [...commandPrefix, "pytest"] }],
      verification,
    },
    runtime: {
      adapter,
      confirmed: confirmation !== undefined,
      signals: versions.map(({ source }) => source),
      version: confirmation?.version ?? (distinctVersions[0] as string),
    },
  };
}

function parseRuntimeConfirmation(value?: string): RuntimeConfirmation | undefined {
  if (!value) {
    return undefined;
  }
  const separator = value.lastIndexOf("@");
  const adapter = value.slice(0, separator) as BuiltInAdapter;
  const version = exactVersion(value.slice(separator + 1));
  const supportedAdapters: BuiltInAdapter[] = [
    "go-module",
    "java-maven",
    "node-npm",
    "python-pip",
    "python-uv",
  ];
  if (separator <= 0 || !supportedAdapters.includes(adapter) || !version) {
    throw detectionError(
      "RUNTIME_CONFIRMATION_INVALID",
      "Runtime confirmation must use <adapter>@<exact-version>.",
    );
  }
  return { adapter, version };
}

export async function proposeRuntime(
  repository: string,
  confirmedRuntime?: string,
): Promise<RuntimeProposal> {
  let root: string;
  try {
    root = await resolveRepositoryRoot(repository);
  } catch {
    throw new InfrastructureError([
      {
        code: "REPOSITORY_INSPECTION_FAILED",
        message: "Unable to inspect the target repository runtime.",
      },
    ]);
  }
  const confirmation = parseRuntimeConfirmation(confirmedRuntime);
  if (confirmation) {
    const proposal =
      confirmation.adapter === "node-npm"
        ? await nodeProposal(root, confirmation)
        : confirmation.adapter === "go-module"
          ? await goProposal(root, confirmation)
        : confirmation.adapter === "python-pip" ||
            confirmation.adapter === "python-uv"
          ? await pythonProposal(root, confirmation)
          : null;
    if (!proposal) {
      throw detectionError(
        "RUNTIME_CONFIRMATION_INVALID",
        "The confirmed runtime adapter was not detected in the repository.",
      );
    }
    return proposal;
  }

  const proposals = (
    await Promise.all([goProposal(root), nodeProposal(root), pythonProposal(root)])
  ).filter((proposal): proposal is RuntimeProposal => proposal !== null);
  if (proposals.length > 1) {
    throw detectionError(
      "AMBIGUOUS_RUNTIME",
      "Multiple runtime adapters were detected; confirm one explicitly.",
    );
  }
  const proposal = proposals[0];
  if (!proposal) {
    throw detectionError(
      "RUNTIME_UNSUPPORTED",
      "No supported runtime adapter could be detected.",
    );
  }
  return proposal;
}
