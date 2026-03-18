/**
 * @cleocode/contracts — Domain types, interfaces, and contracts for the CLEO ecosystem.
 *
 * This is the LEAF package in the dependency graph — ZERO runtime dependencies.
 * All domain types (Task, Session, DataAccessor, etc.) are defined here.
 * Implementation packages (@cleocode/core, @cleocode/cleoctl) import from here.
 */

// === Status Registry (MUST be first — everything depends on this) ===
export {
  // Constants
  TASK_STATUSES,
  SESSION_STATUSES,
  LIFECYCLE_PIPELINE_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  ADR_STATUSES,
  GATE_STATUSES,
  MANIFEST_STATUSES,
  // Derived types
  type TaskStatus,
  type SessionStatus,
  type PipelineStatus,
  type StageStatus,
  type AdrStatus,
  type GateStatus,
  type ManifestStatus,
  // Terminal state sets
  TERMINAL_TASK_STATUSES,
  TERMINAL_PIPELINE_STATUSES,
  TERMINAL_STAGE_STATUSES,
  // Registry
  type EntityType,
  STATUS_REGISTRY,
  isValidStatus,
  // Display icons
  PIPELINE_STATUS_ICONS,
  STAGE_STATUS_ICONS,
  TASK_STATUS_SYMBOLS_UNICODE,
  TASK_STATUS_SYMBOLS_ASCII,
} from './status-registry.js';

// === Task Types ===
export type {
  TaskPriority,
  TaskType,
  TaskSize,
  EpicLifecycle,
  TaskOrigin,
  VerificationAgent,
  VerificationGate,
  VerificationFailure,
  TaskVerification,
  TaskProvenance,
  TaskRelation,
  Task,
  PhaseStatus,
  Phase,
  PhaseTransition,
  ReleaseStatus,
  Release,
  ProjectMeta,
  FileMeta,
  SessionNote,
  TaskWorkState,
  TaskFile,
} from './task.js';

// === Session Types ===
export { SessionView } from './session.js';
export type {
  SessionScope,
  SessionStats,
  SessionTaskWork,
  Session,
} from './session.js';

// === Exit Codes ===
export {
  ExitCode,
  isErrorCode,
  isSuccessCode,
  isNoChangeCode,
  isRecoverableCode,
  getExitCodeName,
} from './exit-codes.js';

// === Configuration Types ===
export type {
  OutputFormat,
  DateFormat,
  OutputConfig,
  BackupConfig,
  EnforcementProfile,
  HierarchyConfig,
  SessionConfig,
  LogLevel,
  LoggingConfig,
  LifecycleEnforcementMode,
  LifecycleConfig,
  SharingMode,
  SharingConfig,
  SignalDockMode,
  SignalDockConfig,
  CleoConfig,
  ConfigSource,
  ResolvedValue,
} from './config.js';

// === LAFS Envelope Types ===
export {
  isLafsSuccess,
  isLafsError,
  isGatewayEnvelope,
} from './lafs.js';
export type {
  LAFSErrorCategory,
  LAFSError,
  Warning,
  LAFSTransport,
  MVILevel,
  LAFSPageNone,
  LAFSPageOffset,
  LAFSPage,
  LAFSMeta,
  LAFSEnvelope,
  FlagInput,
  ConformanceReport,
  LafsAlternative,
  LafsErrorDetail,
  LafsSuccess,
  LafsError,
  LafsEnvelope,
  GatewayMeta,
  GatewaySuccess,
  GatewayError,
  GatewayEnvelope,
  CleoResponse,
} from './lafs.js';

// === DataAccessor Interface ===
export type {
  ArchiveFields,
  ArchiveFile,
  TaskQueryFilters,
  QueryTasksResult,
  TaskFieldUpdates,
  TransactionAccessor,
  DataAccessor,
} from './data-accessor.js';

// === Provider Adapter Contracts ===
export type { CLEOProviderAdapter, AdapterHealthStatus } from './adapter.js';
export type { AdapterCapabilities } from './capabilities.js';
export type { AdapterManifest, DetectionPattern } from './discovery.js';
export type { AdapterHookProvider } from './hooks.js';
export type { AdapterInstallProvider, InstallOptions, InstallResult } from './install.js';
export type {
  MemoryBridgeConfig,
  MemoryBridgeContent,
  SessionSummary,
  BridgeLearning,
  BridgePattern,
  BridgeDecision,
  BridgeObservation,
} from './memory.js';
export type { AdapterSpawnProvider, SpawnContext, SpawnResult } from './spawn.js';
export type { AdapterPathProvider } from './provider-paths.js';
export type { AdapterContextMonitorProvider } from './context-monitor.js';
export type { AdapterTransportProvider } from './transport.js';

// === CLEO Spawn Types (distinct from adapter spawn) ===
export type {
  Provider,
  CAAMPSpawnOptions,
  CAAMPSpawnResult,
  CLEOSpawnContext,
  CLEOSpawnResult,
  CLEOSpawnAdapter,
  TokenResolution,
  SpawnStatus,
} from './spawn-types.js';

// === WarpChain Types ===
export type {
  ProtocolType,
  GateName,
  WarpStage,
  WarpLink,
  ChainShape,
  GateCheck,
  GateContract,
  WarpChain,
  ChainValidation,
  WarpChainInstance,
  GateResult,
  WarpChainExecution,
} from './warp-chain.js';

// === Tessera Types ===
export type {
  TesseraVariable,
  TesseraTemplate,
  TesseraInstantiationInput,
} from './tessera.js';

// === Operations Types (API wire format, namespaced to avoid collision with domain types) ===
export * as ops from './operations/index.js';

// Commonly used ops types re-exported at top level for convenience
export type { BrainState } from './operations/orchestrate.js';
