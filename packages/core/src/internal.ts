/**
 * @cleocode/core/internal — Internal API for @cleocode/cleo.
 *
 * This entry point is a SUPERSET of the public API. It re-exports everything
 * from `@cleocode/core` plus additional symbols needed by the dispatch layer,
 * CLI commands, and engine adapters inside @cleocode/cleo.
 *
 * External consumers should import from `@cleocode/core` (the public API).
 * Only @cleocode/cleo should import from `@cleocode/core/internal`.
 *
 * @package @cleocode/core
 * @internal
 */

// Runtime guard — warn when the internal barrel is imported outside of the
// known @cleocode/* workspace packages (STABILITY.md §./internal, T1562/V2).
// This guard fires once per process; it does NOT throw so existing callers are
// not disrupted, but it surfaces clearly in logs for any external consumer.
(function warnInternalImport() {
  if (typeof process !== 'undefined' && process.env['CLEO_ALLOW_INTERNAL'] !== '1') {
    // Check for explicit opt-out — workspace packages set this via env or pass silently.
    // External callers will see the warning in stderr on first import.
    const callerHint = process.env['npm_package_name'] ?? '';
    if (callerHint && !callerHint.startsWith('@cleocode/')) {
      process.stderr.write(
        '[CLEO] WARNING: @cleocode/core/internal is an internal API not intended for external ' +
          'consumers. Import from @cleocode/core or a stable subpath instead. ' +
          'Set CLEO_ALLOW_INTERNAL=1 to suppress this warning (STABILITY.md §./internal).\n',
      );
    }
  }
})();

import './lib/suppress-sqlite-warning.js';

// ---------------------------------------------------------------------------
// Re-export the entire public API (superset)
// ---------------------------------------------------------------------------

export * from './index.js';

// ---------------------------------------------------------------------------
// Extended flat exports (required by @cleocode/cleo)
// ---------------------------------------------------------------------------

