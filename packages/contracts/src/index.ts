/**
 * @cleocode/contracts — Domain types, interfaces, and contracts for the CLEO ecosystem.
 *
 * This is the LEAF package in the dependency graph — ZERO runtime dependencies.
 * All domain types (Task, Session, DataAccessor, etc.) are defined here.
 * Implementation packages (@cleocode/core, @cleocode/cleo) import from here.
 */

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
  CleoConfig,
  ConfigSource,
  DateFormat,
  EnforcementProfile,
  HierarchyConfig,
  LifecycleConfig,
  LifecycleEnforcementMode,
  LoggingConfig,
  LogLevel,
  OutputConfig,
  OutputFormat,
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
  normalizeError,
} from './errors.js';
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
  MemoryBridgeConfig,
  MemoryBridgeContent,
  SessionSummary,
} from './memory.js';
// === Operations Types (API wire format, namespaced to avoid collision with domain types) ===
export * as ops from './operations/index.js';
// Commonly used ops types re-exported at top level for convenience
export type { BrainState } from './operations/orchestrate.js';
// === Orchestration Hierarchy ===
export {
  type AgentHierarchy,
  type AgentHierarchyEntry,
  type EscalationChain,
  type OrchestrationHierarchyAPI,
  OrchestrationLevel,
} from './orchestration-hierarchy.js';
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
  CancelledTask,
  CompletedTask,
  EpicLifecycle,
  FileMeta,
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
  TaskSize,
  TaskType,
  TaskVerification,
  TaskWorkState,
  VerificationAgent,
  VerificationFailure,
  VerificationGate,
} from './task.js';
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

// === WASM SDK (Rust crate bindings) ===
