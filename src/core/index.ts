/**
 * CLEO core module — comprehensive barrel export.
 *
 * Re-exports all public APIs from core submodules and top-level utilities.
 * Uses namespace re-exports to avoid naming conflicts across submodules.
 *
 * Usage:
 *   import { tasks, sessions, memory, release } from '../core/index.js';
 *   const result = await tasks.addTask(...);
 *
 * @task T5709
 * @epic T5701
 */

// ---------------------------------------------------------------------------
// Submodule namespace re-exports
// ---------------------------------------------------------------------------

export * as adapters from './adapters/index.js';
export * as admin from './admin/index.js';
export * as adrs from './adrs/index.js';
export * as caamp from './caamp/index.js';
export * as codebaseMap from './codebase-map/index.js';
export * as compliance from './compliance/index.js';
export * as context from './context/index.js';
export * as coreHooks from './hooks/index.js';
export * as inject from './inject/index.js';
export * as issue from './issue/index.js';
export * as lifecycle from './lifecycle/index.js';
export * as coreMcp from './mcp/index.js';
export * as memory from './memory/index.js';
export * as metrics from './metrics/index.js';
export * as migration from './migration/index.js';
export * as nexus from './nexus/index.js';
export * as observability from './observability/index.js';
export * as orchestration from './orchestration/index.js';
export * as otel from './otel/index.js';
export * as phases from './phases/index.js';
export * as pipeline from './pipeline/index.js';
export * as release from './release/index.js';
export * as remote from './remote/index.js';
export * as research from './research/index.js';
export * as roadmap from './roadmap/index.js';
export * as routing from './routing/index.js';
export * as security from './security/index.js';
export * as sequence from './sequence/index.js';
export * as sessions from './sessions/index.js';
export * as signaldock from './signaldock/index.js';
export * as skills from './skills/index.js';
export * as snapshot from './snapshot/index.js';
export * as spawn from './spawn/index.js';
export * as stats from './stats/index.js';
export * as sticky from './sticky/index.js';
export * as system from './system/index.js';
export * as tasks from './tasks/index.js';
export * as taskWork from './task-work/index.js';
export * as templates from './templates/index.js';
export * as ui from './ui/index.js';
export * as validation from './validation/index.js';

// ---------------------------------------------------------------------------
// Top-level utility re-exports (widely used, unique names)
// ---------------------------------------------------------------------------

// Paths — foundational utilities used across the entire codebase
export {
  getAgentOutputsAbsolute,
  getAgentOutputsDir,
  getAgentsHome,
  getArchivePath,
  getBackupDir,
  getClaudeAgentsDir,
  getClaudeDir,
  getClaudeMemDbPath,
  getClaudeSettingsPath,
  getCleoCacheDir,
  getCleoConfigDir,
  getCleoDir,
  getCleoDirAbsolute,
  getCleoDocsDir,
  getCleoHome,
  getCleoLogDir,
  getCleoSchemasDir,
  getCleoTempDir,
  getCleoTemplatesDir,
  getConfigPath,
  getGlobalConfigPath,
  getLogPath,
  getManifestArchivePath,
  getManifestPath,
  getProjectRoot,
  getSessionsPath,
  getTaskPath,
  isAbsolutePath,
  isProjectInitialized,
  resolveProjectPath,
} from './paths.js';

// Errors
export type { ProblemDetails } from './errors.js';
export { CleoError } from './errors.js';

// Error catalog (RFC 9457)
export type { ErrorDefinition } from './error-catalog.js';
export {
  ERROR_CATALOG,
  getAllErrorDefinitions,
  getErrorDefinition,
  getErrorDefinitionByLafsCode,
} from './error-catalog.js';

// Error registry
export type { CleoRegistryEntry } from './error-registry.js';
export {
  getCleoErrorRegistry,
  getRegistryEntry,
  getRegistryEntryByLafsCode,
  isCleoRegisteredCode,
} from './error-registry.js';

// Config
export {
  getConfigValue,
  getRawConfig,
  getRawConfigValue,
  loadConfig,
  parseConfigValue,
  setConfigValue,
} from './config.js';

// Output formatting (LAFS envelope)
export type { LafsEnvelope, LafsError, LafsSuccess } from './output.js';
export type { FormatOptions } from './output.js';
export { formatError, formatOutput, formatSuccess, pushWarning } from './output.js';

// LAFS type guards (from types layer, re-exported for convenience)
export type {
  CleoResponse,
  GatewayEnvelope,
  GatewayError,
  GatewayMeta,
  GatewaySuccess,
  LafsAlternative,
  LafsErrorDetail,
} from '../types/lafs.js';
export { isGatewayEnvelope, isLafsError, isLafsSuccess } from '../types/lafs.js';