// Re-export attachment types from contracts for dispatch layer
export type {
  AttachmentRef,
  LlmsTxtAttachment,
  LocalFileAttachment,
  UrlAttachment,
} from '@cleocode/contracts';
// Code analysis (Smart Explore) — canonical source: @cleocode/nexus
export {
  batchParse,
  isTreeSitterAvailable,
  parseFile,
  type SmartSearchOptions,
  smartOutline,
  smartSearch,
  smartUnfold,
} from '@cleocode/nexus';
export { exportTasks } from './admin/export.js';
export { exportTasksPackage } from './admin/export-tasks.js';
// Admin — system help (T1571)
export type { HelpData } from './admin/help.js';
// Admin
export { computeHelp, getSystemHelp, SYSTEM_HELP_TOPICS } from './admin/help.js';
export { importTasks } from './admin/import.js';
export { importFromPackage, importTasksPackage } from './admin/import-tasks.js';
// ADRs
export { findAdrs } from './adrs/find.js';
export { listAdrs, showAdr, syncAdrsToDb, validateAllAdrs } from './adrs/index.js';
export { reconstructLineage } from './audit/reconstruct.js';
// Audit
export type { AuditEntry } from './audit.js';
// Backfill
export type { BackfillOptions, BackfillResult, BackfillTaskChange } from './backfill/index.js';
export { backfillTasks, generateAcFromDescription } from './backfill/index.js';
export type {
  BootstrapContext,
  BootstrapOptions,
  BootstrapVerificationResult,
} from './bootstrap.js';
// Bootstrap (global setup)
export {
  bootstrapGlobalCleo,
  installSkillsGlobally,
  verifyBootstrapComplete,
} from './bootstrap.js';
export type { ViolationLogEntry } from './compliance/protocol-enforcement.js';
// Compliance
export { ProtocolEnforcer, protocolEnforcer } from './compliance/protocol-enforcement.js';
export type {
  ProtocolRule,
  ProtocolValidationResult,
  ProtocolViolation,
  RequirementLevel,
  ViolationSeverity,
} from './compliance/protocol-rules.js';
export { PROTOCOL_RULES } from './compliance/protocol-rules.js';
// Context window monitoring (T1571)
export type { ContextData } from './context/index.js';
export { getContextStatus, getContextWindow, listContextSessions } from './context/index.js';
// Docs generator — llms.txt format generation (T798)
export type { GenerateDocsOptions, GenerateDocsResult } from './docs/docs-generator.js';
export { generateDocsLlmsTxt } from './docs/docs-generator.js';
// Docs ops — llmtxt primitive wrappers (search, merge, graph, rank, versions, publish) (T1041)
export type {
  DocsGraphEdge,
  DocsGraphNode,
  DocsGraphResult,
  DocsMergeResult,
  DocsRankHit,
  DocsRankResult,
  DocsSearchHit,
  DocsSearchResult,
  DocsVersionEntry,
  DocsVersionsResult,
} from './docs/docs-ops.js';
export {
  buildDocsGraph,
  listDocVersions,
  mergeDocs,
  publishDocs,
  rankDocs,
  searchDocs,
} from './docs/docs-ops.js';
// Docs export — rich Markdown export of a task with frontmatter + attachments (T947)
export type { ExportDocumentOptions, ExportDocumentResult } from './docs/export-document.js';
export { exportDocument } from './docs/export-document.js';
// Git hooks (T1588) — project-agnostic POSIX commit-msg + pre-push T-ID enforcement
export type {
  CleoHookName,
  InstallCleoHooksOptions,
  InstallCleoHooksResult,
} from './git/hooks-install.js';
export {
  CLEO_HOOK_NAMES,
  CLEO_HOOK_SENTINEL,
  installCleoHooks,
  isCleoManagedHook,
  resolveGitDir,
  resolveHooksDir,
} from './git/hooks-install.js';
// Harness
export type {
  HarnessSpawnCapability,
  HarnessSpawnProviderSelection,
  HarnessSpawnProviderSelectionResult,
} from './harness/index.js';
export { selectHarnessSpawnProvider } from './harness/index.js';
export type { PayloadValidationResult } from './hooks/payload-schemas.js';
export { validatePayload } from './hooks/payload-schemas.js';
// Hooks
export type { HookEvent, ProviderHookEvent } from './hooks/provider-hooks.js';
export { isProviderHookEvent } from './hooks/types.js';
// Init (additional)
export { isAutoInitEnabled } from './init.js';
export type {
  AdaptiveValidationSuggestion,
  GateFocusRecommendation,
  StorePredictionOptions,
  VerificationConfidenceScore,
} from './intelligence/adaptive-validation.js';
// Intelligence — adaptive validation (suggestGateFocus, scoreVerificationConfidence)
export {
  predictAndStore,
  scoreVerificationConfidence,
  storePrediction,
  suggestGateFocus,
} from './intelligence/adaptive-validation.js';
export {
  analyzeChangeImpact,
  analyzeTaskImpact,
  calculateBlastRadius,
  predictImpact,
} from './intelligence/impact.js';
export {
  extractPatternsFromHistory,
  matchPatterns,
  storeDetectedPattern,
  updatePatternStats,
} from './intelligence/patterns.js';
export {
  calculateTaskRisk,
  gatherLearningContext,
  predictValidationOutcome,
} from './intelligence/prediction.js';
// Intelligence — quality prediction and pattern extraction
export type {
  AffectedTask,
  BlastRadius,
  BlastRadiusSeverity,
  ChangeImpact,
  ChangeType,
  DetectedPattern,
  ImpactAssessment,
  ImpactedTask,
  ImpactReport,
  LearningContext,
  PatternExtractionOptions,
  PatternMatch,
  PatternStatsUpdate,
  RiskAssessment,
  RiskFactor,
  ValidationPrediction,
} from './intelligence/types.js';
export { type AddIssueParams, type AddIssueResult, addIssue } from './issue/create.js';
// Issue
export { collectDiagnostics } from './issue/diagnostics.js';
// Lib — shared primitives
export {
  computeDelay,
  type RetryablePredicate,
  type RetryContext,
  type RetryOptions,
  withRetry as withRetryShared,
} from './lib/retry.js';
// Pipeline-stage invariants: the former TS backfills (T869, T871) were
// replaced in T877 by migration 20260417000000_t877-pipeline-stage-invariants
// which (a) SQL-native one-shot realigns drifted rows and (b) installs
// BEFORE INSERT/UPDATE triggers enforcing the invariants going forward.
// No runtime-callable API is needed anymore; the migration runs once via
// drizzle's __drizzle_migrations journal.
export {
  addChain,
  advanceInstance,
  createInstance,
  listChains,
  showChain,
} from './lifecycle/chain-store.js';
// Lifecycle
export {
  buildStageGuidance,
  checkGate,
  checkStagePrerequisites,
  failGate,
  formatStageGuidance,
  getLifecycleGates,
  getLifecycleHistory,
  getLifecycleStatus,
  getStagePrerequisites,
  isValidStage,
  listEpicsWithLifecycle,
  PIPELINE_STAGES,
  passGate,
  recordStageProgress,
  renderStageGuidance,
  resetStage,
  resolveStageAlias,
  STAGE_ALIASES,
  STAGE_SKILL_MAP,
  type Stage,
  type StageGuidance,
  skipStageWithReason,
  TIER_0_SKILLS,
} from './lifecycle/index.js';
// IVTR orchestration harness (T811 + T813 + T814)
export type {
  AutoRunGatesResult,
  IvtrPhase,
  IvtrPhaseEntry,
  IvtrState,
} from './lifecycle/ivtr-loop.js';
export {
  advanceIvtr,
  autoRunGatesAndRecord,
  E_IVTR_MAX_RETRIES,
  getIvtrState,
  loopBackIvtr,
  MAX_LOOP_BACKS_PER_PHASE,
  releaseIvtr,
  resolvePhasePrompt,
  startIvtr,
} from './lifecycle/ivtr-loop.js';
export { STAGE_DEFINITIONS } from './lifecycle/stages.js';
export { instantiateTessera, showTessera } from './lifecycle/tessera-engine.js';
// Lifecycle — verify explain (T1013 / T1541 / ADR-051 / ADR-057)
export {
  checkExplainVerification,
  type EvidenceEntry,
  type ExplainVerificationResult,
  type GateStateRecord,
  type GateStatusRawData,
} from './lifecycle/verification/explain.js';
export type { BrainBackfillResult } from './memory/brain-backfill.js';
export { backfillBrainGraph } from './memory/brain-backfill.js';
// Memory — brain export (T626-M6)
export type {
  BrainExportGexfResult,
  BrainExportJsonResult,
  BrainExportResult,
} from './memory/brain-export.js';
export { exportBrainAsGexf, exportBrainAsJson } from './memory/brain-export.js';
// Memory — brain lifecycle (temporal decay + consolidation + tier promotion)
export type {
  ConsolidationResult,
  DecayResult,
  EvictionRecord,
  PromotionRecord,
  PromotionResult,
  RunConsolidationResult,
} from './memory/brain-lifecycle.js';
export {
  applyTemporalDecay,
  consolidateMemories,
  runConsolidation,
  runTierPromotion,
} from './memory/brain-lifecycle.js';
// Memory — brain maintenance
export type {
  BrainMaintenanceConsolidationResult,
  BrainMaintenanceDecayResult,
  BrainMaintenanceEmbeddingsResult,
  BrainMaintenanceOptions,
  BrainMaintenanceReconciliationResult,
  BrainMaintenanceResult,
  BrainMaintenanceTierPromotionResult,
} from './memory/brain-maintenance.js';
export { runBrainMaintenance } from './memory/brain-maintenance.js';
export type { PurgeResult } from './memory/brain-purge.js';
export { purgeBrainNoise } from './memory/brain-purge.js';
export type {
  BudgetedEntry,
  BudgetedResult,
  BudgetedRetrievalOptions,
  PopulateEmbeddingsOptions,
  PopulateEmbeddingsResult,
} from './memory/brain-retrieval.js';
export { populateEmbeddings, retrieveWithBudget } from './memory/brain-retrieval.js';
// Memory — STDP plasticity (T626 phase 5)
export type {
  PlasticityStatsSummary,
  RecentPlasticityEvent,
  StdpPlasticityResult,
} from './memory/brain-stdp.js';
export { applyStdpPlasticity, getPlasticityStats } from './memory/brain-stdp.js';
export { migrateClaudeMem } from './memory/claude-mem-migration.js';
// Memory — dream cycle (T628 auto-consolidation)
export type {
  DreamCheckResult,
  DreamCycleOptions,
} from './memory/dream-cycle.js';
export {
  _resetDreamState,
  checkAndDream,
  checkIdleTrigger,
  checkVolumeTrigger,
  triggerManualDream,
} from './memory/dream-cycle.js';
// Memory — engine-compat
export {
  memoryBrainStats,
  memoryContradictions,
  memoryDecisionFind,
  memoryDecisionStore,
  memoryFetch,
  memoryFind,
  memoryGraphAdd,
  memoryGraphContext,
  memoryGraphNeighbors,
  memoryGraphRelated,
  memoryGraphRemove,
  memoryGraphShow,
  memoryGraphStatsFull,
  memoryGraphTrace,
  memoryLearningFind,
  memoryLearningStats,
  memoryLearningStore,
  memoryLink,
  memoryObserve,
  memoryPatternFind,
  memoryPatternStats,
  memoryPatternStore,
  memoryQualityReport,
  memoryReasonSimilar,
  memoryReasonWhy,
  memorySearchHybrid,
  memoryShow,
  memorySuperseded,
  memoryTimeline,
  memoryUnlink,
} from './memory/engine-compat.js';
// Memory — graph traversal query functions (T535)
export type {
  GraphStats,
  NodeContext,
  RelatedNode,
  TraceNode,
} from './memory/graph-queries.js';
// Memory — Observer/Reflector (T745: needed by cleo memory reflect CLI)
export type {
  ObserverResult,
  ReflectorResult,
  RunObserverOptions,
} from './memory/observer-reflector.js';
export { runObserver, runReflector } from './memory/observer-reflector.js';
// Memory — pipeline manifests
export {
  pipelineManifestAppend,
  pipelineManifestArchive,
  pipelineManifestFind,
  pipelineManifestList,
  pipelineManifestPending,
  pipelineManifestShow,
  pipelineManifestStats,
  readManifestEntries,
} from './memory/pipeline-manifest-sqlite.js';
export type {
  CorrelateOutcomesResult,
  MemoryOutcome,
  MemoryQualityReport,
} from './memory/quality-feedback.js';
// Memory — quality feedback loop (T555)
export {
  correlateOutcomes,
  getMemoryQualityReport,
  trackMemoryUsage,
} from './memory/quality-feedback.js';
// Metrics
export {
  autoRecordDispatchTokenUsage,
  clearTokenUsage,
  deleteTokenUsage,
  listTokenUsage,
  measureTokenExchange,
  recordTokenExchange,
  showTokenUsage,
  summarizeTokenUsage,
} from './metrics/token-service.js';
// Nexus
export {
  augmentSymbol,
  formatAugmentResults,
  // EngineResult wrappers (T1569 Wave 2)
  nexusAugment,
  nexusSearchCode,
} from './nexus/augment.js';
export {
  blockingAnalysis,
  buildGlobalGraph,
  criticalPath,
  // EngineResult wrappers (T1569 Wave 1)
  nexusBlockers,
  nexusCriticalPath,
  nexusDeps,
  nexusDepsQuery,
  nexusGraph,
  nexusOrphans,
  orphanDetection,
} from './nexus/deps.js';
export {
  // EngineResult wrappers (T1569 Wave 2)
  nexusDiscover,
  nexusSearch,
  searchAcrossProjects,
} from './nexus/discover.js';
export { installNexusAugmentHook } from './nexus/hooks-augment.js';
// EngineResult wrapper (T1569 Wave 1)
export { nexusImpact } from './nexus/impact.js';
// EngineResult wrappers (T1569 Wave 2 — Living Brain)
export {
  nexusBrainAnchors,
  nexusFullContext,
  nexusImpactFull,
  nexusTaskFootprint,
  nexusWhy,
} from './nexus/living-brain.js';
export { nexusSetPermission, setPermission } from './nexus/permissions.js';
// T1013: plasticity queries over nexus_relations weight/last_accessed_at columns (added in T998)
export {
  getColdSymbols,
  getHotNodes,
  getHotPaths,
  type NexusColdSymbol,
  type NexusHotNode,
  type NexusHotPath,
  type NexusPlasticityResult,
  // EngineResult wrappers (T1569 Wave 3)
  nexusColdSymbols,
  nexusHotNodes,
  nexusHotPaths,
} from './nexus/plasticity-queries.js';
export {
  // EngineResult wrappers (T1569 Wave 1)
  nexusResolve,
  nexusTopEntries,
  resolveTask,
  validateSyntax,
} from './nexus/query.js';
export type { NexusPermissionLevel, NexusProject, NexusProjectStats } from './nexus/registry.js';
export {
  nexusGetProject,
  nexusInit,
  // EngineResult wrappers (T1569 Wave 1)
  nexusInitialize,
  nexusList,
  nexusListProjects,
  nexusProjectsList,
  nexusProjectsRegister,
  nexusProjectsRemove,
  nexusReconcile,
  nexusReconcileProject,
  nexusRegister,
  nexusRegisterProject,
  nexusShowProject,
  nexusStatus,
  nexusSync,
  nexusSyncAll,
  nexusSyncProject,
  nexusUnregister,
  nexusUnregisterProject,
  nexusUpdateIndexStats,
} from './nexus/registry.js';
export {
  getSharingStatus,
  // EngineResult wrapper (T1569 Wave 2)
  nexusShareStatus,
} from './nexus/sharing/index.js';
// EngineResult wrappers (T1569 Wave 2 — Transfer + Snapshot)
export {
  nexusShareSnapshotExport,
  nexusShareSnapshotImport,
  nexusTransferExecute,
  nexusTransferPreview,
} from './nexus/transfer.js';
// Orchestrate handoff ops (T1570 Wave 4 — migrated from orchestrate-engine.ts)
export type {
  HandoffFailureDetails,
  HandoffSessionOps,
  HandoffState,
  HandoffStepState,
  HandoffStepStatus,
} from './orchestrate/handoff-ops.js';
export { orchestrateHandoff } from './orchestrate/handoff-ops.js';
// Orchestrate lifecycle ops (T1570 Wave 1 — migrated from orchestrate-engine.ts)
export {
  orchestrateBootstrap,
  orchestrateCheck,
  orchestrateCriticalPath,
  orchestrateParallel,
  orchestrateParallelEnd,
  orchestrateParallelStart,
  orchestrateSkillInject,
  orchestrateStartup,
  orchestrateUnblockOpportunities,
} from './orchestrate/lifecycle-ops.js';
// Orchestrate (T1596) — context-switch primitives
export type { PivotOptions, PivotResult } from './orchestrate/pivot.js';
export { PIVOT_AUDIT_FILE, pivotTask } from './orchestrate/pivot.js';
// Orchestrate plan (T1570 Wave 2 — migrated from orchestrate-engine.ts)
export type {
  OrchestratePlanInput,
  PlanWarning,
  PlanWave,
  PlanWorkerEntry,
} from './orchestrate/plan.js';
export {
  numericToAgentTier,
  openSignaldockDbForComposer,
  orchestratePlan,
} from './orchestrate/plan.js';
// Orchestrate query ops (T1570 Wave 1 — migrated from orchestrate-engine.ts)
export {
  loadTasks,
  orchestrateAnalyze,
  orchestrateContext,
  orchestrateNext,
  orchestrateReady,
  orchestrateStatus,
  orchestrateValidate,
  orchestrateWaves,
} from './orchestrate/query-ops.js';
// Orchestrate spawn ops (T1570 Wave 3 — migrated from orchestrate-engine.ts)
export type { ConduitOrchestrationEvent } from './orchestrate/spawn-ops.js';
export {
  composeSpawnForTask,
  orchestrateSpawn,
  orchestrateSpawnExecute,
  orchestrateSpawnSelectProvider,
  sendConduitEvent,
} from './orchestrate/spawn-ops.js';
// Context
export { estimateContext } from './orchestration/context.js';
// Orchestration
export { analyzeEpic, prepareSpawn } from './orchestration/index.js';
export {
  endParallelExecution,
  getParallelStatus,
  startParallelExecution,
} from './orchestration/parallel.js';
export { getSkillContent } from './orchestration/skill-ops.js';
export type {
  ComposeSpawnPayloadOptions,
  SpawnPayload,
  SpawnPayloadMeta,
} from './orchestration/spawn.js';
// Canonical spawn payload composer (T889 / T891 / T932 — single-path spawn).
export { composeSpawnPayload } from './orchestration/spawn.js';
export type { ConduitSubscriptionConfig } from './orchestration/spawn-prompt.js';
export {
  computeEpicStatus,
  computeOverallStatus,
  computeProgress,
  computeStartupSummary,
} from './orchestration/status.js';
export type { SpawnTierValue, TierSelectInput } from './orchestration/tier-selector.js';
export { resolveEffectiveTier, selectTier } from './orchestration/tier-selector.js';
export { getUnblockOpportunities } from './orchestration/unblock.js';
export { validateSpawnReadiness } from './orchestration/validate-spawn.js';
export type { EnrichedWave, EnrichedWaveTask, Wave } from './orchestration/waves.js';
export { getEnrichedWaves } from './orchestration/waves.js';
// OTel
export {
  clearOtelData,
  getOtelSessions,
  getOtelSpawns,
  getOtelSummary,
  getRealTokenUsage,
} from './otel/index.js';
// Paths (additional)
export {
  getAgentOutputsAbsolute,
  getAgentsHome,
  getCleoGlobalCantAgentsDir,
  getProjectRoot,
} from './paths.js';
// Phases — dependency graph (taskId-scoped critical path; distinct from tasks/graph-ops getCriticalPath)
export type { CriticalPathResult as DepsCriticalPathResult } from './phases/deps.js';
export { getCriticalPath as depsCriticalPath } from './phases/deps.js';
export type { ListPhasesResult } from './phases/index.js';
// Phases
export { advancePhase, deletePhase, renamePhase, setPhase, startPhase } from './phases/index.js';
// Pipeline
export { listPhases, showPhase } from './pipeline/index.js';
// Platform (additional)
export { getNodeUpgradeInstructions, getNodeVersionInfo } from './platform.js';
// Reconciliation (additional)
export {
  createLink,
  getLinkByExternalId,
  getLinksByProvider,
  getLinksByTaskId,
  removeLinksByProvider,
  touchLink,
} from './reconciliation/link-store.js';
// Release
export { channelToDistTag, describeChannel, resolveChannelFromBranch } from './release/channel.js';
export type { PRResult } from './release/github-pr.js';
export { buildPRBody, createPullRequest, isGhCliAvailable } from './release/github-pr.js';
export { checkDoubleListing, checkEpicCompleteness } from './release/guards.js';
export type { ProjectReleaseConfig, ReleaseConfig, ReleaseGate } from './release/release-config.js';
export {
  getGitFlowConfig,
  getPushMode,
  loadReleaseConfig,
  validateReleaseConfig,
} from './release/release-config.js';
export type { ReleaseListOptions, ReleaseTaskRecord } from './release/release-manifest.js';
export {
  cancelRelease,
  commitRelease,
  generateReleaseChangelog,
  listManifestReleases,
  markReleasePushed,
  prepareRelease,
  pushRelease,
  rollbackRelease,
  runReleaseGates,
  showManifestRelease,
} from './release/release-manifest.js';
export { bumpVersionFromConfig, getVersionBumpConfig } from './release/version-bump.js';
// Remote
// Remote git sync status (ahead/behind/branch)
export {
  getSyncStatus as getRemoteSyncStatus,
  listRemotes,
  pull,
  push,
  removeRemote,
} from './remote/index.js';
export type {
  CapabilityReport,
  ExecutionMode,
  GatewayType,
  OperationCapability,
  PreferredChannel,
} from './routing/capability-matrix.js';
// Routing
export {
  canRunNatively,
  generateCapabilityReport,
  getCapabilityMatrix,
  getNativeOperations,
  getOperationMode,
  requiresCLI,
} from './routing/capability-matrix.js';
export type { RateLimitConfig, RateLimitResult } from './security/index.js';
// Security
export {
  ALL_VALID_STATUSES,
  DEFAULT_RATE_LIMITS,
  ensureArray,
  RateLimiter,
  SecurityError,
  sanitizeContent,
  sanitizeParams,
  sanitizePath,
  sanitizeTaskId,
  VALID_DOMAINS,
  VALID_GATEWAYS,
  VALID_PRIORITIES,
  validateEnum,
} from './security/input-sanitization.js';
// Per-session override cap + waiver enforcement (T1501 / P0-5 / T1504)
export type { OverrideCapResult } from './security/override-cap.js';
export {
  checkAndIncrementOverrideCap,
  DEFAULT_OVERRIDE_CAP_PER_SESSION,
  getSessionOverrideCountPath,
  isWorktreeContext,
  isWorktreeExemptionEnabled,
  readSessionOverrideCount,
  validateWaiverDoc,
  WORKTREE_PATH_SEGMENT,
  writeSessionOverrideCount,
} from './security/override-cap.js';
// Owner-override auth (T1118 L4)
export type { OverrideValidationResult } from './security/owner-override-auth.js';
export {
  appendOwnerOverrideAudit,
  DEFAULT_OVERRIDE_MAX_PER_SESSION,
  deliverOverrideWebhook,
  deriveOwnerAuthToken,
  getOverrideCount,
  isAgentRoleForbidden,
  isTtyPresent,
  recordAndCheckOverrideLimit,
  resetOverrideCount,
  validateOwnerOverride,
  verifyOwnerAuthToken,
} from './security/owner-override-auth.js';
// Shared-evidence tracker (T1502 / P0-6)
export type {
  SharedEvidenceCheckResult,
  SharedEvidenceEnforceResult,
} from './security/shared-evidence-tracker.js';
export {
  appendAtomUsage,
  atomKey,
  checkAndRecordSharedEvidence,
  enforceSharedEvidence,
  extractAtomKeys,
  getSharedEvidencePath,
  readAtomUsageMap,
  SHARED_EVIDENCE_THRESHOLD,
} from './security/shared-evidence-tracker.js';
// Sequence
export { allocateNextTaskId, repairSequence } from './sequence/index.js';
export { recordAssumption } from './sessions/assumptions.js';
export type { SessionBriefing } from './sessions/briefing.js';
export { computeBriefing } from './sessions/briefing.js';
export { getCurrentSessionId } from './sessions/context-alert.js';
export type { ContextInjectionData } from './sessions/context-inject.js';
export { injectContext } from './sessions/context-inject.js';
export { getDecisionLog, recordDecision } from './sessions/decisions.js';
export type { FindSessionsParams, MinimalSessionRecord } from './sessions/find.js';
export type { DebriefData, HandoffData } from './sessions/handoff.js';
export {
  computeDebrief,
  computeHandoff,
  getLastHandoff,
  persistHandoff,
} from './sessions/handoff.js';
export type { HandoffMarkdownContext } from './sessions/handoff-markdown.js';
export { emitHandoffMarkdown, renderHandoffMarkdown } from './sessions/handoff-markdown.js';
// Sessions (additional)
export {
  archiveSessions,
  cleanupSessions,
  getContextDrift,
  getSessionHistory,
  parseScope,
  showSession,
  switchSession,
} from './sessions/index.js';
export { generateSessionId } from './sessions/session-id.js';
export type { DecisionRecord } from './sessions/types.js';
export { readRegistry } from './skills/agents/registry.js';
export { validateContributionTask } from './skills/manifests/contribution.js';
export { filterEntries } from './skills/manifests/research.js';
// Skills
export { analyzeDependencies, getNextTask, getReadyTasks } from './skills/orchestrator/startup.js';
export type { ManifestEntry } from './skills/types.js';
// Snapshot
export {
  exportSnapshot,
  getDefaultSnapshotPath,
  importSnapshot,
  writeSnapshot,
} from './snapshot/index.js';
// Stats — extended types and function (T1571)
export type { DashboardData, StatsData } from './stats/index.js';
// System
export { getDashboard, getProjectStats, getProjectStatsExtended } from './stats/index.js';
// Workflow telemetry (T065)
export {
  getWorkflowComplianceReport,
  type WorkflowComplianceReport,
  type WorkflowRuleMetric,
} from './stats/workflow-telemetry.js';
// Sticky
export { archiveSticky } from './sticky/archive.js';
export {
  convertStickyToMemory,
  convertStickyToSessionNote,
  convertStickyToTask,
  convertStickyToTaskNote,
} from './sticky/convert.js';
export { listStickies, purgeSticky } from './sticky/index.js';
export type {
  StickyConvertMemoryParams,
  StickyConvertResult,
  StickyConvertSessionNoteParams,
  StickyConvertTaskNoteParams,
  StickyConvertTaskParams,
} from './sticky/ops.js';
export type { CreateStickyParams, ListStickiesParams, StickyNote } from './sticky/types.js';
export type { DerefResult } from './store/attachment-store.js';
// Attachment store (T760 docs domain)
export { AttachmentIntegrityError, createAttachmentStore } from './store/attachment-store.js';
// Attachment store v2 — unified llmtxt/legacy wrapper (T947 Wave B)
export type {
  AttachmentBackend,
  AttachmentFileInput,
  AttachmentGetResult,
  AttachmentListEntry,
  AttachmentPutResult,
  AttachmentStoreV2,
  CreateAttachmentStoreV2Options,
} from './store/attachment-store-v2.js';
export {
  createAttachmentStoreV2,
  resolveAttachmentBackend,
} from './store/attachment-store-v2.js';
// Store
export { createBackup, listBackups, restoreFromBackup } from './store/backup.js';
// Backup portability — bundle packer (T311 / T347)
export type { PackBundleInput, PackBundleResult } from './store/backup-pack.js';
export { packBundle } from './store/backup-pack.js';
export type { LegacyCleanupResult, StrayNexusCleanupResult } from './store/cleanup-legacy.js';
export {
  detectAndRemoveLegacyGlobalFiles,
  detectAndRemoveStrayProjectNexus,
} from './store/cleanup-legacy.js';
export {
  gitCheckpoint,
  gitCheckpointStatus,
  isCleoGitInitialized,
} from './store/git-checkpoint.js';
export { computeChecksum, readJson } from './store/json.js';
export type { BrainDataAccessor } from './store/memory-accessor.js';
// Brain accessor — for intelligence domain handler construction
export { getBrainAccessor } from './store/memory-accessor.js';
export { getBrainDb, getBrainNativeDb } from './store/memory-sqlite.js';
export type { MigrationResult } from './store/migrate-signaldock-to-conduit.js';
export {
  migrateSignaldockToConduit,
  needsSignaldockToConduitMigration,
} from './store/migrate-signaldock-to-conduit.js';
export { createSession, getActiveSession } from './store/session-store.js';
export {
  _resetGlobalSignaldockDb_TESTING_ONLY,
  checkGlobalSignaldockDbHealth,
  checkSignaldockDbHealth,
  ensureGlobalSignaldockDb,
  ensureSignaldockDb,
  GLOBAL_SIGNALDOCK_DB_FILENAME,
  GLOBAL_SIGNALDOCK_SCHEMA_VERSION,
  getGlobalSignaldockDbPath,
  getGlobalSignaldockNativeDb,
  getSignaldockDbPath,
  resolveSignaldockMigrationsFolder,
  SIGNALDOCK_SCHEMA_VERSION,
} from './store/signaldock-sqlite.js';
export { getDb, getNativeDb } from './store/sqlite.js';
export type {
  BackupScope,
  GlobalBackupEntry,
  GlobalSaltBackupEntry,
} from './store/sqlite-backup.js';
export {
  backupGlobalSalt,
  listBrainBackups,
  listGlobalSaltBackups,
  listGlobalSqliteBackups,
  listSqliteBackups,
  listSqliteBackupsAll,
  vacuumIntoBackup,
  vacuumIntoBackupAll,
  vacuumIntoGlobalBackup,
} from './store/sqlite-backup.js';
export {
  auditLog,
  externalTaskLinks,
  releaseManifests,
  sessions,
  taskDependencies,
  tasks,
} from './store/tasks-schema.js';
export { createTask, getTask } from './store/tasks-sqlite.js';
export { AuditLogInsertSchema } from './store/validation-schemas.js';
export type {
  AnalyzeArchiveOptions,
  ArchiveAnalyticsResult,
  ArchiveReportType,
  CycleTimesReportData,
  EmptyArchiveData,
  LabelFrequencyEntry,
  PhaseGroupEntry,
  PriorityGroupEntry,
  SummaryReportData,
  TrendsReportData,
} from './system/archive-analytics.js';
export { analyzeArchive } from './system/archive-analytics.js';
export type { ArchiveStatsResult } from './system/archive-stats.js';
export { getArchiveStats } from './system/archive-stats.js';
export type { AuditResult, LogQueryData } from './system/audit.js';
export { auditData, queryAuditLog } from './system/audit.js';
export type {
  BackupEntry,
  BackupResult,
  FileRestoreResult,
  RestoreResult,
} from './system/backup.js';
export { fileRestore, listSystemBackups, restoreBackup } from './system/backup.js';
export type { CleanupResult } from './system/cleanup.js';
export { cleanupSystem } from './system/cleanup.js';
// System — dependency registry
export {
  checkAllDependencies,
  checkDependency,
  getDependencySpecs,
} from './system/dependencies.js';
export type { DiagnosticsResult, HealthResult } from './system/health.js';
export { getSystemDiagnostics, getSystemHealth, startupHealthCheck } from './system/health.js';
export type {
  InjectGenerateResult,
  LabelsResult,
  PathsData,
  RuntimeDiagnostics,
  SafestopResult,
  SyncData,
  SystemMetricsResult,
  UncancelResult,
} from './system/index.js';
export {
  checkStorageMigration,
  generateInjection,
  getLabels,
  getMigrationStatus,
  getRuntimeDiagnostics,
  getSystemMetrics,
  getSystemPaths,
  safestop,
  systemSync,
  uncancelTask,
} from './system/index.js';
// Cross-project registered-project health probe (T-PROJECT-HEALTH)
export type {
  CheckAllOptions,
  DbProbeResult,
  FullHealthReport,
  GlobalHealthReport,
  JsonFileProbe,
  ProjectHealthReport,
  ProjectHealthStatus,
} from './system/project-health.js';
export {
  checkAllRegisteredProjects,
  checkGlobalHealth,
  checkProjectHealth,
  probeDb,
} from './system/project-health.js';
// Task work (additional)
export type { TaskWorkHistoryEntry } from './task-work/index.js';
export { getTaskHistory } from './task-work/index.js';
// Tasks (additional)
export { validateLabels } from './tasks/add.js';
// Canonical task view — unified derivation (T943)
export {
  computeTaskView,
  computeTaskViews,
  type TaskView,
  type TaskViewChildRollup,
  type TaskViewGatesStatus,
  type TaskViewLifecycleProgress,
  type TaskViewNextAction,
  type TaskViewPipelineStage,
} from './tasks/compute-task-view.js';
// Evidence-based verification (T832 / ADR-051, T1534 / ADR-061)
export {
  type AtomValidation,
  CALLSITE_COVERAGE_LABEL,
  CANONICAL_TOOLS,
  checkCallsiteCoverageAtom,
  checkEngineMigrationLocDrop,
  checkGateEvidenceMinimum,
  composeGateEvidence,
  ENGINE_MIGRATION_MIN_REDUCTION_PCT,
  type EvidenceTool,
  GATE_EVIDENCE_MINIMUMS,
  isValidToolName,
  type ParsedAtom,
  type ParsedEvidence,
  parseEvidence,
  type RevalidationResult,
  revalidateEvidence,
  TOOL_COMMANDS,
  VALID_TOOLS,
  validateAtom,
} from './tasks/evidence.js';
// Gate audit trail (T832 / ADR-051)
export {
  appendForceBypassLine,
  appendGateAuditLine,
  type ForceBypassRecord,
  type GateAuditRecord,
  getForceBypassPath,
  getGateAuditPath,
} from './tasks/gate-audit.js';
export type { RunGatesOptions } from './tasks/gate-runner.js';
// Gate runner (T813)
export { extractTypedGates, runGates } from './tasks/gate-runner.js';
export { getCriticalPath } from './tasks/graph-ops.js';
export type { TaskTreeNode } from './tasks/hierarchy.js';
// Project-agnostic tool resolution + cache + semaphore (T1534 / ADR-061)
export {
  type AcquireSlotOptions,
  acquireGlobalSlot,
  type CanonicalTool,
  cacheEntryPath,
  captureDirtyFingerprint,
  captureHead,
  clearToolCache,
  computeCacheKey,
  defaultMaxConcurrent,
  listValidToolNames,
  type ReleaseSlotFn,
  type ResolutionSource,
  type ResolvedToolCommand,
  type ResolveToolResult,
  type RunToolOptions,
  readCacheEntry,
  resolveMaxConcurrent,
  resolveToolCommand,
  runToolCached,
  semaphoreDir,
  type ToolCacheEntry,
  type ToolRunResult,
  writeCacheEntry,
} from './tasks/index.js';
export type { CompactTask } from './tasks/list.js';
export { toCompact } from './tasks/list.js';
// Tasks domain — ADR-057 D1 normalized ops (projectRoot, params: <Op>Params) shape
export {
  tasksAddOp,
  tasksArchiveOp,
  tasksCompleteOp,
  tasksDeleteOp,
  tasksFindOp,
  tasksListOp,
  tasksShowOp,
  tasksUpdateOp,
} from './tasks/ops.js';
export {
  getPipelineStageOrder,
  isPipelineTransitionForward,
} from './tasks/pipeline-stage.js';
export { discoverRelated } from './tasks/relates.js';
export type { ComplexityFactor, FlatTreeNode } from './tasks/task-ops.js';
export {
  coreTaskAnalyze,
  coreTaskBatchValidate,
  coreTaskBlockers,
  coreTaskCancel,
  coreTaskComplexityEstimate,
  coreTaskDepends,
  coreTaskDeps,
  coreTaskDepsCycles,
  coreTaskDepsOverview,
  coreTaskExport,
  coreTaskHistory,
  coreTaskImport,
  coreTaskLint,
  coreTaskNext,
  coreTaskPromote,
  coreTaskRelates,
  coreTaskRelatesAdd,
  coreTaskReopen,
  coreTaskReorder,
  coreTaskReparent,
  coreTaskRestore,
  coreTaskTree,
  coreTaskUnarchive,
} from './tasks/task-ops.js';
// Self-improvement telemetry (T624)
export type {
  CommandStats as TelemetryCommandStats,
  DiagnosticsReport as TelemetryDiagnosticsReport,
  TelemetryConfig,
  TelemetryEvent,
} from './telemetry/index.js';
export {
  buildDiagnosticsReport,
  disableTelemetry,
  enableTelemetry,
  exportTelemetryEvents,
  getTelemetryConfigPath,
  getTelemetryDbPath,
  isTelemetryEnabled,
  loadTelemetryConfig,
  recordTelemetryEvent,
} from './telemetry/index.js';
export type { IssueTemplate, TemplateConfig, TemplateSection } from './templates/parser.js';
// Templates
export {
  generateTemplateConfig,
  getTemplateForSubcommand,
  parseIssueTemplates,
} from './templates/parser.js';
export type { DiagnoseFinding, DiagnoseResult, UpgradeSummary } from './upgrade.js';
// Upgrade
export { diagnoseUpgrade, runUpgrade } from './upgrade.js';
// Validation — chain validation
export { validateChain } from './validation/chain-validation.js';
// Validation — operation gates
export {
  GATE_VALIDATION_RULES,
  isFieldRequired,
  VALID_WORKFLOW_AGENTS,
  VALID_WORKFLOW_GATE_STATUSES,
  validateLayer1Schema,
  validateLayer2Semantic,
  validateLayer3Referential,
  validateLayer4Protocol,
  validateWorkflowGateName,
  validateWorkflowGateStatus,
  validateWorkflowGateUpdate,
} from './validation/operation-gate-validators.js';
export type {
  GateViolation,
  LayerResult,
  OperationContext,
  VerificationResult,
  WorkflowGateAgent,
  WorkflowGateDefinition,
  WorkflowGateState,
  WorkflowGateStatus,
} from './validation/operation-verification-gates.js';
// Validation — operation verification gates
// Validation — verification gates (additional)
export {
  createVerificationGate,
  GATE_SEQUENCE,
  GateLayer,
  getWorkflowGateDefinition,
  isValidWorkflowGateName,
  WORKFLOW_GATE_DEFINITIONS,
  WORKFLOW_GATE_SEQUENCE,
  WorkflowGateName,
  WorkflowGateTracker,
} from './validation/operation-verification-gates.js';
// Validation — ADR-057 D1 normalized ops (T1452)
export type {
  CheckRevalidateEvidenceParams,
  CheckRevalidateEvidenceResult,
} from './validation/ops.js';
export {
  checkArchiveStats,
  checkBatchValidate,
  checkCoherence,
  checkComplianceRecord,
  checkComplianceSummary,
  checkComplianceSync,
  checkGradeSession,
  checkReadGrades,
  checkRevalidateEvidence,
  checkTestCoverage,
  checkTestRun,
  checkTestStatus,
  checkValidateChain,
  checkValidateManifest,
  checkValidateOutput,
  checkValidateProtocol,
  checkValidateSchema,
  checkValidateTask,
  checkWorkflowCompliance,
} from './validation/ops.js';
export type {
  CommanderArgSplit,
  JSONSchemaObject,
  JsonSchemaProperty,
  JsonSchemaType,
} from './validation/param-utils.js';
// Validation — param utils
export {
  buildCommanderArgs,
  buildCommanderOptionString,
  buildDispatchInputSchema,
  camelToKebab,
  validateRequiredParamsDef,
} from './validation/param-utils.js';
// Validation — protocols (thin wrappers around orchestration/protocol-validators)
// Covers all 9 pipeline stages + 3 cross-cutting protocols (12 total).
export {
  checkArchitectureDecisionManifest,
  validateArchitectureDecisionTask,
} from './validation/protocols/architecture-decision.js';
export {
  checkArtifactPublishManifest,
  validateArtifactPublishTask,
} from './validation/protocols/artifact-publish.js';
export { checkConsensusManifest, validateConsensusTask } from './validation/protocols/consensus.js';
export {
  checkContributionManifest,
  validateContributionTask as validateContributionProtocol,
} from './validation/protocols/contribution.js';
export {
  checkDecompositionManifest,
  validateDecompositionTask,
} from './validation/protocols/decomposition.js';
export {
  checkImplementationManifest,
  validateImplementationTask,
} from './validation/protocols/implementation.js';
export {
  checkProvenanceManifest,
  validateProvenanceTask,
} from './validation/protocols/provenance.js';
export { checkReleaseManifest, validateReleaseTask } from './validation/protocols/release.js';
export { checkResearchManifest, validateResearchTask } from './validation/protocols/research.js';
export {
  checkSpecificationManifest,
  validateSpecificationTask,
} from './validation/protocols/specification.js';
export { checkTestingManifest, validateTestingTask } from './validation/protocols/testing.js';
export {
  checkValidationManifest,
  validateValidationTask,
} from './validation/protocols/validation.js';
export type { CoherenceIssue } from './validation/validate-ops.js';
// Validation — validate-ops
export {
  coreBatchValidate,
  coreCoherenceCheck,
  coreComplianceRecord,
  coreComplianceSummary,
  coreComplianceViolations,
  coreTestCoverage,
  coreTestRun,
  coreTestStatus,
  coreValidateManifest,
  coreValidateOutput,
  coreValidateProtocol,
  coreValidateSchema,
  coreValidateTask,
} from './validation/validate-ops.js';
// LOC-drop gate helpers + metrics-delta atom extensions + callsite-coverage gate (T1604 / T1023 / T1605)
export {
  CALLSITE_COVERAGE_GATE_LABEL,
  ENGINE_MIGRATION_LABEL,
  hasCallsiteCoverageLabel,
  hasEngineMigrationLabel,
  isMetricImproved,
  type MetricsDeltaValidation,
  type ParsedMetricsDeltaAtom,
  parseMetricsDeltaAtom,
  type ValidatedMetricsDeltaAtom,
  validateMetricsDeltaAtom,
} from './verification/evidence-atoms.js';

