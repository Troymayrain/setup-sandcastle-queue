import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { canonicalJson } from "./canonical-json.js";
import {
  ConfigurationError,
  InfrastructureError,
  readProjectConfig,
  type ProjectConfig,
} from "./config.js";
import {
  inspectGitHubEnvironmentResources,
  previewGitHubConfiguration,
} from "./github/configure.js";
import { sha256 } from "./hash.js";
import { resolveRepositoryRoot } from "./installer/plan.js";
import {
  RUNTIME_SKILLS_UPSTREAM_COMMIT,
  RUNTIME_SKILL_HASHES,
} from "./installer/templates.js";
import { proposeRuntime } from "./runtime/detect.js";

const runtimeSkillNames = ["code-review", "implement", "tdd"] as const;

export interface DoctorCheck {
  id:
    | "commands"
    | "config-schema"
    | "github-labels"
    | "github-settings"
    | "managed-files"
    | "runtime"
    | "runtime-skills"
    | "workflow";
  status: "fail" | "pass";
}

export interface DoctorDiagnostic {
  check: DoctorCheck["id"];
  code: string;
  message: string;
  path?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  diagnostics: DoctorDiagnostic[];
  ok: boolean;
  repository: string;
}

interface InstallationManifest {
  managedAssets: Record<string, { sha256: string }>;
  schemaVersion: 1;
}

interface RuntimeSkillLock {
  skills: Record<
    string,
    {
      computedHash?: string;
      ref?: string;
      source?: string;
      sourceType?: string;
    }
  >;
  version: number;
}

function diagnostic(
  check: DoctorCheck["id"],
  code: string,
  message: string,
  path?: string,
): DoctorDiagnostic {
  return path === undefined
    ? { check, code, message }
    : { check, code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(path: string, code: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new InfrastructureError([
      { code, message: "Unable to read an installed Sandcastle metadata file." },
    ]);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ConfigurationError([
      {
        code,
        message: "An installed Sandcastle metadata file is not valid JSON.",
        path,
      },
    ]);
  }
}

function parseManifest(candidate: unknown): InstallationManifest {
  if (
    !isRecord(candidate) ||
    candidate.schemaVersion !== 1 ||
    !isRecord(candidate.managedAssets)
  ) {
    throw new ConfigurationError([
      {
        code: "INSTALLATION_MANIFEST_INVALID",
        message: "The installation manifest has an unsupported shape.",
        path: ".sandcastle/installation.json",
      },
    ]);
  }
  for (const entry of Object.values(candidate.managedAssets)) {
    if (
      !isRecord(entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new ConfigurationError([
        {
          code: "INSTALLATION_MANIFEST_INVALID",
          message: "The installation manifest contains an invalid managed hash.",
          path: ".sandcastle/installation.json",
        },
      ]);
    }
  }
  return candidate as unknown as InstallationManifest;
}

function safeManagedPath(root: string, managedPath: string): string | null {
  const absolute = join(root, managedPath);
  const fromRoot = relative(root, absolute);
  if (
    isAbsolute(managedPath) ||
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    return null;
  }
  return absolute;
}

async function checkManagedFiles(
  root: string,
  manifest: InstallationManifest,
): Promise<DoctorDiagnostic[]> {
  const diagnostics: DoctorDiagnostic[] = [];
  for (const [managedPath, metadata] of Object.entries(
    manifest.managedAssets,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const absolute = safeManagedPath(root, managedPath);
    if (!absolute) {
      diagnostics.push(
        diagnostic(
          "managed-files",
          "MANAGED_PATH_INVALID",
          "The installation manifest contains an unsafe managed path.",
          managedPath,
        ),
      );
      continue;
    }
    let contents: Buffer;
    try {
      const metadataOnDisk = await lstat(absolute);
      if (!metadataOnDisk.isFile()) {
        throw new Error("not a file");
      }
      contents = await readFile(absolute);
    } catch {
      diagnostics.push(
        diagnostic(
          "managed-files",
          "MANAGED_FILE_MISSING",
          "A managed installation file is missing or is not a regular file.",
          managedPath,
        ),
      );
      continue;
    }
    if (sha256(contents) !== metadata.sha256) {
      diagnostics.push(
        diagnostic(
          "managed-files",
          "MANAGED_FILE_DRIFT",
          "A managed installation file differs from its recorded hash.",
          managedPath,
        ),
      );
    }
  }
  return diagnostics;
}

async function collectSkillFiles(
  root: string,
  current: string = root,
  files: Array<{ content: Buffer; path: string }> = [],
): Promise<Array<{ content: Buffer; path: string }>> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      await collectSkillFiles(root, absolute, files);
    } else if (entry.isFile()) {
      files.push({
        content: await readFile(absolute),
        path: relative(root, absolute).split("\\").join("/"),
      });
    }
  }
  return files;
}

