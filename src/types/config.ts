/**
 * Configuration type definitions for CLEO V2.
 * Covers project and global config with cascade resolution.
 * @epic T4454
 * @task T4456
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
  lifecycle: LifecycleConfig;
  logging: LoggingConfig;
  sharing: SharingConfig;
  /** SignalDock inter-agent transport (optional, disabled by default). */
  signaldock?: SignalDockConfig;
}

/** Configuration resolution priority. */
export type ConfigSource = 'cli' | 'env' | 'project' | 'global' | 'default';

/** A resolved config value with its source. */
export interface ResolvedValue<T> {
  value: T;
  source: ConfigSource;
}
