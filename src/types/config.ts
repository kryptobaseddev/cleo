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

/** Hierarchy configuration. */
export interface HierarchyConfig {
  maxDepth: number;
  maxSiblings: number;
  cascadeDelete: boolean;
}

/** Session configuration. */
export interface SessionConfig {
  autoFocus: boolean;
  requireNotes: boolean;
  multiSession: boolean;
}

/** Lifecycle enforcement mode. */
export type LifecycleEnforcementMode = 'strict' | 'advisory' | 'off';

/** Lifecycle enforcement configuration. */
export interface LifecycleConfig {
  mode: LifecycleEnforcementMode;
}

/** CLEO project configuration (config.json). */
export interface CleoConfig {
  version: string;
  output: OutputConfig;
  backup: BackupConfig;
  hierarchy: HierarchyConfig;
  session: SessionConfig;
  lifecycle: LifecycleConfig;
}

/** Configuration resolution priority. */
export type ConfigSource = 'cli' | 'env' | 'project' | 'global' | 'default';

/** A resolved config value with its source. */
export interface ResolvedValue<T> {
  value: T;
  source: ConfigSource;
}
