/**
 * @cleocode/contracts — Provider adapter contracts and shared types for CLEO.
 *
 * @task T5240
 * @task T5710
 */

// Provider adapter contracts
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

// Shared types: ExitCode enum + utilities
export {
  ExitCode,
  getExitCodeName,
  isErrorCode,
  isNoChangeCode,
  isRecoverableCode,
  isSuccessCode,
} from './exit-codes.js';

// Shared types: Configuration
export type {
  BackupConfig,
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
  SharingConfig,
  SharingMode,
  SignalDockConfig,
  SignalDockMode,
} from './config.js';

// Shared types: Task type aliases
export type {
  EpicLifecycle,
  PhaseStatus,
  ReleaseStatus,
  TaskOrigin,
  TaskPriority,
  TaskProvenance,
  TaskRelation,
  TaskSize,
  TaskType,
  TaskVerification,
  VerificationAgent,
  VerificationFailure,
  VerificationGate,
} from './task-types.js';