// JSON Schema validation
export {
  checkSchema,
  validateAgainstSchema,
  validateAgainstSchemaFile,
} from './json-schema-validator.js';

// Engine result type
export type { EngineResult } from './engine-result.js';

// Logger
export type { LoggerConfig } from './logger.js';
export { closeLogger, getLogDir, getLogger, initLogger } from './logger.js';

// Pagination
export type { PaginateInput } from './pagination.js';
export { createPage, paginate } from './pagination.js';

// Platform utilities
export type { Platform, SystemInfo } from './platform.js';
export {
  checkRequiredTools,
  commandExists,
  createTempFilePath,
  dateDaysAgo,
  detectPlatform,
  generateRandomHex,
  getFileSize,
  getFileMtime,
  getIsoTimestamp,
  getNodeUpgradeInstructions,
  getNodeVersionInfo,
  getSystemInfo,
  isoToEpoch,
  MINIMUM_NODE_MAJOR,
  PLATFORM,
  requireTool,
  sha256,
  // Store utilities re-exported via platform
  getDataPath,
  readJsonFile,
  resolveProjectRoot,
  writeJsonFileAtomic,
} from './platform.js';

// Project info
export type { ProjectInfo } from './project-info.js';
export { getProjectInfo, getProjectInfoSync } from './project-info.js';

// Init
export type { InitOptions, InitResult } from './init.js';
export {
  ensureInitialized,
  getVersion,
  initAgentDefinition,
  initCoreSkills,
  initMcpServer,
  initNexusRegistration,
  initProject,
  isAutoInitEnabled,
  updateDocs,
} from './init.js';

// Scaffold
export {
  CLEO_GITIGNORE_FALLBACK,
  checkBrainDb,
  checkCleoGitRepo,
  checkCleoStructure,
  checkConfig,
  checkGlobalHome,
  checkGlobalTemplates,
  checkLogDir,
  checkMemoryBridge,
  checkProjectContext,
  checkProjectInfo,
  checkSqliteDb,
  createDefaultConfig,
  ensureBrainDb,
  ensureCleoGitRepo,
  ensureCleoStructure,
  ensureConfig,
  ensureContributorMcp,
  ensureGitignore,
  ensureGlobalHome,
  ensureGlobalScaffold,
  ensureGlobalTemplates,
  ensureProjectContext,
  ensureProjectInfo,
  ensureSqliteDb,
  fileExists,
  generateProjectHash,
  getCleoVersion,
  getGitignoreContent,
  getPackageRoot,
  REQUIRED_CLEO_SUBDIRS,
  REQUIRED_GLOBAL_SUBDIRS,
  removeCleoFromRootGitignore,
  stripCLEOBlocks,
} from './scaffold.js';
export {
  type ScaffoldResult,
  type CheckResult as ScaffoldCheckResult,
  type CheckStatus,
} from './scaffold.js';

// Schema management
export type { InstalledSchema, SchemaInstallResult, StalenessReport } from './schema-management.js';
export {
  checkGlobalSchemas,
  checkSchemaStaleness,
  cleanProjectSchemas,
  ensureGlobalSchemas,
  getSchemaVersion,
  listInstalledSchemas,
  resolveSchemaPath,
} from './schema-management.js';

// Audit
export type { AuditEntry } from './audit.js';
export { queryAudit } from './audit.js';

// Audit prune
export type { PruneResult } from './audit-prune.js';
export { pruneAuditLog } from './audit-prune.js';

// Git hooks
export type { EnsureGitHooksOptions, HookCheckResult, ManagedHook } from './hooks.js';
export { checkGitHooks, ensureGitHooks, MANAGED_HOOKS } from './hooks.js';

// Injection
export type { InjectionCheckResult } from './injection.js';
export {
  buildContributorInjectionBlock,
  checkInjection,
  ensureInjection,
  getInjectionTemplateContent,
} from './injection.js';

// CAAMP bootstrap
export { bootstrapCaamp } from './caamp-init.js';

// Constants
export { CORE_PROTECTED_FILES } from './constants.js';

// Repair
export type { RepairAction } from './repair.js';
export {
  repairMissingSizes,
  repairMissingCompletedAt,
  runAllRepairs,
} from './repair.js';

// Upgrade
export type { UpgradeAction, UpgradeResult } from './upgrade.js';
export { runUpgrade } from './upgrade.js';
