/**
 * @packageDocumentation
 * Provides the public API surface for the CAAMP library, re-exporting types,
 * registry functions, detection utilities, skill management,
 * instruction file injection, marketplace search, and
 * format-agnostic config read/write operations.
 */

export type {
  BatchInstallOptions,
  BatchInstallResult,
  InstructionUpdateSummary,
  SkillBatchOperation,
} from './core/advanced/orchestration.js';
// Advanced orchestration
export {
  installBatchWithRollback,
  selectProvidersByMinimumPriority,
  updateInstructionsSingleOperation,
} from './core/advanced/orchestration.js';
// Formats
export { readConfig, removeConfig, writeConfig } from './core/formats/index.js';
export { deepMerge, ensureDir, getNestedValue } from './core/formats/utils.js';
export type {
  Harness,
  HarnessScope,
  McpServerSpec,
  SubagentHandle,
  SubagentResult,
  SubagentTask,
} from './core/harness/index.js';
// Harness layer
export {
  getAllHarnesses,
  getHarnessFor,
  getPrimaryHarness,
  PiHarness,
  resolveDefaultTargetProviders,
} from './core/harness/index.js';
// Hooks normalizer
export type {
  CanonicalEventDefinition,
  CanonicalHookEvent,
  CrossProviderMatrix,
  HookCategory,
  HookHandlerType,
  HookMapping,
  HookSupportResult,
  HookSystemType,
  NormalizedHookEvent,
  ProviderHookProfile,
  ProviderHookSummary,
} from './core/hooks/index.js';
export {
  buildHookMatrix,
  CANONICAL_HOOK_EVENTS,
  getAllCanonicalEvents,
  getCanonicalEvent,
  getCanonicalEventsByCategory,
  getCommonEvents,
  getHookConfigPath,
  getHookMappingsVersion,
  getHookSupport,
  getHookSystemType,
  getMappedProviderIds,
  getProviderHookProfile,
  getProviderOnlyEvents,
  getProviderSummary,
  getProvidersForEvent,
  getSupportedEvents,
  getUnsupportedEvents,
  HOOK_CATEGORIES,
  resolveNativeEvent,
  supportsHook,
  toCanonical,
  toNative,
  toNativeBatch,
  translateToAll,
} from './core/hooks/index.js';
export type {
  EnsureProviderInstructionFileOptions,
  EnsureProviderInstructionFileResult,
} from './core/instructions/injector.js';
// Instructions
export {
  checkAllInjections,
  checkInjection,
  ensureAllProviderInstructionFiles,
  ensureProviderInstructionFile,
  inject,
  injectAll,
  removeInjection,
} from './core/instructions/injector.js';
export type { InjectionTemplate } from './core/instructions/templates.js';
export {
  buildInjectionContent,
  generateInjectionContent,
  generateSkillsSection,
  groupByInstructFile,
  parseInjectionContent,
} from './core/instructions/templates.js';
// Logger
export { isQuiet, isVerbose, setQuiet, setVerbose } from './core/logger.js';
// Marketplace
export { MarketplaceClient } from './core/marketplace/client.js';
export type { MarketplaceResult } from './core/marketplace/types.js';
// Canonical path utilities
export {
  getAgentsConfigPath,
  getAgentsHome,
  getAgentsInstructFile,
  getAgentsLinksDir,
  getAgentsMcpDir,
  getAgentsMcpServersPath,
  getAgentsSpecDir,
  getAgentsWikiDir,
  getCanonicalSkillsDir,
  getLockFilePath,
  getPlatformLocations,
  getProjectAgentsDir,
  resolveProviderSkillsDirs,
  resolveRegistryTemplatePath,
} from './core/paths/standard.js';
// Platform path resolution
export type { PlatformPaths, SystemInfo } from './core/platform-paths.js';
export {
  _resetPlatformPathsCache,
  getPlatformPaths,
  getSystemInfo,
} from './core/platform-paths.js';
// Result types from core modules
export type { DetectionCacheOptions, DetectionResult } from './core/registry/detection.js';
// Detection
export {
  detectAllProviders,
  detectProjectProviders,
  detectProvider,
  getInstalledProviders,
  resetDetectionCache,
} from './core/registry/detection.js';
// Registry
export {
  buildSkillsMap,
  getAllProviders,
  getCommonHookEvents,
  getEffectiveSkillsPaths,
  getInstructionFiles,
  getPrimaryProvider,
  getProvider,
  getProviderCapabilities,
  getProviderCount,
  getProvidersByHookEvent,
  getProvidersByInstructFile,
  getProvidersByPriority,
  getProvidersBySkillsPrecedence,
  getProvidersBySpawnCapability,
  getProvidersByStatus,
  getRegistryVersion,
  getSpawnCapableProviders,
  providerSupports,
  providerSupportsById,
  resolveAlias,
} from './core/registry/providers.js';
// Spawn adapter
export type { SpawnAdapter, SpawnOptions, SpawnResult } from './core/registry/spawn-adapter.js';
export { scanDirectory, scanFile, toSarif } from './core/skills/audit/scanner.js';
// Skills catalog (pluggable library)
export * as catalog from './core/skills/catalog.js';
// Skills library registration
export {
  clearRegisteredLibrary,
  registerSkillLibrary,
  registerSkillLibraryFromPath,
} from './core/skills/catalog.js';
export { discoverSkill, discoverSkills, parseSkillFile } from './core/skills/discovery.js';
export type { SkillInstallResult } from './core/skills/installer.js';
// Skills
export { installSkill, listCanonicalSkills, removeSkill } from './core/skills/installer.js';
// Skills integrity
export type { SkillIntegrityResult, SkillIntegrityStatus } from './core/skills/integrity.js';
export {
  checkAllSkillIntegrity,
  checkSkillIntegrity,
  isCaampOwnedSkill,
  shouldOverrideSkill,
  validateInstructionIntegrity,
} from './core/skills/integrity.js';
// Skills library loaders
export {
  buildLibraryFromFiles,
  loadLibraryFromModule,
} from './core/skills/library-loader.js';
// Skills lock
export {
  checkAllSkillUpdates,
  checkSkillUpdate,
  getTrackedSkills,
  recordSkillInstall,
  removeSkillFromLock,
} from './core/skills/lock.js';
export type {
  NormalizedRecommendationCriteria,
  RankedSkillRecommendation,
  RecommendationCriteriaInput,
  RecommendationErrorCode,
  RecommendationOptions,
  RecommendationReason,
  RecommendationReasonCode,
  RecommendationScoreBreakdown,
  RecommendationValidationIssue,
  RecommendationValidationResult,
  RecommendationWeights,
  RecommendSkillsResult,
} from './core/skills/recommendation.js';
export {
  normalizeRecommendationCriteria,
  RECOMMENDATION_ERROR_CODES,
  rankSkills,
  scoreSkillRecommendation,
  tokenizeCriteriaValue,
  validateRecommendationCriteria,
} from './core/skills/recommendation.js';
export {
  formatSkillRecommendations,
  recommendSkills,
  searchSkills,
} from './core/skills/recommendation-api.js';
export type { ValidationIssue, ValidationResult } from './core/skills/validator.js';
export { validateSkill } from './core/skills/validator.js';
// Source parsing
export { isMarketplaceScoped, parseSource } from './core/sources/parser.js';
// Types
export type {
  AuditFinding,
  AuditResult,
  AuditRule,
  AuditSeverity,
  CaampLockFile,
  ConfigFormat,
  CtDispatchMatrix,
  CtManifest,
  CtManifestSkill,
  CtProfileDefinition,
  // Backward-compat aliases (deprecated)
  CtSkillEntry,
  CtValidationIssue,
  CtValidationResult,
  GlobalOptions,
  HookEvent,
  InjectionCheckResult,
  InjectionStatus,
  LockEntry,
  MarketplaceSearchResult,
  MarketplaceSkill,
  McpConfigFormat,
  McpServerConfig,
  McpServerEntry,
  McpTransportType,
  ParsedSource,
  Provider,
  ProviderCapabilities,
  ProviderHarnessCapability,
  ProviderHooksCapability,
  ProviderMcpCapability,
  ProviderPriority,
  ProviderSkillsCapability,
  ProviderSpawnCapability,
  ProviderStatus,
  RegistryHarnessKind,
  RegistryHookCatalog,
  RegistryHookFormat,
  SkillEntry,
  // Primary SkillLibrary types
  SkillLibrary,
  SkillLibraryDispatchMatrix,
  SkillLibraryEntry,
  SkillLibraryManifest,
  SkillLibraryManifestSkill,
  SkillLibraryProfile,
  SkillLibraryValidationIssue,
  SkillLibraryValidationResult,
  SkillMetadata,
  // Capability types
  SkillsPrecedence,
  SourceType,
  SpawnMechanism,
  TransportType,
} from './types.js';
