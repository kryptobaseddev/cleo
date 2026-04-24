/**
 * @cleocode/contracts — Domain types, interfaces, and contracts for the CLEO ecosystem.
 *
 * This is the LEAF package in the dependency graph — ZERO runtime dependencies.
 * All domain types (Task, Session, DataAccessor, etc.) are defined here.
 * Implementation packages (@cleocode/core, @cleocode/cleo) import from here.
 */

// === Acceptance Gate Types (machine-verifiable criteria) ===
export type {
  AcceptanceGate,
  AcceptanceGateKind,
  AcceptanceGateResult,
  CommandGate,
  FileAssertion,
  FileGate,
  GateBase,
  GateResultDetails,
  HttpGate,
  LintGate,
  ManualGate,
  TestGate,
} from './acceptance-gate.js';
export type {
  AcceptanceArrayInput,
  AcceptanceGateResultInput,
  AcceptanceGateSchemaInput,
  AcceptanceItemInput,
  FileAssertionInput,
  GateResultDetailsInput,
} from './acceptance-gate-schema.js';
// === Acceptance Gate Zod Schemas (runtime validation) ===
export {
  acceptanceArraySchema,
  acceptanceGateResultSchema,
  acceptanceGateSchema,
  acceptanceItemSchema,
  commandGateSchema,
  fileAssertionSchema,
  fileGateSchema,
  gateBaseSchema,
  gateResultDetailsSchema,
  httpGateSchema,
  lintGateSchema,
  manualGateSchema,
  testGateSchema,
} from './acceptance-gate-schema.js';
// === Provider Adapter Contracts ===
export type { AdapterHealthStatus, CLEOProviderAdapter } from './adapter.js';
// === Agent Registry (credential management) ===
export type {
  AgentCredential,
  AgentListFilter,
  AgentRegistryAPI,
  AgentWithProjectOverride,
  ProjectAgentRef,
  TransportConfig,
} from './agent-registry.js';
// === Agent Registry v3 (T889 / T897 — tier-aware resolution extensions) ===
export type {
  AgentDoctorCode,
  AgentDoctorFinding,
  AgentRegistryExtendedFields,
  AgentSkillSource,
  AgentSpawnCapability,
  AgentTier,
  DoctorReport,
  ResolvedAgent,
} from './agent-registry-v3.js';
// === Archive Types ===
export type {
  ArchiveCycleTimesReport,
  ArchiveDailyTrend,
  ArchivedTask,
  ArchiveLabelEntry,
  ArchiveMetadata,
  ArchiveMonthlyTrend,
  ArchivePhaseEntry,
  ArchivePriorityEntry,
  ArchiveReportType,
  ArchiveStatsEnvelope,
  ArchiveSummaryReport,
  ArchiveTrendsReport,
  CycleTimeDistribution,
  CycleTimePercentiles,
} from './archive.js';
// === Attachment Types ===
export type {
  Attachment,
  AttachmentKind,
  AttachmentMetadata,
  AttachmentRef,
  BlobAttachment,
  LlmsTxtAttachment,
  LlmtxtDocAttachment,
  LocalFileAttachment,
  UrlAttachment,
} from './attachment.js';
// === Attachment Zod Schemas (runtime validation) ===
export type {
  AttachmentMetadataSchemaInput,
  AttachmentRefSchemaInput,
  AttachmentSchemaInput,
} from './attachment-schema.js';
export {
  attachmentMetadataSchema,
  attachmentRefSchema,
  attachmentSchema,
  blobAttachmentSchema,
  llmsTxtAttachmentSchema,
  llmtxtDocAttachmentSchema,
  localFileAttachmentSchema,
  urlAttachmentSchema,
} from './attachment-schema.js';
// === Backup Manifest Types ===
export type {
  BackupDatabaseEntry,
  BackupGlobalFileEntry,
  BackupIntegrity,
  BackupJsonEntry,
  BackupManifest,
  BackupMetadata,
  BackupScope,
} from './backup-manifest.js';
// === Brain/Memory Types ===
export type {
  BrainCognitiveType,
  BrainEntryRef,
  BrainEntrySummary,
  BrainMemoryTier,
  BrainSourceConfidence,
  ContradictionDetail,
  SupersededEntry,
} from './brain.js';
// === Brain Unified-Graph Types (canonical — T989 unification) ===
export type {
  BrainConnectionStatus,
  BrainEdge,
  BrainGraph,
  BrainNode,
  BrainNodeKind,
  BrainProjectContext,
  BrainQueryOptions,
  BrainStreamEvent,
  BrainSubstrate,
} from './brain-graph.js';
export type {
  AgentWorktreeState,
  BranchLockErrorCode,
  DeniedGitOp,
  FsHardenCapabilities,
  FsHardenState,
  GitShimEnv,
  OwnerOverrideAuditRecord,
  OwnerOverrideConfig,
  WorktreeCleanupResult,
  WorktreeCompleteResult,
  WorktreeSpawnResult,
} from './branch-lock.js';
// === Branch-Lock + Owner-Auth Types (T1118) ===
export { BRANCH_LOCK_ERROR_CODES } from './branch-lock.js';
export type { AdapterCapabilities } from './capabilities.js';
// === Code Symbol Types (tree-sitter AST) ===
export type {
  BatchParseResult,
  CodeSymbol,
  CodeSymbolKind,
  ParseResult,
} from './code-symbol.js';
// === Conduit Protocol (agent-to-agent communication) ===
export type {
  Conduit,
  ConduitConfig,
  ConduitMessage,
  ConduitSendOptions,
  ConduitSendResult,
  ConduitState,
  ConduitStateChange,
  ConduitTopicPublishOptions,
  ConduitTopicSubscribeOptions,
  ConduitUnsubscribe,
} from './conduit.js';
// === Configuration Types ===
export type {
  BackupConfig,
  BrainConfig,
  BrainEmbeddingConfig,
  BrainLlmExtractionConfig,
  BrainMemoryBridgeConfig,
  BrainSummarizationConfig,
  BrainTieringConfig,
  ClaudeProviderConfig,
  ClaudeSpawnMode,
  CleoConfig,
  ConfigSource,
  DateFormat,
  EnforcementProfile,
  HierarchyConfig,
  LifecycleConfig,
  LifecycleEnforcementMode,
  LoggingConfig,
  LogLevel,
  MemoryBridgeMode,
  OutputConfig,
  OutputFormat,
  ProviderConfig,
  ResolvedValue,
  SessionConfig,
  SessionSummaryInput,
  SharingConfig,
  SharingMode,
  SignalDockConfig,
  SignalDockMode,
} from './config.js';
export type { AdapterContextMonitorProvider } from './context-monitor.js';
// === DataAccessor Interface ===
export type {
  ArchiveFields,
  ArchiveFile,
  DataAccessor,
  DataAccessorAgentInstance,
  QueryTasksResult,
  TaskFieldUpdates,
  TaskQueryFilters,
  TransactionAccessor,
} from './data-accessor.js';
// === Dependency Registry Contracts ===
export type {
  DependencyCategory,
  DependencyCheckResult,
  DependencyReport,
  DependencySpec,
} from './dependency.js';
export type { AdapterManifest, DetectionPattern } from './discovery.js';
// === Error Utilities ===
export {
  createErrorResult,
  createSuccessResult,
  formatError,
  getErrorMessage,
  isErrorResult,
  isErrorType,
  LifecycleScopeDeniedError,
  normalizeError,
  ThinAgentViolationError,
} from './errors.js';
// === Evidence Record Types (IVTR typed proof artifacts) ===
export type {
  CommandOutputRecord,
  EvidenceRecord,
  EvidenceRecordKind,
  ImplDiffRecord,
  LintReportRecord,
  TestOutputRecord,
  ValidateSpecCheckRecord,
} from './evidence-record.js';
export type {
  CommandOutputRecordInput,
  EvidenceRecordInput,
  ImplDiffRecordInput,
  LintReportRecordInput,
  TestOutputRecordInput,
  ValidateSpecCheckRecordInput,
} from './evidence-record-schema.js';
// === Evidence Record Zod Schemas (runtime validation) ===
export {
  commandOutputRecordSchema,
  evidenceRecordSchema,
  implDiffRecordSchema,
  lintReportRecordSchema,
  testOutputRecordSchema,
  validateSpecCheckRecordSchema,
} from './evidence-record-schema.js';
// === Exit Codes ===
export {
  ExitCode,
  getExitCodeName,
  isErrorCode,
  isNoChangeCode,
  isRecoverableCode,
  isSuccessCode,
} from './exit-codes.js';
export type {
  AdminAPI,
  AgentCapacity,
  AgentHealthStatus,
  AgentInstanceRow,
  AgentInstanceStatus,
  AgentsAPI,
  AgentType,
  BlastRadius,
  BlastRadiusSeverity,
  BrainObservationType,
  CleoInitOptions,
  DuplicateStrategy,
  HybridSearchOptions,
  ImpactedTask,
  ImpactReport,
  ImportParams,
  IntelligenceAPI,
  LifecycleAPI,
  MemoryAPI,
  NexusAPI,
  OrchestrationAPI,
  RegisterAgentOptions,
  ReleaseAPI,
  SessionsAPI,
  StickyAPI,
  SyncAPI,
  TaskRollupPayload,
  TaskStartResult,
  TasksAPI,
} from './facade.js';
// === Facade API Interfaces ===
export {
  AGENT_INSTANCE_STATUSES,
  AGENT_TYPES,
  BRAIN_OBSERVATION_TYPES,
} from './facade.js';
// === Graph Intelligence Types (T512, T529) ===
export type {
  CommunityNode,
  GraphNode,
  GraphNodeKind,
  GraphRelation,
  GraphRelationType,
  ImpactResult,
  KnowledgeGraph,
  ProcessNode,
  SymbolIndex,
} from './graph.js';
export type { AdapterHookProvider } from './hooks.js';
export type { AdapterInstallProvider, InstallOptions, InstallResult } from './install.js';
export type {
  CleoResponse,
  ConformanceReport,
  FlagInput,
  GatewayEnvelope,
  GatewayError,
  GatewayMeta,
  GatewaySuccess,
  LAFSEnvelope,
  LAFSError,
  LAFSErrorCategory,
  LAFSMeta,
  LAFSPage,
  LAFSPageNone,
  LAFSPageOffset,
  LAFSTransport,
  LafsAlternative,
  LafsEnvelope,
  LafsError,
  LafsErrorDetail,
  LafsSuccess,
  MVILevel,
  Warning,
} from './lafs.js';
// === LAFS Envelope Types ===
export {
  isGatewayEnvelope,
  isLafsError,
  isLafsSuccess,
} from './lafs.js';
export type {
  BridgeDecision,
  BridgeLearning,
  BridgeObservation,
  BridgePattern,
  DispatchTrace,
  MemoryBridgeConfig,
  MemoryBridgeContent,
  SessionSummary,
} from './memory.js';
export type {
  Contract,
  ContractCompatibilityMatrix,
  ContractExtractionResult,
  ContractMatch,
  ContractMatchLevel,
  ContractTaskLink,
  GrpcContract,
  HttpContract,
  TopicContract,
} from './nexus-contract-ops.js';
// === Living Brain SDK Types (T1068 — 5-substrate traversal primitives) ===
// === Extended Code Reasoning Types (T1069 — reasonWhySymbol + reasonImpactOfChange) ===
export type {
  BlastRadiusSummary,
  BrainMemoryRef,
  BrainRiskNote,
  CodeAnchorResult,
  CodeReasonTrace,
  ConduitThreadRef,
  DecisionRef,
  ImpactFullReport,
  LbTaskRef,
  NexusContext,
  NexusEdgeRef,
  NexusNodeAnchor,
  PlasticityMeasure,
  ProposalRef,
  ReasonTraceStep,
  RiskTier,
  SymbolFullContext,
  SymbolImpactEntry,
  TaskCodeImpact,
  TasksForNodeEntry,
} from './nexus-living-brain-ops.js';
// === Nexus Query DSL (recursive CTE operations) ===
export type {
  NexusCteAlias,
  NexusCteMarkdownTable,
  NexusCteParams,
  NexusCtePlaceholder,
  NexusCteResult,
} from './nexus-query-ops.js';
// === Route Analysis and Contract Registry Types (T1064, T1065) ===
export type {
  RouteMapEntry,
  RouteMapResult,
  ShapeCheckCaller,
  ShapeCheckResult,
  ShapeCheckStatus,
} from './nexus-route-ops.js';
export type {
  GitLogLinkerResult,
  LinkTaskResult,
  SymbolReference,
  TaskReference,
} from './nexus-tasks-bridge-ops.js';
export type {
  CommunityWikiStats,
  GenerateNexusWikiOptions,
  NexusWikiResult,
  WikiDbHandle,
  WikiStateFile,
  WikiSymbolRow,
} from './nexus-wiki-ops.js';
// Dialectic Evaluator operation types (T1087 Wave 3)
export type {
  ApplyInsightsParams,
  ApplyInsightsResult,
  DialecticInsights,
  DialecticTurn,
  EvaluateDialecticParams,
  EvaluateDialecticResult,
} from './operations/dialectic.js';
// === Operations Types (API wire format, namespaced to avoid collision with domain types) ===
export * as ops from './operations/index.js';
// Multi-pass retrieval bundle types (PSYCHE Wave 4 · T1090)
export type {
  PassMask,
  RetrievalActiveTask,
  RetrievalBundle,
  RetrievalDecision,
  RetrievalLearning,
  RetrievalObservation,
  RetrievalPattern,
  RetrievalRequest,
  RetrievalTokenCounts,
  SigilCard,
} from './operations/memory.js';
// === NEXUS User Profile Types (T1076 PSYCHE Wave 1) ===
// Re-exported at top level so @cleocode/core/nexus and CLI dispatch can
// import without the `ops.` namespace hop.
export type {
  NexusProfileExportParams,
  NexusProfileExportResult,
  NexusProfileGetParams,
  NexusProfileGetResult,
  NexusProfileImportParams,
  NexusProfileImportResult,
  NexusProfileReinforceParams,
  NexusProfileReinforceResult,
  NexusProfileSupersedeParams,
  NexusProfileSupersedeResult,
  NexusProfileUpsertParams,
  NexusProfileUpsertResult,
  NexusProfileViewParams,
  NexusProfileViewResult,
  UserProfileTrait,
} from './operations/nexus-user-profile.js';
// Commonly used ops types re-exported at top level for convenience
export type { BrainState } from './operations/orchestrate.js';
// ParamDef contract — re-exported at top level (SSoT for all operation param descriptors)
export type {
  CittyArgDef,
  OperationParams,
  ParamCliDef,
  ParamDef,
  ParamType,
} from './operations/params.js';
export { paramsToCittyArgs } from './operations/params.js';
// Session operation param/result types — re-exported at top level for typed-dispatch consumers
// (T975 Wave D · ADR-051 migration)
export type {
  DecisionRecord,
  SessionBriefingShowParams,
  SessionBriefingShowResult,
  SessionContextDriftParams,
  SessionContextDriftResult,
  SessionDecisionLogParams,
  SessionDecisionLogResult,
  SessionEndParams,
  SessionEndResult,
  SessionFindParams,
  SessionFindResult,
  SessionGcParams,
  SessionGcResult,
  SessionHandoffShowParams,
  SessionHandoffShowResult,
  SessionListParams,
  SessionListResult,
  SessionOps,
  SessionRecordAssumptionParams,
  SessionRecordAssumptionResult,
  SessionRecordDecisionParams,
  SessionRecordDecisionResult,
  SessionResumeParams,
  SessionResumeResult,
  SessionShowParams,
  SessionShowResult,
  SessionStartParams,
  SessionStatusParams,
  SessionStatusResult,
  SessionSuspendParams,
  SessionSuspendResult,
} from './operations/session.js';
// T1238 Variable substitution — re-exported at top level so SDK consumers can
// import resolver contracts without the `ops.` namespace hop.
export type {
  ResolvedVariable,
  SubstitutionContext,
  SubstitutionOptions,
  SubstitutionResult,
  SubstitutionSource,
  VariableResolver,
} from './operations/variable-substitution.js';
// === Worktree Backend SDK Types (T1161) ===
// Re-exported at top level so @cleocode/worktree and callers can
// import without the `ops.` namespace hop.
export type {
  CreateWorktreeOptions,
  CreateWorktreeResult,
  DestroyWorktreeOptions,
  DestroyWorktreeResult,
  ListWorktreesOptions,
  PruneWorktreesOptions,
  PruneWorktreesResult,
  WorktreeHook,
  WorktreeHookResult,
  WorktreeIncludePattern,
  WorktreeListEntry,
} from './operations/worktree.js';

