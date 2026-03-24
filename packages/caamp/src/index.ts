/**
 * @packageDocumentation
 * Provides the public API surface for the CAAMP library, re-exporting types,
 * registry functions, detection utilities, skill management, MCP server
 * installation, instruction file injection, marketplace search, and
 * format-agnostic config read/write operations.
 */

// Types
export type {
  Provider,
  ProviderPriority,
  ProviderStatus,
  McpServerConfig,
  McpServerEntry,
  ConfigFormat,
  TransportType,
  SourceType,
  ParsedSource,
  SkillMetadata,
  SkillEntry,
  LockEntry,
  CaampLockFile,
  MarketplaceSkill,
  MarketplaceSearchResult,
  AuditRule,
  AuditFinding,
  AuditResult,
  AuditSeverity,
  InjectionStatus,
  InjectionCheckResult,
  GlobalOptions,
  // Capability types
  SkillsPrecedence,
  ProviderSkillsCapability,
  ProviderHooksCapability,
  ProviderSpawnCapability,
  ProviderCapabilities,
  HookEvent,
  SpawnMechanism,
  // Primary SkillLibrary types
  SkillLibrary,
  SkillLibraryEntry,
  SkillLibraryValidationResult,
  SkillLibraryValidationIssue,
  SkillLibraryProfile,
  SkillLibraryDispatchMatrix,
  SkillLibraryManifest,
  SkillLibraryManifestSkill,
  // Backward-compat aliases (deprecated)
  CtSkillEntry,
  CtValidationResult,
  CtValidationIssue,
  CtProfileDefinition,
  CtDispatchMatrix,
  CtManifest,
  CtManifestSkill,
} from "./types.js";

// Spawn adapter
export type { SpawnOptions, SpawnResult, SpawnAdapter } from "./core/registry/spawn-adapter.js";

// Result types from core modules
export type { DetectionResult, DetectionCacheOptions } from "./core/registry/detection.js";
export type { InstallResult } from "./core/mcp/installer.js";
export type { SkillInstallResult } from "./core/skills/installer.js";
export type { ValidationResult, ValidationIssue } from "./core/skills/validator.js";
export type {
  RecommendationErrorCode,
  RecommendationValidationIssue,
  RecommendationValidationResult,
  RecommendationCriteriaInput,
  NormalizedRecommendationCriteria,
  RecommendationReasonCode,
  RecommendationReason,
  RecommendationScoreBreakdown,
  RankedSkillRecommendation,
  RecommendationOptions,
  RecommendationWeights,
  RecommendSkillsResult,
} from "./core/skills/recommendation.js";
export type {
  McpBatchOperation,
  SkillBatchOperation,
  BatchInstallOptions,
  BatchInstallResult,
  ConflictPolicy,
  McpConflictCode,
  McpConflict,
  McpPlanApplyResult,
  InstructionUpdateSummary,
  DualScopeConfigureOptions,
  DualScopeConfigureResult,
} from "./core/advanced/orchestration.js";

// Registry
export {
  getAllProviders,
  getProvider,
  resolveAlias,
  getProvidersByPriority,
  getProvidersByStatus,
  getProvidersByInstructFile,
  getInstructionFiles,
  getProviderCount,
  getRegistryVersion,
  getProvidersByHookEvent,
  getCommonHookEvents,
  providerSupports,
  getSpawnCapableProviders,
  getProvidersBySpawnCapability,
  getProvidersBySkillsPrecedence,
  getEffectiveSkillsPaths,
  buildSkillsMap,
  getProviderCapabilities,
  providerSupportsById,
} from "./core/registry/providers.js";

// Detection
export {
  detectProvider,
  detectAllProviders,
  getInstalledProviders,
  detectProjectProviders,
  resetDetectionCache,
} from "./core/registry/detection.js";

// Canonical path utilities
export {
  getAgentsHome,
  getProjectAgentsDir,
  getCanonicalSkillsDir,
  getLockFilePath,
  getPlatformLocations,
  resolveRegistryTemplatePath,
  getAgentsMcpDir,
  getAgentsMcpServersPath,
  getAgentsInstructFile,
  getAgentsConfigPath,
  getAgentsWikiDir,
  getAgentsSpecDir,
  getAgentsLinksDir,
  resolveProviderSkillsDirs,
} from "./core/paths/standard.js";

// Platform path resolution
export type { PlatformPaths, SystemInfo } from "./core/platform-paths.js";
export { getPlatformPaths, getSystemInfo, _resetPlatformPathsCache } from "./core/platform-paths.js";

// Source parsing
export { parseSource, isMarketplaceScoped } from "./core/sources/parser.js";

// Skills catalog (pluggable library)
export * as catalog from "./core/skills/catalog.js";

// Skills library registration
export {
  registerSkillLibrary,
  registerSkillLibraryFromPath,
  clearRegisteredLibrary,
} from "./core/skills/catalog.js";

// Skills library loaders
export {
  loadLibraryFromModule,
  buildLibraryFromFiles,
} from "./core/skills/library-loader.js";

