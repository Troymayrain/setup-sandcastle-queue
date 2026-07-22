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
export { doctor } from "./doctor.js";
export type {
  DoctorCheck,
  DoctorDiagnostic,
  DoctorResult,
} from "./doctor.js";
export {
  createInstallPlan,
  resumePendingInstallPlan,
  savePendingInstallPlan,
} from "./installer/plan.js";
export {
  createAdoptionPreview,
  inspectLegacyQuiescence,
  parseLegacyPullRequestOptOut,
} from "./installer/adopt.js";
export {
  createRollbackPreview,
  createUpgradePreview,
} from "./installer/upgrade.js";
export type { RollbackPreview, UpgradePreview } from "./installer/upgrade.js";
export {
  applyUninstallPlan,
  createUninstallPreview,
  readUninstallPlan,
} from "./installer/uninstall.js";
export type {
  UninstallConflict,
  UninstallPlan,
  UninstallPreservedEntry,
  UninstallPreview,
  UninstallRemoval,
  UninstallResult,
} from "./installer/uninstall.js";
export type {
  AdoptionMigration,
  AdoptionPreview,
  LegacyQuiescence,
} from "./installer/adopt.js";
export {
  applyAdoptPlan,
  applyInstallPlan,
  applyRollbackPlan,
  applyUpgradePlan,
  readInstallPlan,
} from "./installer/apply.js";
export type { InstallResult } from "./installer/apply.js";
export { proposeRuntime } from "./runtime/detect.js";
export type { BuiltInAdapter, RuntimeProposal } from "./runtime/detect.js";
export {
  applyGitHubConfiguration,
  inspectGitHubEnvironmentResources,
  previewGitHubConfiguration,
  validateGitHubResourceConfirmation,
} from "./github/configure.js";
export {
  computeTicketFrontier,
  parseParentMembership,
  readSpecSnapshot,
  verifySpecSnapshot,
} from "./github/frontier.js";
export {
  applyBatchStart,
  createBatchStartPreview,
  initializeBatch,
  parseEnrollmentSelection,
} from "./batch/start.js";
export type {
  BatchMetadata,
  BatchStartPreview,
  BatchStartResult,
} from "./batch/start.js";
export type {
  FrontierResult,
  FrontierTicket,
  SpecCommentSnapshot,
  SpecIssueSnapshot,
  SpecVerificationResult,
  TicketFrontierStatus,
  TicketSpecSnapshot,
} from "./github/frontier.js";
export type {
  GitHubConfigurationApplyResult,
  GitHubConfigurationDiagnostic,
  GitHubConfigurationPreview,
  GitHubConfigurationResource,
  GitHubConfirmationCategory,
  GitHubEnvironmentResourceState,
} from "./github/configure.js";
export type {
  AdoptionPlanMetadata,
  AdoptionSkillExtension,
  AssetPrecondition,
  ConfigSchemaMigration,
  CreateInstallPlanOptions,
  InstallationState,
  InstallPlan,
  InstallPlanAsset,
  RollbackPlanMetadata,
  UpgradeConflict,
  UpgradePlanMetadata,
} from "./installer/plan.js";
export { TEMPLATE_VERSION } from "./installer/templates.js";
export { VERSION } from "./version.js";
