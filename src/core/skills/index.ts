/**
 * Skills system - main entry point.
 * Re-exports all skills subsystems and CAAMP delegated types.
 *
 * @epic T4454
 * @task T4516
 */

// CAAMP re-exports (delegated types and catalog bridge)
export type {
  Provider,
  CaampSkillMetadata,
  McpServerConfig,
  CtSkillEntry,
  CtDispatchMatrix,
  CtManifest,
  CtManifestSkill,
  CtProfileDefinition,
  CtValidationResult,
  CtValidationIssue,
} from './types.js';

// Re-export CAAMP catalog for direct access by consumers
export { catalog } from '@cleocode/caamp';

// Types
export type {
  Skill,
  SkillFrontmatter,
  SkillSummary,
  SkillManifest,
  SkillProtocolType,
  SkillSearchPath,
  SkillSearchScope,
  AgentConfig,
  AgentRegistryEntry,
  AgentRegistry,
  DispatchResult,
  DispatchStrategy,
  TokenDefinition,
  TokenContext,
  TokenValidationResult,
  OrchestratorThresholds,
  PreSpawnCheckResult,
  SpawnPromptResult,
  DependencyWave,
  DependencyAnalysis,
  HitlSummary,
  ManifestEntry,
  ManifestValidationResult,
  ComplianceResult,
  InstalledSkill,
  InstalledSkillsFile,
} from './types.js';

export { SKILL_NAME_MAP } from './types.js';

// Discovery & paths
export {
  getSkillSearchPaths,
  getSkillsDir,
  getSharedDir,
  mapSkillName,
  listCanonicalSkillNames,
  parseFrontmatter,
  discoverSkill,
  discoverSkillsInDir,
  discoverAllSkills,
  findSkill,
  toSkillSummary,
  generateManifest,
  resolveTemplatePath,
  // CAAMP delegated discovery (T4679)
  caampParseSkillFile,
  caampDiscoverSkill,
  caampDiscoverSkills,
} from './discovery.js';

// Dispatch
export {
  autoDispatch,
  dispatchExplicit,
  getProtocolForDispatch,
  prepareSpawnContext,
  prepareSpawnMulti,
} from './dispatch.js';
export type { MultiSkillComposition } from './dispatch.js';

// Validation
export {
  validateSkill,
  validateSkills,
  validateReturnMessage,
} from './validation.js';
export type { SkillValidationResult, ValidationIssue, IssueSeverity } from './validation.js';

// Agents
export { loadAgentConfig, getSubagentConfig, agentExists, getAgentsDir } from './agents/config.js';
export { readRegistry, registerAgent, unregisterAgent, getAgent, listAgents, syncRegistry } from './agents/registry.js';
export { installAgent, installAllAgents, uninstallAgent } from './agents/install.js';

// Orchestrator
export {
  getThresholds,
  getContextState,
  sessionInit,
  shouldPause,
  analyzeDependencies,
  getNextTask,
  getReadyTasks,
  generateHitlSummary,
} from './orchestrator/startup.js';
export type { SessionInitResult, PauseStatus } from './orchestrator/startup.js';

export { buildPrompt, spawn, canParallelize, spawnBatch } from './orchestrator/spawn.js';
export type { BatchSpawnEntry, BatchSpawnResult } from './orchestrator/spawn.js';

export {
  validateSubagentOutput,
  validateManifestIntegrity,
  verifyCompliance,
  validateOrchestratorCompliance,
} from './orchestrator/validator.js';

// Manifests
export {
  ensureOutputs,
  readManifest,
  appendManifest,
  findEntry,
  filterEntries,
  getPendingFollowup,
  getFollowupTaskIds,
  taskHasResearch,
  archiveEntry,
  rotateManifest,
} from './manifests/research.js';

export { resolveManifest, isCacheFresh, invalidateCache, regenerateCache } from './manifests/resolver.js';

export {
  generateContributionId,
  validateContributionTask,
  getContributionInjection,
  detectConflicts,
  computeConsensus,
  createContributionManifestEntry,
} from './manifests/contribution.js';
export type { ContributionDecision, ContributionConflict, ConsensusResult } from './manifests/contribution.js';

// Injection
export {
  injectTokens,
  hasUnresolvedTokens,
  loadAndInject,
  validateRequired,
  validateAllTokens,
  validateTokenValue,
  buildDefaults,
  loadPlaceholders,
  setFullContext,
} from './injection/token.js';
export type { TokenValues } from './injection/token.js';

export {
  loadProtocolBase,
  buildTaskContext,
  injectProtocol,
  orchestratorSpawnSkill,
  prepareTokenValues,
} from './injection/subagent.js';

// Install
export {
  getSkillsFromManifest,
  installSkill,
  installAllSkills,
  uninstallSkill,
  uninstallAllSkills,
} from './install.js';

// Marketplace
export {
  loadConfig as loadMpConfig,
  searchSkills,
  getSkill as getMpSkill,
  isEnabled as isMpEnabled,
} from './marketplace.js';
export type { SkillsMpConfig, MarketplaceSkill } from './marketplace.js';

// Version tracking (CAAMP primary, CLEO local fallback - T4680)
export {
  readInstalledSkills,
  saveInstalledSkills,
  initInstalledSkills,
  recordSkillVersion,
  getInstalledVersion,
  getInstalledVersionAsync,
  checkSkillUpdateAsync,
  checkSkillUpdates,
  applySkillUpdates,
} from './version.js';

// Skill paths (multi-source resolver)
export {
  getSkillSearchPaths as getMultiSourceSkillPaths,
  resolveSkillPath,
  resolveProtocolPath,
  resolveSharedPath,
  getSkillSourceType,
} from './skill-paths.js';
export type { SkillSourceType, SkillSourceMode, SkillSearchPath as MultiSourceSkillSearchPath } from './skill-paths.js';

// Test utilities
export {
  formatIsoDate,
  getCurrentTimestamp,
  isValidIsoDate,
  formatDateYMD,
} from './test-utility.js';
