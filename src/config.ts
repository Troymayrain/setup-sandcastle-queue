import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { basename } from "node:path";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { readBoundedJsonFile } from "./json.js";

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
      | "composite"
      | "custom"
      | "go-module"
      | "java-maven"
      | "node-npm"
      | "python-pip"
      | "python-uv";
    custom?: {
      bootstrap: CommandSpec[];
      name: string;
      schemaVersion: 1;
    };
    composite?: {
      adapters: Array<{
        adapter:
          | "go-module"
          | "java-maven"
          | "node-npm"
          | "python-pip"
          | "python-uv";
        tools?: { maven?: string };
        version: string;
      }>;
      schemaVersion: 1;
    };
    networkHosts?: string[];
    tools?: {
      maven?: string;
    };
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

  if (
    error.instancePath === "/runtime/composite/schemaVersion" &&
    error.keyword === "const"
  ) {
    return {
      code: "UNSUPPORTED_COMPOSITE_ADAPTER_SCHEMA",
      message: "Only composite adapter schema version 1 is supported.",
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

  const commandGroups: Array<[string, CommandSpec[]]> = [
    ...Object.entries(config.commands),
    ...(config.runtime.adapter === "custom" && config.runtime.custom
      ? [["runtime/custom/bootstrap", config.runtime.custom.bootstrap] as [
          string,
          CommandSpec[],
        ]]
      : []),
  ];
  for (const [groupName, commands] of commandGroups) {
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
          path: groupName.startsWith("runtime/")
            ? `/${groupName}/${index}`
            : `/commands/${groupName}/${index}`,
        });
      }
      if (
        config.runtime.adapter === "custom" &&
        (executable === "docker" ||
          executable === "podman" ||
          command.argv.some(
            (argument, argumentIndex) =>
              argument === "--privileged" ||
              argument === "--network=host" ||
              argument.includes("/var/run/docker.sock") ||
              (argument === "--network" &&
                command.argv[argumentIndex + 1] === "host") ||
              argument === "--use-api-socket",
          ))
      ) {
        diagnostics.push({
          code: "CUSTOM_ADAPTER_UNSAFE",
          message:
            "Custom adapter commands cannot control container networking or engine sockets.",
          path: groupName.startsWith("runtime/")
            ? `/${groupName}/${index}`
            : `/commands/${groupName}/${index}`,
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
  if (config.runtime.adapter === "composite" && !config.runtime.composite) {
    diagnostics.push({
      code: "COMPOSITE_ADAPTER_REQUIRED",
      message: "The composite runtime adapter requires a versioned component list.",
      path: "/runtime/composite",
    });
  }
  if (config.runtime.adapter !== "composite" && config.runtime.composite) {
    diagnostics.push({
      code: "COMPOSITE_ADAPTER_NOT_ALLOWED",
      message: "Only the composite runtime adapter can include component metadata.",
      path: "/runtime/composite",
    });
  }
  if (config.runtime.adapter === "composite" && config.runtime.composite) {
    if (config.runtime.version !== "1.0.0") {
      diagnostics.push({
        code: "COMPOSITE_VERSION_INVALID",
        message: "Composite adapter schema version 1 uses runtime version 1.0.0.",
        path: "/runtime/version",
      });
    }
    const adapters = config.runtime.composite.adapters.map(({ adapter }) => adapter);
    if (new Set(adapters).size !== adapters.length) {
      diagnostics.push({
        code: "COMPOSITE_VERSION_CONFLICT",
        message: "Composite components must use one exact version per adapter.",
        path: "/runtime/composite/adapters",
      });
    }
    for (const [index, component] of config.runtime.composite.adapters.entries()) {
      if (component.adapter === "java-maven" && !component.tools?.maven) {
        diagnostics.push({
          code: "MAVEN_VERSION_REQUIRED",
          message: "The Java adapter requires an exact Maven Wrapper version.",
          path: `/runtime/composite/adapters/${index}/tools/maven`,
        });
      }
      if (component.adapter !== "java-maven" && component.tools) {
        diagnostics.push({
          code: "RUNTIME_TOOLS_NOT_ALLOWED",
          message: "This runtime adapter does not accept Java tool metadata.",
          path: `/runtime/composite/adapters/${index}/tools`,
        });
      }
    }
  }
  if (
    config.runtime.adapter === "custom" &&
    config.runtime.networkHosts === undefined
  ) {
    diagnostics.push({
      code: "CUSTOM_NETWORK_HOSTS_REQUIRED",
      message: "Custom adapters must explicitly declare their network hosts.",
      path: "/runtime/networkHosts",
    });
  }
  if (config.runtime.adapter === "java-maven" && !config.runtime.tools?.maven) {
    diagnostics.push({
      code: "MAVEN_VERSION_REQUIRED",
      message: "The Java adapter requires an exact Maven Wrapper version.",
      path: "/runtime/tools/maven",
    });
  }
  if (config.runtime.adapter !== "java-maven" && config.runtime.tools) {
    diagnostics.push({
      code: "RUNTIME_TOOLS_NOT_ALLOWED",
      message: "This runtime adapter does not accept Java tool metadata.",
      path: "/runtime/tools",
    });
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
  const result = await readBoundedJsonFile(path, 1024 * 1024);
  if (!result.ok && result.reason !== "invalid-json") {
    throw new InfrastructureError([
      {
        code: "CONFIG_READ_FAILED",
        message: "Unable to read project configuration.",
      },
    ]);
  }
  if (!result.ok) {
    throw new ConfigurationError([
      {
        code: "INVALID_JSON",
        message: "Project configuration is not valid JSON.",
        path: "",
      },
    ]);
  }

  return validateProjectConfig(result.value);
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