// ---------------------------------------------------------------------------
// Additional flat exports (TS2724 resolution for @cleocode/cleo)
// ---------------------------------------------------------------------------

// Lifecycle (additional)
export { listTesseraTemplates } from './lifecycle/tessera-engine.js';
// Orchestration (additional)
export { buildBrainState } from './orchestration/bootstrap.js';
// OTel (additional)
export { getOtelStatus } from './otel/index.js';
// Phases (additional)
export { completePhase } from './phases/index.js';
// Release engine operations (T1572 — ENG-MIG-5: migrated from dispatch layer)
export {
  releaseCancel,
  releaseChangelog,
  releaseChangelogSince,
  releaseCommit,
  releaseGateCheck,
  releaseGatesRun,
  releaseIvtrAutoSuggest,
  releaseList,
  releasePrepare,
  releasePush,
  releaseRollback,
  releaseRollbackFull,
  releaseShip,
  releaseShow,
  releaseTag,
} from './release/engine-ops.js';
// Release (additional)
export { tagRelease } from './release/release-manifest.js';
// Remote (additional)
export { addRemote } from './remote/index.js';
// Roadmap
export { getRoadmap } from './roadmap/index.js';
// Security (additional)
export {
  VALID_LIFECYCLE_STAGE_STATUSES,
  VALID_MANIFEST_STATUSES,
} from './security/input-sanitization.js';
// Sessions (additional)
export { findSessions } from './sessions/find.js';
export { getSessionStats, suspendSession } from './sessions/index.js';
// Snapshot (additional)
export { readSnapshot } from './snapshot/index.js';
// Sticky (additional)
export { addSticky } from './sticky/create.js';
export { getSticky } from './sticky/index.js';

