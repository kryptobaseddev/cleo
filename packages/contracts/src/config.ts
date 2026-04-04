/**
 * Configuration type definitions for CLEO.
 *
 * Covers project and global config with cascade resolution.
 * These are stable types shared across core, dispatch, and CLI.
 *
 * @epic T4454
 * @task T4456
 * @task T5710
 */

/** Output format options. */
export type OutputFormat = 'json' | 'text' | 'jsonl' | 'markdown' | 'table';

/** Date format options. */
export type DateFormat = 'relative' | 'iso' | 'short' | 'long';

/** Output configuration. */
export interface OutputConfig {
  defaultFormat: OutputFormat;
  showColor: boolean;
  showUnicode: boolean;
  showProgressBars: boolean;
  dateFormat: DateFormat;
}

/** Backup configuration. */
export interface BackupConfig {
  maxOperationalBackups: number;
  maxSafetyBackups: number;
  compressionEnabled: boolean;
}

/** Hierarchy enforcement profile preset. */
export type EnforcementProfile = 'llm-agent-first' | 'human-cognitive' | 'custom';

/** Hierarchy configuration. */
export interface HierarchyConfig {
  maxDepth: number;
  maxSiblings: number;
  cascadeDelete: boolean;
  /** Maximum number of active (non-done) siblings. 0 = disabled. */
  maxActiveSiblings: number;
  /** Whether done tasks count toward the sibling limit. */
  countDoneInLimit: boolean;
  /** Enforcement profile preset. Explicit fields override preset values. */
  enforcementProfile: EnforcementProfile;
}

/** Session configuration. */
export interface SessionConfig {
  autoStart: boolean;
  requireNotes: boolean;
  multiSession: boolean;
}

/** Pino log levels. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

/** Logging configuration. */
export interface LoggingConfig {
  /** Minimum log level to record (default: 'info') */
  level: LogLevel;
  /** Log file path relative to .cleo/ (default: 'logs/cleo.log') */
  filePath: string;
  /** Max log file size in bytes before rotation (default: 10MB) */
  maxFileSize: number;
  /** Number of rotated log files to retain (default: 5) */
  maxFiles: number;
  /** Days to retain audit_log rows before pruning (default: 90) */
  auditRetentionDays: number;
  /** Whether to archive pruned rows to compressed JSONL before deletion (default: true) */
  archiveBeforePrune: boolean;
}

/** Acceptance criteria enforcement mode. */
export type AcceptanceEnforcementMode = 'block' | 'warn' | 'off';

/** Acceptance criteria enforcement settings. */
export interface AcceptanceEnforcementConfig {
  /** Enforcement mode. */
  mode: AcceptanceEnforcementMode;
  /** Task priorities that require AC. */
  requiredForPriorities: string[];
  /** Minimum acceptance criteria count. */
  minimumCriteria: number;
}

/** Session enforcement settings. */
export interface SessionEnforcementConfig {
  /** Whether mutate operations require an active session. */
  requiredForMutate: boolean;
}

/** Top-level enforcement configuration. */
export interface EnforcementConfig {
  /** Acceptance criteria enforcement. */
  acceptance: AcceptanceEnforcementConfig;
  /** Session enforcement. */
  session: SessionEnforcementConfig;
}

/** Verification gate configuration. */
export interface VerificationConfig {
  /** Whether verification gates are enabled. */
  enabled: boolean;
  /** Maximum verification rounds. */
  maxRounds: number;
  /** Gate names required for completion. */
  requiredGates: string[];
}

/** Lifecycle enforcement mode. */
export type LifecycleEnforcementMode = 'strict' | 'advisory' | 'off';

/** Lifecycle enforcement configuration. */
export interface LifecycleConfig {
  mode: LifecycleEnforcementMode;
}

/** Sharing mode: whether .cleo/ files are committed to the project git repo. */
export type SharingMode = 'none' | 'project';

/** Sharing configuration for multi-contributor .cleo/ state management. */
export interface SharingConfig {
  /** Sharing mode (default: 'none'). */
  mode: SharingMode;
  /** Files/patterns in .cleo/ to commit to project git (relative to .cleo/). */
  commitAllowlist: string[];
  /** Files/patterns to always exclude, even if in commitAllowlist. */
  denylist: string[];
}

