import { ConfigurationError } from "../config.js";

export type WorkflowOperation =
  | "abort"
  | "final-fix"
  | "process"
  | "remote-doctor"
  | "review-only";

export type WorkflowCapability =
  | "close-issue"
  | "dispatch-continuation"
  | "inspect-actions"
  | "publish-audit"
  | "push"
  | "read-issue"
  | "update-pull-request"
  | "upload-artifact";

export interface WorkflowJobPermissions {
  actions: "none" | "read" | "write";
  contents: "none" | "read" | "write";
  issues: "none" | "read" | "write";
  pullRequests: "none" | "read" | "write";
}

export interface WorkflowOperationContract {
  capabilities: readonly WorkflowCapability[];
  permissions: WorkflowJobPermissions;
}

export interface WorkflowCapabilityRequest {
  boundary: "host" | "sandbox";
  capability: WorkflowCapability;
  operation: WorkflowOperation;
}

function workflowJobBlock(source: string, job: string): string | null {
  const marker = `\n  ${job}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const block = source.slice(start + 1);
  const next = block.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/u);
  return next < 0 ? block : block.slice(0, next + 1);
}

function hasExactPermissions(block: string, expected: string): boolean {
  const permissions = block.match(
    /\n    permissions:\n((?:      [a-z-]+: (?:none|read|write)\n)+)/u,
  )?.[1];
  return permissions?.trimEnd() === expected;
}

function expectedPermissionSource(operation: WorkflowOperation): string {
  const permission = WORKFLOW_OPERATION_CONTRACTS[operation].permissions;
  return [
    `      actions: ${permission.actions}`,
    `      contents: ${permission.contents}`,
    `      issues: ${permission.issues}`,
    `      pull-requests: ${permission.pullRequests}`,
  ].join("\n");
}

/** 检查 managed workflow 是否仍保持唯一人工入口和逐 operation 权限合同。 */
export function isWorkflowSecurityContractSatisfied(source: string): boolean {
  if (typeof source !== "string" || source.length === 0) return false;
  const trigger = source.match(/\non:\n([\s\S]*?)\nrun-name:/u)?.[1];
  if (!trigger) return false;
  const topLevelTriggers = [...trigger.matchAll(/^  ([a-z_]+):/gmu)].map(
    (match) => match[1],
  );
  if (
    topLevelTriggers.length !== 1 ||
    topLevelTriggers[0] !== "workflow_dispatch" ||
    !source.includes("\npermissions: {}\n\njobs:\n")
  ) {
    return false;
  }
  const jobNames = [
    ...source.slice(source.indexOf("\njobs:\n")).matchAll(/^  ([a-z][a-z0-9-]*):/gmu),
  ].map((match) => match[1]);
  const expectedJobs = ["initialize-batch", ...operations].sort();
  if (
    jobNames.length !== expectedJobs.length ||
    jobNames.sort().some((job, index) => job !== expectedJobs[index])
  ) {
    return false;
  }
  const initialization = workflowJobBlock(source, "initialize-batch");
  if (
    !initialization ||
    !hasExactPermissions(
      initialization,
      "      contents: write\n      issues: read",
    ) ||
    !initialization.includes("persist-credentials: false") ||
    !initialization.includes("GITHUB_TOKEN: ${{ github.token }}")
  ) {
    return false;
  }
  for (const operation of operations) {
    const block = workflowJobBlock(source, operation);
    if (
      !block ||
      !hasExactPermissions(block, expectedPermissionSource(operation)) ||
      !block.includes("persist-credentials: false") ||
      !block.includes("GITHUB_TOKEN: ${{ github.token }}") ||
      !block.includes("sandcastle-queue workflow-host")
    ) {
      return false;
    }
  }
  return true;
}

const operations = new Set<WorkflowOperation>([
  "abort",
  "final-fix",
  "process",
  "remote-doctor",
  "review-only",
]);
const capabilities = new Set<WorkflowCapability>([
  "close-issue",
  "dispatch-continuation",
  "inspect-actions",
  "publish-audit",
  "push",
  "read-issue",
  "update-pull-request",
  "upload-artifact",
]);
const permissionRanks = { none: 0, read: 1, write: 2 } as const;
const capabilityPermissions: Record<
  WorkflowCapability,
  Partial<Record<keyof WorkflowJobPermissions, "read" | "write">>
> = {
  "close-issue": { issues: "write" },
  "dispatch-continuation": { actions: "write" },
  "inspect-actions": { actions: "read" },
  "publish-audit": { issues: "write" },
  push: { contents: "write" },
  "read-issue": { issues: "read" },
  "update-pull-request": { pullRequests: "write" },
  "upload-artifact": { actions: "write" },
};

export const WORKFLOW_OPERATION_CONTRACTS: Readonly<
  Record<WorkflowOperation, WorkflowOperationContract>
> = {
  abort: {
    capabilities: [
      "close-issue",
      "inspect-actions",
      "publish-audit",
      "read-issue",
      "update-pull-request",
    ],
    permissions: {
      actions: "read",
      contents: "read",
      issues: "write",
      pullRequests: "write",
    },
  },
  "final-fix": {
    capabilities: [
      "dispatch-continuation",
      "inspect-actions",
      "publish-audit",
      "push",
      "read-issue",
      "update-pull-request",
      "upload-artifact",
    ],
    permissions: {
      actions: "write",
      contents: "write",
      issues: "write",
      pullRequests: "write",
    },
  },
  process: {
    capabilities: [
      "close-issue",
      "dispatch-continuation",
      "inspect-actions",
      "publish-audit",
      "push",
      "read-issue",
      "update-pull-request",
      "upload-artifact",
    ],
    permissions: {
      actions: "write",
      contents: "write",
      issues: "write",
      pullRequests: "write",
    },
  },
  "remote-doctor": {
    capabilities: ["upload-artifact"],
    permissions: {
      actions: "write",
      contents: "read",
      issues: "none",
      pullRequests: "none",
    },
  },
  "review-only": {
    capabilities: [
      "dispatch-continuation",
      "inspect-actions",
      "publish-audit",
      "read-issue",
      "update-pull-request",
      "upload-artifact",
    ],
    permissions: {
      actions: "write",
      contents: "read",
      issues: "write",
      pullRequests: "write",
    },
  },
};

for (const contract of Object.values(WORKFLOW_OPERATION_CONTRACTS)) {
  Object.freeze(contract.capabilities);
  Object.freeze(contract.permissions);
  Object.freeze(contract);
}
Object.freeze(WORKFLOW_OPERATION_CONTRACTS);

function configurationError(code: string, message: string): ConfigurationError {
  return new ConfigurationError([{ code, message, path: "" }]);
}

function validRequest(candidate: WorkflowCapabilityRequest): boolean {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    (candidate.boundary === "host" || candidate.boundary === "sandbox") &&
    operations.has(candidate.operation) &&
    capabilities.has(candidate.capability)
  );
}

function permissionAllows(
  permissions: WorkflowJobPermissions,
  capability: WorkflowCapability,
): boolean {
  return Object.entries(capabilityPermissions[capability]).every(
    ([area, required]) =>
      permissionRanks[permissions[area as keyof WorkflowJobPermissions]] >=
      permissionRanks[required],
  );
}

/**
 * 在执行 host GitHub 副作用前强制 operation capability；sandbox 请求始终拒绝且不会执行回调。
 */
export async function executeWorkflowCapability<T>(
  request: WorkflowCapabilityRequest,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (!validRequest(request) || typeof operation !== "function") {
    throw configurationError(
      "WORKFLOW_CAPABILITY_REQUEST_INVALID",
      "Workflow capability execution requires an exact operation and boundary.",
    );
  }
  if (request.boundary === "sandbox") {
    throw configurationError(
      "SANDBOX_GITHUB_CAPABILITY_FORBIDDEN",
      "Sandbox execution cannot use GitHub host capabilities.",
    );
  }
  const contract = WORKFLOW_OPERATION_CONTRACTS[request.operation];
  if (
    !contract.capabilities.includes(request.capability) ||
    !permissionAllows(contract.permissions, request.capability)
  ) {
    throw configurationError(
      "WORKFLOW_CAPABILITY_FORBIDDEN",
      "The workflow operation does not grant this host capability.",
    );
  }
  return operation();
}