// Store — backup crypto (T363)
export { decryptBundle, encryptBundle, isEncryptedBundle } from './store/backup-crypto.js';

// Store (additional)
export { resolveProjectRoot } from './store/file-utils.js';
export { TASK_PRIORITIES } from './store/tasks-schema.js';
// System (additional)
export type { MigrateResult } from './system/index.js';

// ---------------------------------------------------------------------------
// T311 Backup portability — unpack + verify + A/B restore (T350, T352, T354, T357)
// ---------------------------------------------------------------------------

// Unpack + verify (T350)
export type {
  SchemaCompatWarning as BundleSchemaCompatWarning,
  UnpackBundleInput,
  UnpackBundleResult,
} from './store/backup-unpack.js';
export { BundleError, cleanupStaging, unpackBundle } from './store/backup-unpack.js';
// Dry-run JSON file generators (T352)
export type { RegeneratedFile } from './store/regenerators.js';
export {
  regenerateAllJson,
  regenerateConfigJson,
  regenerateProjectContextJson,
  regenerateProjectInfoJson,
} from './store/regenerators.js';
// Conflict report formatter (T357)
export type {
  BuildConflictReportInput,
  ReauthWarning,
  SchemaCompatWarning as RestoreSchemaCompatWarning,
} from './store/restore-conflict-report.js';
export { buildConflictReport, writeConflictReport } from './store/restore-conflict-report.js';
// A/B regenerate-and-compare engine (T354)
export type {
  FieldCategory,
  FieldClassification,
  FilenameForRestore,
  JsonRestoreReport,
  RegenerateAndCompareInput,
  Resolution,
} from './store/restore-json-merge.js';
export { regenerateAndCompare, regenerateAndCompareAll } from './store/restore-json-merge.js';
export { taskArchive } from './tasks/archive.js';
export { completeTaskStrict, taskComplete } from './tasks/complete.js';
export { taskDelete } from './tasks/delete.js';
// Engine-layer converters and types (T1568 / ADR-057 / ADR-058)
export {
  type IvtrHistoryEntry,
  type LifecycleStageEntry,
  tasksToRecords,
  taskToRecord,
  toHistoryEntry,
} from './tasks/engine-converters.js';
export { taskFind } from './tasks/find.js';
export { taskLabelList, taskLabelShow } from './tasks/labels.js';
export { taskList } from './tasks/list.js';
export { taskPlan } from './tasks/plan.js';
// Complex mutations + strict completion (T1568 / ADR-057 / ADR-058) — Wave 4
export { addTaskWithSessionScope, resolveParentFromSession } from './tasks/session-scope.js';
// Engine-layer EngineResult-returning wrappers (T1568 / ADR-057 / ADR-058) — Wave 2
export {
  taskExists,
  taskShow,
  taskShowIvtrHistory,
  taskShowWithHistory,
} from './tasks/show.js';
// Sync sub-domain (T1568 / ADR-057 / ADR-058) — Wave 3
export { taskSyncLinks, taskSyncLinksRemove, taskSyncReconcile } from './tasks/sync-ops.js';
// Tasks (additional — stats)
export {
  coreTaskStats,
  taskAnalyze,
  taskBatchValidate,
  taskBlockers,
  taskCancel,
  taskClaim,
  taskComplexityEstimate,
  taskDepends,
  taskDeps,
  taskDepsCycles,
  taskDepsOverview,
  taskExport,
  taskHistory,
  taskImpact,
  taskImport,
  taskLint,
  taskNext,
  taskPromote,
  taskRelates,
  taskRelatesAdd,
  taskRelatesFind,
  taskReopen,
  taskReorder,
  taskReparent,
  taskRestore,
  taskStats,
  taskTree,
  taskUnarchive,
  taskUnclaim,
} from './tasks/task-ops.js';
export { taskUpdate } from './tasks/update.js';