// === Peer Identity (T1210 — SDK-first CANT persona contract) ===
export {
  assertPeerIdentity,
  filterPeerIdentities,
  isPeerIdentity,
  type PeerIdentity,
  type PeerKind,
} from './peer.js';
// === Playbook DSL Types (T889 / T904 / W4-6) ===
export type {
  ContractViolationRecord,
  PlaybookAgenticNode,
  PlaybookApproval,
  PlaybookApprovalNode,
  PlaybookApprovalStatus,
  PlaybookDefinition,
  PlaybookDeterministicNode,
  PlaybookEdge,
  PlaybookEnsures,
  PlaybookErrorHandler,
  PlaybookInput,
  PlaybookNode,
  PlaybookNodeBase,
  PlaybookNodeOnFailure,
  PlaybookNodeType,
  PlaybookPolicy,
  PlaybookRequires,
  PlaybookRun,
  PlaybookRunStatus,
} from './playbook.js';
export type { AdapterPathProvider } from './provider-paths.js';
// === Result Types (Dashboard, Stats, Log, Context, Sequence, Analysis, Deps) ===
export type {
  BottleneckTask,
  CompleteTaskUnblocked,
  ContextResult,
  DashboardResult,
  LabelCount,
  LeveragedTask,
  LogQueryResult,
  SequenceResult,
  StatsActivityMetrics,
  StatsAllTime,
  StatsCompletionMetrics,
  StatsCurrentState,
  StatsCycleTimes,
  StatsResult,
  TaskAnalysisResult,
  TaskDepsResult,
  TaskRef,
  TaskRefPriority,
  TaskSummary,
} from './results.js';
// === Sentient Tier-2 Types (T1008) ===
export type {
  ProposalCandidate,
  ProposalSource,
  ProposedTaskMeta,
  Tier2Stats,
} from './sentient.js';
// === Session Start Result ===
export type {
  Session,
  SessionScope,
  SessionStartResult,
  SessionStats,
  SessionTaskWork,
} from './session.js';
// === Session Types ===
export { SessionView } from './session.js';
export type {
  SessionJournalDebriefSummary,
  SessionJournalDoctorSummary,
  SessionJournalEntry,
} from './session-journal.js';
// === Session Journal Types (T1263 PSYCHE E6) ===
export {
  SESSION_JOURNAL_SCHEMA_VERSION,
  sessionJournalDebriefSummarySchema,
  sessionJournalDoctorSummarySchema,
  sessionJournalEntrySchema,
} from './session-journal.js';
export type { AdapterSpawnProvider, SpawnContext, SpawnResult } from './spawn.js';
// === CLEO Spawn Types (distinct from adapter spawn) ===
export type {
  CAAMPSpawnOptions,
  CAAMPSpawnResult,
  CLEOSpawnAdapter,
  CLEOSpawnContext,
  CLEOSpawnResult,
  Provider,
  SpawnStatus,
  TokenResolution,
} from './spawn-types.js';
// === Status Registry (MUST be first — everything depends on this) ===
export {
  ADR_STATUSES,
  type AdrStatus,
  // Registry
  type EntityType,
  GATE_STATUSES,
  type GateStatus,
  isValidStatus,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  MANIFEST_STATUSES,
  type ManifestStatus,
  // Display icons
  PIPELINE_STATUS_ICONS,
  type PipelineStatus,
  SESSION_STATUSES,
  type SessionStatus,
  STAGE_STATUS_ICONS,
  STATUS_REGISTRY,
  type StageStatus,
  TASK_STATUS_SYMBOLS_ASCII,
  TASK_STATUS_SYMBOLS_UNICODE,
  // Constants
  TASK_STATUSES,
  // Derived types
  type TaskStatus,
  TERMINAL_PIPELINE_STATUSES,
  TERMINAL_STAGE_STATUSES,
  // Terminal state sets
  TERMINAL_TASK_STATUSES,
} from './status-registry.js';
// === Task Types ===
export type {
  AcceptanceItem,
  CancelledTask,
  CompletedTask,
  EpicLifecycle,
  EvidenceAtom,
  FileMeta,
  GateEvidence,
  Phase,
  PhaseStatus,
  PhaseTransition,
  ProjectMeta,
  Release,
  ReleaseStatus,
  SessionNote,
  Task,
  TaskCreate,
  TaskOrigin,
  TaskPriority,
  TaskProvenance,
  TaskRelation,
  // T944 new axes
  TaskRole,
  TaskScope,
  TaskSeverity,
  TaskSize,
  TaskType,
  TaskVerification,
  TaskWorkState,
  VerificationAgent,
  VerificationFailure,
  VerificationGate,
} from './task.js';
// === Task Evidence Types (T801) ===
export type {
  CommandOutputEvidence,
  FileEvidence,
  LogEvidence,
  ScreenshotEvidence,
  TaskEvidence,
  TaskEvidenceInput,
  TaskEvidenceKind,
  TestOutputEvidence,
} from './task-evidence.js';
export {
  commandOutputEvidenceSchema,
  fileEvidenceSchema,
  logEvidenceSchema,
  screenshotEvidenceSchema,
  taskEvidenceSchema,
  testOutputEvidenceSchema,
} from './task-evidence.js';
// === TaskRecord Types (string-widened for dispatch/LAFS) ===
export type {
  MinimalTaskRecord,
  TaskRecord,
  TaskRecordRelation,
  ValidationHistoryEntry,
} from './task-record.js';
// === Task Sync Types (provider-agnostic reconciliation) ===
export type {
  ConflictPolicy,
  ExternalLinkType,
  ExternalTask,
  ExternalTaskLink,
  ExternalTaskProvider,
  ExternalTaskStatus,
  ReconcileAction,
  ReconcileActionType,
  ReconcileOptions,
  ReconcileResult,
  SyncDirection,
} from './task-sync.js';
// === Tessera Types ===
export type {
  TesseraInstantiationInput,
  TesseraTemplate,
  TesseraVariable,
} from './tessera.js';
// === Transport (low-level wire protocol) ===
export type {
  AdapterTransportProvider,
  Transport,
  TransportConnectConfig,
} from './transport.js';
// === WarpChain Types ===
export type {
  ChainShape,
  ChainValidation,
  GateCheck,
  GateContract,
  GateName,
  GateResult,
  ProtocolType,
  WarpChain,
  WarpChainExecution,
  WarpChainInstance,
  WarpLink,
  WarpStage,
} from './warp-chain.js';
// === Audit Lineage Reconstruction Types (T1322) ===
export type {
  CommitEntry,
  ReconstructResult,
  ReleaseTagEntry,
} from './audit.js';
// === WASM SDK (Rust crate bindings) ===
