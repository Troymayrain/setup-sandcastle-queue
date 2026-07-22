export {
  ConfigurationError,
  InfrastructureError,
  readProjectConfig,
  resolveModelRoles,
  validateProjectConfig,
} from "./config.js";
export type {
  CommandSpec,
  ConfigurationDiagnostic,
  InfrastructureDiagnostic,
  ModelRoleResolution,
  ProjectConfig,
} from "./config.js";
export {
  createInstallPlan,
  resumePendingInstallPlan,
  savePendingInstallPlan,
} from "./installer/plan.js";
export { applyInstallPlan, readInstallPlan } from "./installer/apply.js";
export type { InstallResult } from "./installer/apply.js";
export { proposeRuntime } from "./runtime/detect.js";
export type { BuiltInAdapter, RuntimeProposal } from "./runtime/detect.js";
export {
  applyGitHubConfiguration,
  previewGitHubConfiguration,
  validateGitHubResourceConfirmation,
} from "./github/configure.js";
export type {
  GitHubConfigurationApplyResult,
  GitHubConfigurationDiagnostic,
  GitHubConfigurationPreview,
  GitHubConfigurationResource,
  GitHubConfirmationCategory,
} from "./github/configure.js";
export type {
  AssetPrecondition,
  InstallationState,
  InstallPlan,
  InstallPlanAsset,
} from "./installer/plan.js";
export { TEMPLATE_VERSION } from "./installer/templates.js";
export { VERSION } from "./version.js";
