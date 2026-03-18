/**
 * Skills system - main entry point.
 * Re-exports all skills subsystems and CAAMP delegated types.
 *
 * @epic T4454
 * @task T4516
 */

// Re-export CAAMP catalog for direct access by consumers
export { catalog } from '@cleocode/caamp';
// Agents
export { agentExists, getAgentsDir, getSubagentConfig, loadAgentConfig } from './agents/config.js';
export { installAgent, installAllAgents, uninstallAgent } from './agents/install.js';
export {
  getAgent,
  listAgents,
  readRegistry,
  registerAgent,
  syncRegistry,
  unregisterAgent,
} from './agents/registry.js';

// Discovery & paths
export {
  caampDiscoverSkill,
  caampDiscoverSkills,
  // CAAMP delegated discovery (T4679)
  caampParseSkillFile,
  discoverAllSkills,
  discoverSkill,
  discoverSkillsInDir,
  findSkill,
  generateManifest,
  getSharedDir,
  getSkillSearchPaths,
  getSkillsDir,
  listCanonicalSkillNames,
  mapSkillName,
  parseFrontmatter,
  resolveTemplatePath,
  toSkillSummary,
} from './discovery.js';
export type { MultiSkillComposition } from './dispatch.js';
// Dispatch
export {
  autoDispatch,
  dispatchExplicit,
  getProtocolForDispatch,
  prepareSpawnContext,
  prepareSpawnMulti,
} from './dispatch.js';
export {
  buildTaskContext,
  injectProtocol,
  loadProtocolBase,
  orchestratorSpawnSkill,
  prepareTokenValues,
} from './injection/subagent.js';
export type { TokenValues } from './injection/token.js';
// Injection
export {
  buildDefaults,
  hasUnresolvedTokens,
  injectTokens,
  loadAndInject,
  loadPlaceholders,
  setFullContext,
  validateAllTokens,
  validateRequired,
  validateTokenValue,
} from './injection/token.js';
// Install
export { installSkill } from './install.js';
export type {
  ConsensusResult,
  ContributionConflict,
  ContributionDecision,
} from './manifests/contribution.js';
export {
  computeConsensus,
  createContributionManifestEntry,
  detectConflicts,
  generateContributionId,
  getContributionInjection,
  validateContributionTask,
} from './manifests/contribution.js';
// Manifests
export {
  appendManifest,
  archiveEntry,
  ensureOutputs,
  filterEntries,
  findEntry,
  getFollowupTaskIds,
  getPendingFollowup,
  readManifest,
  rotateManifest,
  taskHasResearch,
} from './manifests/research.js';
export {
  invalidateCache,
  isCacheFresh,
  regenerateCache,
  resolveManifest,
} from './manifests/resolver.js';
export type { MarketplaceSkill, SkillsMpConfig } from './marketplace.js';
// Marketplace
export {
  getSkill as getMpSkill,
  isEnabled as isMpEnabled,
  loadConfig as loadMpConfig,
  searchSkills,
} from './marketplace.js';
export type { BatchSpawnEntry, BatchSpawnResult } from './orchestrator/spawn.js';
export { buildPrompt, canParallelize, spawn, spawnBatch } from './orchestrator/spawn.js';
export type { PauseStatus, SessionInitResult } from './orchestrator/startup.js';
// Orchestrator
export {
  analyzeDependencies,
  generateHitlSummary,
  getContextState,
  getNextTask,
  getReadyTasks,
  getThresholds,
  sessionInit,
  shouldPause,
} from './orchestrator/startup.js';
export {
  validateManifestIntegrity,
  validateOrchestratorCompliance,
  validateSubagentOutput,
  verifyCompliance,
} from './orchestrator/validator.js';
export type {
  SkillSearchPath as MultiSourceSkillSearchPath,
  SkillSourceMode,
  SkillSourceType,
} from './skill-paths.js';
// Skill paths (multi-source resolver)
export {
  getSkillSearchPaths as getMultiSourceSkillPaths,
  getSkillSourceType,
  resolveProtocolPath,
  resolveSharedPath,
  resolveSkillPath,
} from './skill-paths.js';
// Test utilities
export {
  formatDateYMD,
  formatIsoDate,
  getCurrentTimestamp,
  isValidIsoDate,
} from './test-utility.js';
// CAAMP re-exports (delegated types and catalog bridge)
// Types
export type {
  AgentConfig,
  AgentRegistry,
  AgentRegistryEntry,
  CaampSkillMetadata,
  ComplianceResult,
  CtDispatchMatrix,
  CtManifest,
  CtManifestSkill,
  CtProfileDefinition,
  CtSkillEntry,
  CtValidationIssue,
  CtValidationResult,
  DependencyAnalysis,
  DependencyWave,
  DispatchResult,
  DispatchStrategy,
  HitlSummary,
  InstalledSkill,
  InstalledSkillsFile,
  ManifestEntry,
  ManifestValidationResult,
  McpServerConfig,
  OrchestratorThresholds,
  PreSpawnCheckResult,
  Provider,
  Skill,
  SkillFrontmatter,
  SkillManifest,
  SkillProtocolType,
  SkillSearchPath,
  SkillSearchScope,
  SkillSummary,
  SpawnPromptResult,
  TokenContext,
  TokenDefinition,
  TokenValidationResult,
} from './types.js';
export { SKILL_NAME_MAP } from './types.js';
export type { IssueSeverity, SkillValidationResult, ValidationIssue } from './validation.js';
// Validation
export {
  validateReturnMessage,
  validateSkill,
  validateSkills,
} from './validation.js';
// Version tracking (CAAMP primary)
export {
  checkAllSkillUpdatesAsync,
  checkSkillUpdateAsync,
  getInstalledVersionAsync,
} from './version.js';
