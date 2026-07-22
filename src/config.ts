import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename } from "node:path";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

export interface ConfigurationDiagnostic {
  code: string;
  message: string;
  path: string;
}

export class ConfigurationError extends Error {
  readonly diagnostics: ConfigurationDiagnostic[];

  constructor(diagnostics: ConfigurationDiagnostic[]) {
    super("Project configuration is invalid");
    this.name = "ConfigurationError";
    this.diagnostics = diagnostics;
  }
}

export interface InfrastructureDiagnostic {
  code: string;
  message: string;
}

export class InfrastructureError extends Error {
  readonly diagnostics: InfrastructureDiagnostic[];

  constructor(diagnostics: InfrastructureDiagnostic[]) {
    super("Infrastructure operation failed");
    this.name = "InfrastructureError";
    this.diagnostics = diagnostics;
  }
}

export interface CommandSpec {
  argv: string[];
}

export interface ProjectConfig {
  schemaVersion: 1;
  queue: {
    readyLabel: string;
    ownershipLabel: string;
  };
  runtime: {
    adapter:
      | "custom"
      | "go-module"
      | "java-maven"
      | "node-npm"
      | "python-pip"
      | "python-uv";
    custom?: {
      name: string;
      schemaVersion: 1;
    };
    networkHosts?: string[];
    version: string;
  };
  commands: {
    tests: CommandSpec[];
    verification: CommandSpec[];
  };
  provider: {
    kind: "anthropic-compatible";
    models: {
      ticket: string;
      finalReview?: string;
      finalFix?: string;
      fast?: string;
    };
  };
  execution: {
    jobTimeoutMinutes: number;
    processingBudgetMinutes: number;
    ticketTimeoutMinutes: number;
    minimumRemainingMinutes: number;
    maxTicketsPerRun: number;
  };
  audit: {
    retentionDays: number;
  };
}

export interface ModelRoleResolution {
  fallbacks: Partial<Record<"fast" | "finalFix" | "finalReview", "ticket">>;
  roles: {
    fast: string;
    finalFix: string;
    finalReview: string;
    ticket: string;
  };
}