// ---------------------------------------------------------------------------
// Additional flat exports (required by @cleocode/cleo)
// ---------------------------------------------------------------------------

export type {
  AgentExecutionEvent,
  AgentExecutionOutcome,
  AgentHealthReport,
  AgentHealthStatus,
  AgentPerformanceSummary,
  AgentRecoveryResult,
  CapacitySummary,
  HealingSuggestion,
  ListAgentFilters,
  RegisterAgentOptions,
  RetryPolicy,
  RetryResult,
  UpdateStatusOptions,
} from './agents/index.js';
// Agents — runtime registry, health, retry, capacity
export {
  // health-monitor functions (T039)
  checkAgentHealth,
  // registry / capacity / retry
  classifyError,
  createRetryPolicy,
  DEFAULT_RETRY_POLICY,
  deregisterAgent,
  detectCrashedAgents,
  detectStaleAgents,
  findLeastLoadedAgent,
  findStaleAgentRows,
  generateAgentId,
  getAgentErrorHistory,
  getAgentInstance,
  getAgentPerformanceHistory,
  getAvailableCapacity,
  getCapacitySummary,
  getHealthReport,
  getSelfHealingSuggestions,
  HEARTBEAT_INTERVAL_MS,
  heartbeat,
  incrementTasksCompleted,
  isOverloaded,
  listAgentInstances,
  markCrashed,
  processAgentLifecycleEvent,
  recordAgentExecution,
  recordFailurePattern,
  recordHeartbeat,
  recoverCrashedAgents,
  registerAgent as registerAgentInstance,
  STALE_THRESHOLD_MS,
  storeHealingStrategy,
  updateAgentStatus,
  updateCapacity,
  withRetry,
} from './agents/index.js';
export type {
  LoadProjectContextResult,
  SubstituteCantAgentBodyResult,
} from './agents/variable-substitution.js';
// T1238 — mustache variable substitution for CANT agent bodies at spawn time
export {
  DefaultVariableResolver,
  defaultResolver as defaultVariableResolver,
  loadProjectContext,
  substituteCantAgentBody,
} from './agents/variable-substitution.js';
// Codebase map (additional)
export { mapCodebase } from './codebase-map/index.js';
// Compliance — system stats (T1571)
export type { ComplianceData } from './compliance/index.js';
// Compliance (additional)
export { getComplianceStats, syncComplianceMetrics } from './compliance/index.js';
// Compliance — protocol types
export { ProtocolType } from './compliance/protocol-enforcement.js';
export type { BuildConfig } from './config/build-config.js';
// Build config
export { BUILD_CONFIG } from './config/build-config.js';
// Init (additional)
export { initCoreSkills, installHandoffRedirectStubs } from './init.js';
// Memory — anthropic key resolver (additional)
export {
  clearAnthropicKeyCache,
  resolveAnthropicApiKey,
  resolveAnthropicApiKeySource,
  storeAnthropicApiKey,
} from './memory/anthropic-key-resolver.js';
// Memory — auto-extract (additional)
export { extractFromTranscript } from './memory/auto-extract.js';
// Memory — brain embedding (additional)
export { initDefaultProvider } from './memory/brain-embedding.js';
// Memory — brain row types
export type {
  BrainAnchor,
  BrainConsolidationObservationRow,
  BrainDecisionNode,
  BrainFtsRow,
  BrainIdCheckRow,
  BrainKnnRow,
  BrainNarrativeRow,
  BrainSearchHit,
  BrainTimelineNeighborRow,
} from './memory/brain-row-types.js';
// Memory — auto-populate graph hooks (T537 + T945 Stage A)
export {
  addGraphEdge,
  ensureCommitNode,
  ensureLlmtxtNode,
  ensureMessageNode,
  ensureTaskNode,
  upsertGraphNode,
} from './memory/graph-auto-populate.js';
export {
  autoLinkMemories,
  linkMemoryToCode,
  listCodeLinks,
  queryCodeForMemory,
  queryMemoriesForCode,
} from './memory/graph-memory-bridge.js';
// Memory — LLM extraction gate (additional)
export type {
  ExtractedMemory,
  ExtractFromTranscriptOptions,
  ExtractionReport,
  ExtractionType,
} from './memory/llm-extraction.js';
export { extractFromTranscript as llmExtractFromTranscript } from './memory/llm-extraction.js';
// Memory (additional)
export {
  generateContextAwareContent,
  generateMemoryBridgeContent,
  refreshMemoryBridge,
  writeMemoryBridge,
} from './memory/memory-bridge.js';
export type { SessionMemoryContext } from './memory/session-memory.js';
export {
  buildSummarizationPrompt,
  getSessionMemoryContext,
  ingestStructuredSummary,
  persistSessionMemory,
} from './memory/session-memory.js';
// Nexus Wave 3 — code intelligence EngineResult wrappers
export {
  nexusConduitScan,
  nexusContractsLinkTasks,
  nexusContractsShow,
  nexusContractsSync,
  nexusTaskSymbols,
} from './nexus/api-contracts.js';
export { nexusClusters } from './nexus/clusters.js';
export { nexusContext } from './nexus/context.js';
export { nexusDiff } from './nexus/diff.js';
// Nexus — discoverRelated (exported as nexusDiscoverRelated to avoid name clash with tasks discoverRelated)
// Nexus — searchAcrossProjects
export {
  discoverRelated as nexusDiscoverRelated,
  searchAcrossProjects as nexusSearchAcrossProjects,
} from './nexus/discover.js';
export { nexusFlows } from './nexus/flows.js';
// Nexus — bridge (code intelligence summary for agents)
export {
  generateNexusBridgeContent,
  // EngineResult wrapper (T1569 Wave 3)
  nexusRefreshBridge,
  refreshNexusBridge,
  writeNexusBridge,
} from './nexus/nexus-bridge.js';
export { nexusProjectsClean } from './nexus/projects-clean.js';
export { nexusProjectsScan } from './nexus/projects-scan.js';
export { nexusQueryCte } from './nexus/query-dsl.js';
// Nexus — readRegistry (exported as nexusReadRegistry to avoid name clash with skills readRegistry)
export { readRegistry as nexusReadRegistry } from './nexus/registry.js';
export { nexusRouteMap, nexusShapeCheck } from './nexus/route-analysis.js';
// Nexus — sigil (peer-card) SDK (T1148 Wave 8)
export type { SigilCard, SigilInput } from './nexus/sigil.js';
export {
  getSigil,
  listSigils,
  // EngineResult wrapper (T1569 Wave 4)
  nexusSigilList,
  upsertSigil,
} from './nexus/sigil.js';
// Nexus — sigil sync (T1386): populate sigils from canonical CANT agents
export type { CanonicalCantFiles, SigilSyncResult } from './nexus/sigil-sync.js';
export {
  // EngineResult wrapper (T1569 Wave 4)
  nexusSigilSync,
  parseSigilFromCant,
  resolveCanonicalCantFiles,
  syncCanonicalSigils,
} from './nexus/sigil-sync.js';
export type {
  ExportUserProfileResult,
  ImportUserProfileResult,
} from './nexus/transfer.js';
// Nexus — transfer + user-profile import/export (T1079)
export {
  executeTransfer,
  exportUserProfile,
  getDefaultUserProfilePath,
  importUserProfile,
  previewTransfer,
} from './nexus/transfer.js';
export type {
  TransferParams,
  TransferResult,
} from './nexus/transfer-types.js';
// Nexus — user-profile CRUD SDK (T1078)
export {
  getUserProfileTrait,
  listUserProfile,
  // EngineResult wrappers (T1569 Wave 4)
  nexusProfileExport,
  nexusProfileGet,
  nexusProfileImport,
  nexusProfileReinforce,
  nexusProfileSupersede,
  nexusProfileUpsert,
  nexusProfileView,
  reinforceTrait,
  supersedeTrait,
  upsertUserProfileTrait,
} from './nexus/user-profile.js';
export { nexusWiki } from './nexus/wiki-index.js';
export type { DependencyAnalysis } from './orchestration/analyze.js';
export { analyzeDependencies as orchestrationAnalyzeDependencies } from './orchestration/analyze.js';
export { getCriticalPath as orchestrationGetCriticalPath } from './orchestration/critical-path.js';
export type { TaskReadiness } from './orchestration/index.js';
// Orchestration — core versions (different signatures from skills versions)
export {
  getNextTask as orchestrationGetNextTask,
  getReadyTasks as orchestrationGetReadyTasks,
} from './orchestration/index.js';
// Paths (additional)
export { getBackupDir, getCleoHome, getConfigPath, getTaskPath } from './paths.js';
// Scaffold — hub data type (T1571)
export type { ScaffoldHubData } from './scaffold.js';
// Scaffold (additional)
export {
  ensureCleoOsHub,
  ensureContributorMcp,
  ensureGlobalTemplates,
  ensureProjectContext,
} from './scaffold.js';
// Worktree dispatch — SDK-first wrapper for orchestrate.spawn (T1140 / ADR-055)
export {
  listProjectWorktrees,
  pruneWorktreesForProject,
  spawnWorktree,
  teardownWorktree,
  warmupWorktreeBackend,
} from './sentient/worktree-dispatch.js';
// Sequence (additional)
export { checkSequence, showSequence } from './sequence/index.js';
// Sessions — grading
export { gradeSession, readGrades } from './sessions/session-grade.js';
// Skills — precedence
export {
  determineInstallationTargets,
  getSkillsMapWithPrecedence,
  resolveSkillPathsForProvider,
} from './skills/precedence-integration.js';
// Spawn
export { initializeDefaultAdapters, spawnRegistry } from './spawn/adapter-registry.js';
// Branch-lock engine (T1118, T1462, T1587, T1601)
export type { PruneWorktreeResult } from './spawn/branch-lock.js';
export {
  applyFsHarden,
  buildAgentEnv,
  buildWorktreeSpawnResult,
  completeAgentWorktree,
  completeAgentWorktreeViaMerge,
  createAgentWorktree,
  detectFsHardenCapabilities,
  ensureGitShimDir,
  getDefaultBranch,
  getGitRoot,
  pruneOrphanedWorktrees,
  pruneWorktree,
  removeFsHarden,
  resolveAgentWorktreeRoot,
} from './spawn/branch-lock.js';
// Nexus DB path (global tier) + native handle for Tier-2 ingesters (T1008)
export { getNexusDb, getNexusDbPath, getNexusNativeDb } from './store/nexus-sqlite.js';
// System — backup (different from store/backup.ts)
export { createBackup as systemCreateBackup } from './system/backup.js';
export type { DoctorReport, FixResult } from './system/health.js';
// System — doctor
export { coreDoctorReport, runDoctorFixes } from './system/health.js';
export { listLabels, showLabelTasks } from './tasks/labels.js';
// Tasks — plan, labels, suggests
export { coreTaskPlan } from './tasks/plan.js';
export { suggestRelated } from './tasks/relates.js';
// Verification gates — enums/classes
export { GateStatus, VerificationGate } from './validation/operation-verification-gates.js';