/**
 * Brain memory bridge refresh configuration.
 * Controls when `.cleo/memory-bridge.md` is automatically regenerated.
 *
 * @epic T134
 * @task T135
 */
export interface BrainMemoryBridgeConfig {
  /** Whether to automatically regenerate memory-bridge.md on lifecycle events (default: true). */
  autoRefresh: boolean;
  /** Whether to include scope-aware memory context in generated bridge (default: false). */
  contextAware: boolean;
  /** Maximum token budget for memory bridge content (default: 2000). */
  maxTokens: number;
}

/**
 * Brain embedding provider configuration.
 *
 * @epic T134
 * @task T136
 */
export interface BrainEmbeddingConfig {
  /** Whether semantic embedding is enabled (default: false). */
  enabled: boolean;
  /** Embedding provider to use (default: 'local'). */
  provider: 'local' | 'openai';
}

/**
 * Brain session summarization configuration.
 *
 * @epic T134
 * @task T140
 */
export interface BrainSummarizationConfig {
  /** Whether session summarization is enabled (default: false). */
  enabled: boolean;
}

/**
 * Brain (BRAIN memory system) configuration.
 * Controls automated memory capture, embedding generation, memory bridge
 * refresh behavior, and session summarization.
 *
 * @epic T134
 * @task T135
 */
export interface BrainConfig {
  /** Whether to automatically capture observations from lifecycle events (default: true). */
  autoCapture: boolean;
  /** Whether to capture file change events (default: false). */
  captureFiles: boolean;
  /** Unused. CLI dispatch only. */
  captureMcp: boolean;
  /** Whether to capture active-work dispatch mutations (tasks.add, tasks.update) (default: false). */
  captureWork: boolean;
  /** Embedding provider settings. */
  embedding: BrainEmbeddingConfig;
  /** Memory bridge auto-refresh settings. */
  memoryBridge: BrainMemoryBridgeConfig;
  /** Session summarization settings. */
  summarization: BrainSummarizationConfig;
}

/**
 * Structured session summary input for ingestStructuredSummary().
 *
 * @epic T134
 * @task T140
 */
export interface SessionSummaryInput {
  /** Key learnings from this session. */
  keyLearnings: string[];
  /** Decisions made during this session. */
  decisions: string[];
  /** Patterns observed during this session. */
  patterns: string[];
  /** Suggested next actions. */
  nextActions: string[];
}

/** SignalDock transport mode. */
export type SignalDockMode = 'http' | 'native';

/** SignalDock integration configuration. */
export interface SignalDockConfig {
  /** Whether SignalDock transport is enabled (default: false). */
  enabled: boolean;
  /** Transport mode: 'http' for REST API client, 'native' for napi-rs bindings (default: 'http'). */
  mode: SignalDockMode;
  /** SignalDock API server endpoint (default: 'http://localhost:4000'). */
  endpoint: string;
  /** Prefix for CLEO agent names in SignalDock registry (default: 'cleo-'). */
  agentPrefix: string;
  /** Default privacy tier for registered agents (default: 'private'). */
  privacyTier: 'public' | 'discoverable' | 'private';
}

/** CLEO project configuration (config.json). */
export interface CleoConfig {
  version: string;
  output: OutputConfig;
  backup: BackupConfig;
  hierarchy: HierarchyConfig;
  session: SessionConfig;
  enforcement: EnforcementConfig;
  verification: VerificationConfig;
  lifecycle: LifecycleConfig;
  logging: LoggingConfig;
  sharing: SharingConfig;
  /** SignalDock inter-agent transport (optional, disabled by default). */
  signaldock?: SignalDockConfig;
  /** Brain memory system configuration (optional, uses defaults when absent). */
  brain?: BrainConfig;
}

/** Configuration resolution priority. */
export type ConfigSource = 'cli' | 'env' | 'project' | 'global' | 'default';

/** A resolved config value with its source. */
export interface ResolvedValue<T> {
  value: T;
  source: ConfigSource;
}