const schema = JSON.parse(
  await readFile(new URL("../schema/config.schema.json", import.meta.url), "utf8"),
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile<ProjectConfig>(schema);
const forbiddenCommandExecutables = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "fish",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const unsafeArgumentPattern =
  /(?:\u0000|[\r\n]|\$\(|\$\{|\$[A-Za-z_]|`|\{\{|&&|\|\||;|%[A-Za-z_][A-Za-z0-9_]*%)/u;

function normalizeSchemaError(error: ErrorObject): ConfigurationDiagnostic {
  if (error.instancePath === "/schemaVersion" && error.keyword === "const") {
    return {
      code: "UNSUPPORTED_SCHEMA",
      message: "Only schema version 1 is supported.",
      path: error.instancePath,
    };
  }

  if (
    error.instancePath === "/runtime/custom/schemaVersion" &&
    error.keyword === "const"
  ) {
    return {
      code: "UNSUPPORTED_CUSTOM_ADAPTER_SCHEMA",
      message: "Only custom adapter schema version 1 is supported.",
      path: error.instancePath,
    };
  }

  if (error.keyword === "additionalProperties") {
    const field = String(error.params.additionalProperty);
    return {
      code: "UNKNOWN_FIELD",
      message: `Unknown field '${field}'.`,
      path: error.instancePath,
    };
  }

  if (
    (error.instancePath.startsWith("/execution/") ||
      error.instancePath === "/audit/retentionDays") &&
    (error.keyword === "minimum" || error.keyword === "maximum")
  ) {
    return {
      code: "INVALID_LIMIT",
      message: "Execution limit is outside the supported safety bounds.",
      path: error.instancePath,
    };
  }

  if (
    (error.instancePath === "/commands/tests" &&
      error.keyword === "minItems") ||
    (error.instancePath === "/commands" &&
      error.keyword === "required" &&
      error.params.missingProperty === "tests")
  ) {
    return {
      code: "MISSING_TESTS",
      message: "At least one test command is required.",
      path: "/commands/tests",
    };
  }

  return {
    code: "SCHEMA_VIOLATION",
    message: "Value does not match the supported configuration schema.",
    path: error.instancePath,
  };
}

function commandDiagnostics(config: ProjectConfig): ConfigurationDiagnostic[] {
  const diagnostics: ConfigurationDiagnostic[] = [];

  for (const [groupName, commands] of Object.entries(config.commands)) {
    commands.forEach((command, index) => {
      const executable = basename(command.argv[0] ?? "").toLowerCase();
      if (
        forbiddenCommandExecutables.has(executable) ||
        command.argv.some((argument) => unsafeArgumentPattern.test(argument))
      ) {
        diagnostics.push({
          code: "UNSAFE_COMMAND",
          message:
            "Commands must be direct argv specifications without shell execution or interpolation.",
          path: `/commands/${groupName}/${index}`,
        });
      }
    });
  }

  return diagnostics;
}

function runtimeDiagnostics(config: ProjectConfig): ConfigurationDiagnostic[] {
  const diagnostics: ConfigurationDiagnostic[] = [];
  if (config.runtime.adapter === "custom" && !config.runtime.custom) {
    diagnostics.push(
      {
        code: "CUSTOM_ADAPTER_REQUIRED",
        message: "The custom runtime adapter requires a versioned custom block.",
        path: "/runtime/custom",
      },
    );
  }
  if (config.runtime.adapter !== "custom" && config.runtime.custom) {
    diagnostics.push(
      {
        code: "CUSTOM_ADAPTER_NOT_ALLOWED",
        message: "Built-in runtime adapters cannot include a custom block.",
        path: "/runtime/custom",
      },
    );
  }
  for (const [index, host] of (config.runtime.networkHosts ?? []).entries()) {
    if (!isExactNetworkHost(host)) {
      diagnostics.push({
        code: "SANDBOX_HOST_INVALID",
        message: "Sandbox network hosts must be exact public DNS host names.",
        path: `/runtime/networkHosts/${index}`,
      });
    }
  }
  return diagnostics;
}

export function isExactNetworkHost(host: string): boolean {
  if (
    host.length > 253 ||
    host !== host.toLocaleLowerCase("en-US") ||
    !host.includes(".") ||
    host.endsWith(".") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    isIP(host) !== 0
  ) {
    return false;
  }
  return host.split(".").every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  );
}

export async function readProjectConfig(path: string): Promise<ProjectConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    throw new InfrastructureError([
      {
        code: "CONFIG_READ_FAILED",
        message: "Unable to read project configuration.",
      },
    ]);
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(source);
  } catch {
    throw new ConfigurationError([
      {
        code: "INVALID_JSON",
        message: "Project configuration is not valid JSON.",
        path: "",
      },
    ]);
  }

  return validateProjectConfig(candidate);
}

export function validateProjectConfig(candidate: unknown): ProjectConfig {
  if (!validateSchema(candidate)) {
    const diagnostics = (validateSchema.errors ?? [])
      .map(normalizeSchemaError)
      .sort((left, right) =>
        `${left.path}\u0000${left.code}\u0000${left.message}`.localeCompare(
          `${right.path}\u0000${right.code}\u0000${right.message}`,
        ),
      );
    throw new ConfigurationError(diagnostics);
  }

  const config = candidate as ProjectConfig;
  const diagnostics = [...runtimeDiagnostics(config), ...commandDiagnostics(config)];
  if (diagnostics.length > 0) {
    throw new ConfigurationError(diagnostics);
  }

  return config;
}

export function resolveModelRoles(config: ProjectConfig): ModelRoleResolution {
  const { models } = config.provider;
  const fallbacks: ModelRoleResolution["fallbacks"] = {};
  if (!models.fast) {
    fallbacks.fast = "ticket";
  }
  if (!models.finalFix) {
    fallbacks.finalFix = "ticket";
  }
  if (!models.finalReview) {
    fallbacks.finalReview = "ticket";
  }
  return {
    fallbacks,
    roles: {
      fast: models.fast ?? models.ticket,
      finalFix: models.finalFix ?? models.ticket,
      finalReview: models.finalReview ?? models.ticket,
      ticket: models.ticket,
    },
  };
}