// Skills
export { installSkill, removeSkill, listCanonicalSkills } from "./core/skills/installer.js";
export { discoverSkills, discoverSkill, parseSkillFile } from "./core/skills/discovery.js";
export { validateSkill } from "./core/skills/validator.js";
export {
  RECOMMENDATION_ERROR_CODES,
  tokenizeCriteriaValue,
  normalizeRecommendationCriteria,
  validateRecommendationCriteria,
  scoreSkillRecommendation,
  rankSkills,
} from "./core/skills/recommendation.js";
export { searchSkills, recommendSkills, formatSkillRecommendations } from "./core/skills/recommendation-api.js";
export { scanFile, scanDirectory, toSarif } from "./core/skills/audit/scanner.js";

// CLEO core
export type { CleoChannel, CleoProfileBuildResult } from "./core/mcp/cleo.js";
export {
  buildCleoProfile,
  normalizeCleoChannel,
  resolveCleoServerName,
  resolveChannelFromServerName,
  checkCommandReachability,
  extractVersionTag,
  parseEnvAssignments,
  isCleoSource,
} from "./core/mcp/cleo.js";

// MCP install
export { installMcpServer, installMcpServerToAll, buildServerConfig } from "./core/mcp/installer.js";
export { getTransform } from "./core/mcp/transforms.js";

// MCP read/list/remove
export { resolveConfigPath, listMcpServers, listAllMcpServers, listAgentsMcpServers, removeMcpServer } from "./core/mcp/reader.js";

// MCP lock
export {
  readLockFile,
  recordMcpInstall,
  removeMcpFromLock,
  getTrackedMcpServers,
  saveLastSelectedAgents,
  getLastSelectedAgents,
} from "./core/mcp/lock.js";

// MCP reconcile
export type { InferredLockData, ReconcileOptions, ReconcileResult } from "./core/mcp/reconcile.js";
export { inferCleoLockData, reconcileCleoLock } from "./core/mcp/reconcile.js";

// Skills lock
export {
  recordSkillInstall,
  removeSkillFromLock,
  getTrackedSkills,
  checkSkillUpdate,
  checkAllSkillUpdates,
} from "./core/skills/lock.js";

// Skills integrity
export type { SkillIntegrityStatus, SkillIntegrityResult } from "./core/skills/integrity.js";
export {
  isCaampOwnedSkill,
  checkSkillIntegrity,
  checkAllSkillIntegrity,
  shouldOverrideSkill,
  validateInstructionIntegrity,
} from "./core/skills/integrity.js";

// Marketplace
export { MarketplaceClient } from "./core/marketplace/client.js";
export type { MarketplaceResult } from "./core/marketplace/types.js";

// Instructions
export {
  inject,
  checkInjection,
  removeInjection,
  checkAllInjections,
  injectAll,
  ensureProviderInstructionFile,
  ensureAllProviderInstructionFiles,
} from "./core/instructions/injector.js";
export type {
  EnsureProviderInstructionFileOptions,
  EnsureProviderInstructionFileResult,
} from "./core/instructions/injector.js";
export { generateInjectionContent, generateSkillsSection, groupByInstructFile, buildInjectionContent, parseInjectionContent } from "./core/instructions/templates.js";
export type { InjectionTemplate } from "./core/instructions/templates.js";

// Advanced orchestration
export {
  selectProvidersByMinimumPriority,
  installBatchWithRollback,
  detectMcpConfigConflicts,
  applyMcpInstallWithPolicy,
  updateInstructionsSingleOperation,
  configureProviderGlobalAndProject,
} from "./core/advanced/orchestration.js";

// Formats
export { readConfig, writeConfig, removeConfig } from "./core/formats/index.js";
export { getNestedValue, deepMerge, ensureDir } from "./core/formats/utils.js";

// Hooks normalizer
export type {
  CanonicalHookEvent,
  CanonicalEventDefinition,
  HookCategory,
  HookSystemType,
  HookHandlerType,
  HookMapping,
  ProviderHookProfile,
  NormalizedHookEvent,
  HookSupportResult,
  ProviderHookSummary,
  CrossProviderMatrix,
} from "./core/hooks/index.js";
export {
  CANONICAL_HOOK_EVENTS,
  HOOK_CATEGORIES,
  toNative,
  toCanonical,
  toNativeBatch,
  supportsHook,
  getHookSupport,
  getSupportedEvents,
  getUnsupportedEvents,
  getProvidersForEvent,
  getCommonEvents,
  getProviderSummary,
  buildHookMatrix,
  getHookSystemType,
  getHookConfigPath,
  getProviderOnlyEvents,
  translateToAll,
  resolveNativeEvent,
  getHookMappingsVersion,
  getCanonicalEvent,
  getAllCanonicalEvents,
  getCanonicalEventsByCategory,
  getProviderHookProfile,
  getMappedProviderIds,
} from "./core/hooks/index.js";

// Logger
export { setVerbose, setQuiet, isVerbose, isQuiet } from "./core/logger.js";