// ---------------------------------------------------------------------------
// Test helpers (used by cleo test files)
// ---------------------------------------------------------------------------

// Store — project detection (used by cleo init tests)
export { detectProjectType } from './store/project-detect.js';
export { closeAllDatabases, closeDb, resetDbState } from './store/sqlite.js';
export { createSqliteDataAccessor } from './store/sqlite-data-accessor.js';
// T1434 — Typed sqlite query helpers exported for dispatch consumers that
// need to centralize the `as unknown as T[]` cast across node:sqlite calls.
export { typedAll, typedGet } from './store/typed-query.js';
// Validation — doctor checks (used by cleo init tests)
export { checkRootGitignore } from './validation/doctor/checks.js';

// ---------------------------------------------------------------------------
// T310 startup sequence exports (required by cli/index.ts T360 wire-up)
// ---------------------------------------------------------------------------

// Conduit DB lifecycle — ensureConduitDb is called at every CLI startup (step 3)
// ProjectAgentRef lives in @cleocode/contracts; conduit-sqlite.ts only imports it.
// We re-export from the canonical source here to keep the internal barrel stable.
export type { ProjectAgentRef } from '@cleocode/contracts';
export {
  CONDUIT_DB_FILENAME,
  CONDUIT_SCHEMA_VERSION,
  checkConduitDbHealth,
  closeConduitDb,
  ensureConduitDb,
  getConduitDbPath,
  getConduitNativeDb,
} from './store/conduit-sqlite.js';