async function skillHash(path: string): Promise<string | null> {
  let files: Array<{ content: Buffer; path: string }>;
  try {
    files = await collectSkillFiles(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const chunks: Buffer[] = [];
  for (const file of files.sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    chunks.push(Buffer.from(file.path), file.content);
  }
  return sha256(Buffer.concat(chunks));
}

function parseSkillLock(candidate: unknown): RuntimeSkillLock | null {
  if (
    !isRecord(candidate) ||
    candidate.version !== 1 ||
    !isRecord(candidate.skills)
  ) {
    return null;
  }
  return candidate as unknown as RuntimeSkillLock;
}

async function checkRuntimeSkills(root: string): Promise<DoctorDiagnostic[]> {
  const candidate = await readJson(
    join(root, "skills-lock.json"),
    "SKILLS_LOCK_INVALID",
  );
  const lock = parseSkillLock(candidate);
  if (!lock) {
    return [
      diagnostic(
        "runtime-skills",
        "SKILLS_LOCK_INVALID",
        "The runtime skills lock has an unsupported shape.",
        "skills-lock.json",
      ),
    ];
  }
  const diagnostics: DoctorDiagnostic[] = [];
  for (const name of runtimeSkillNames) {
    const entry = lock.skills[name];
    const actualHash = await skillHash(join(root, ".agents", "skills", name));
    if (actualHash === null) {
      diagnostics.push(
        diagnostic(
          "runtime-skills",
          "RUNTIME_SKILL_MISSING",
          "A required runtime skill is missing.",
          `.agents/skills/${name}`,
        ),
      );
      continue;
    }
    if (
      entry?.computedHash !== actualHash ||
      actualHash !== RUNTIME_SKILL_HASHES[name] ||
      entry.ref !== RUNTIME_SKILLS_UPSTREAM_COMMIT ||
      entry.source !== "mattpocock/skills" ||
      entry.sourceType !== "github"
    ) {
      diagnostics.push(
        diagnostic(
          "runtime-skills",
          "RUNTIME_SKILL_LOCK_MISMATCH",
          "A runtime skill does not match its pinned lock entry.",
          `.agents/skills/${name}`,
        ),
      );
    }
  }
  return diagnostics;
}

function checkResult(
  id: DoctorCheck["id"],
  diagnostics: DoctorDiagnostic[],
): DoctorCheck {
  return {
    id,
    status: diagnostics.some(({ check }) => check === id) ? "fail" : "pass",
  };
}

async function checkRuntimeAndCommands(
  root: string,
  config: ProjectConfig,
): Promise<DoctorDiagnostic[]> {
  if (config.runtime.adapter === "custom") {
    return [];
  }
  let proposal;
  try {
    proposal = await proposeRuntime(root);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return error.diagnostics.map(({ code, message, path }) =>
        diagnostic("runtime", code, message, path),
      );
    }
    throw error;
  }
  if (
    proposal.runtime.adapter !== config.runtime.adapter ||
    proposal.runtime.version !== config.runtime.version
  ) {
    return [
      diagnostic(
        "runtime",
        "RUNTIME_MISMATCH",
        "The detected runtime does not match the configured adapter and exact version.",
        ".sandcastle/config.json",
      ),
    ];
  }
  if (canonicalJson(proposal.commands) !== canonicalJson(config.commands)) {
    return [
      diagnostic(
        "commands",
        "COMMANDS_MISMATCH",
        "Configured completion commands differ from the detected runtime commands.",
        ".sandcastle/config.json",
      ),
    ];
  }
  return [];
}

async function checkWorkflow(root: string): Promise<DoctorDiagnostic[]> {
  let workflow: string;
  try {
    workflow = await readFile(
      join(root, ".github", "workflows", "sandcastle.yml"),
      "utf8",
    );
  } catch {
    return [
      diagnostic(
        "workflow",
        "WORKFLOW_MISSING",
        "The managed Sandcastle workflow is missing.",
        ".github/workflows/sandcastle.yml",
      ),
    ];
  }
  return workflow.includes("workflow_dispatch:") &&
    workflow.includes("permissions: {}")
    ? []
    : [
        diagnostic(
          "workflow",
          "WORKFLOW_INVALID",
          "The Sandcastle workflow does not preserve its safe dispatch boundary.",
          ".github/workflows/sandcastle.yml",
        ),
      ];
}

export async function doctor(
  repository: string,
  configPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DoctorResult> {
  const root = await resolveRepositoryRoot(repository);
  const config = await readProjectConfig(
    configPath ?? join(root, ".sandcastle", "config.json"),
  );
  const manifest = parseManifest(
    await readJson(
      join(root, ".sandcastle", "installation.json"),
      "INSTALLATION_MANIFEST_INVALID",
    ),
  );
  const diagnostics: DoctorDiagnostic[] = [];
  const checks: DoctorCheck[] = [{ id: "config-schema", status: "pass" }];

  diagnostics.push(...(await checkManagedFiles(root, manifest)));
  checks.push(checkResult("managed-files", diagnostics));

  diagnostics.push(...(await checkRuntimeSkills(root)));
  checks.push(checkResult("runtime-skills", diagnostics));

  diagnostics.push(...(await checkRuntimeAndCommands(root, config)));
  checks.push(checkResult("runtime", diagnostics));
  checks.push(checkResult("commands", diagnostics));

  diagnostics.push(...(await checkWorkflow(root)));
  checks.push(checkResult("workflow", diagnostics));

  const github = await previewGitHubConfiguration(root, config, environment);
  for (const label of github.resources.filter(({ kind }) => kind === "label")) {
    if (label.action !== "reuse") {
      diagnostics.push(
        diagnostic(
          "github-labels",
          "GITHUB_LABEL_MISSING",
          "A configured queue label is missing from the GitHub repository.",
          label.name,
        ),
      );
    }
  }
  checks.push(checkResult("github-labels", diagnostics));

  const environmentResource = github.resources.find(
    ({ kind }) => kind === "environment",
  );
  const providerResourcesReady = github.resources
    .filter(
      ({ kind }) =>
        kind === "environment-secret" || kind === "environment-variable",
    )
    .every(({ available }) => available === true);
  const automatedSettingsReady = github.diagnostics
    .filter(({ kind }) =>
      [
        "actions-permissions",
        "branch-protection",
        "repository-rulesets",
      ].includes(kind),
    )
    .every(({ status }) => status === "configured");
  const remoteProviderResources = await inspectGitHubEnvironmentResources(
    github.repository,
    environment,
  );
  if (environmentResource?.action !== "reuse") {
    diagnostics.push(
      diagnostic(
        "github-settings",
        "GITHUB_ENVIRONMENT_MISSING",
        "The sandcastle GitHub Environment is missing.",
      ),
    );
  }
  if (!providerResourcesReady) {
    diagnostics.push(
      diagnostic(
        "github-settings",
        "PROVIDER_INPUT_MISSING",
        "A required provider input is unavailable to local doctor.",
      ),
    );
  }
  if (!remoteProviderResources.providerVariableConfigured) {
    diagnostics.push(
      diagnostic(
        "github-settings",
        "GITHUB_PROVIDER_VARIABLE_MISSING",
        "The provider Base URL Environment variable is missing from GitHub.",
      ),
    );
  }
  if (!remoteProviderResources.providerSecretConfigured) {
    diagnostics.push(
      diagnostic(
        "github-settings",
        "GITHUB_PROVIDER_SECRET_MISSING",
        "The provider token Environment secret is missing from GitHub.",
      ),
    );
  }
  if (!automatedSettingsReady) {
    diagnostics.push(
      diagnostic(
        "github-settings",
        "GITHUB_REPOSITORY_SETTINGS_INCOMPLETE",
        "One or more read-only repository safety checks are incomplete.",
      ),
    );
  }
  checks.push(checkResult("github-settings", diagnostics));

  return {
    checks,
    diagnostics,
    ok: diagnostics.length === 0,
    repository: github.repository,
  };
}