// Global-salt lifecycle — validateGlobalSalt and getGlobalSalt used at startup (step 5)
export {
  GLOBAL_SALT_FILENAME,
  GLOBAL_SALT_SIZE,
  getGlobalSalt,
  getGlobalSaltPath,
  validateGlobalSalt,
} from './store/global-salt.js';

// ---------------------------------------------------------------------------
// Agent Registry + Conduit (T170 Unification)
// ---------------------------------------------------------------------------

export { ConduitClient } from './conduit/conduit-client.js';
export { createConduit } from './conduit/factory.js';
export { HttpTransport } from './conduit/http-transport.js';
export { decrypt, encrypt } from './crypto/credentials.js';
export type {
  BuildDoctorReportOptions,
  ReconcileDoctorOptions,
  ReconcileDoctorResult,
} from './store/agent-doctor.js';
export { buildDoctorReport, reconcileDoctor } from './store/agent-doctor.js';
export type {
  InstallAgentFromCantInput,
  InstallAgentFromCantResult,
} from './store/agent-install.js';
export { installAgentFromCant } from './store/agent-install.js';
export {
  AgentRegistryAccessor,
  attachAgentToProject,
  createProjectAgent,
  detachAgentFromProject,
  getProjectAgentRef,
  listAgentsForProject,
  lookupAgent,
} from './store/agent-registry-accessor.js';
export type { ResolveAgentOptions } from './store/agent-resolver.js';
export {
  AGENT_TIER_UNIVERSAL,
  AGENT_UNIVERSAL_BASE_ID,
  AgentNotFoundError,
  DEPRECATED_ALIASES,
  getAgentSkills,
  resolveAgent,
  resolveAgentsBatch,
} from './store/agent-resolver.js';
