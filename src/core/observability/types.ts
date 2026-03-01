/**
 * Type definitions for the CLEO log reader (observability) module.
 *
 * Covers pino JSONL log entry parsing, file discovery, filtering,
 * and query results.
 *
 * @task T5187
 * @epic T5186
 */

/** Pino log levels as written by CLEO's logger (uppercase). */
export type PinoLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

/** Numeric pino level values for comparison. */
export const PINO_LEVEL_VALUES: Record<PinoLevel, number> = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
};

/**
 * A parsed pino log entry from a CLEO log file.
 * Core fields are always present; additional fields are captured in `extra`.
 */
export interface PinoLogEntry {
  /** Uppercase log level */
  level: PinoLevel;
  /** ISO 8601 UTC timestamp */
  time: string;
  /** Process ID */
  pid: number;
  /** Machine hostname */
  hostname: string;
  /** Human-readable log message */
  msg: string;
  /** Logical subsystem name (from child logger) */
  subsystem?: string;
  /** CLEO error code (on warn/error entries) */
  code?: string;
  /** Numeric exit code (on warn/error entries) */
  exitCode?: number;
  /** Any additional fields not in the core schema */
  extra: Record<string, unknown>;
}

/** Metadata about a discovered log file. */
export interface LogFileInfo {
  /** Absolute path to the log file */
  path: string;
  /** File name (e.g., 'cleo.2026-02-28.1.log') */
  name: string;
  /** File size in bytes */
  size: number;
  /** Last modification time (ISO string) */
  mtime: string;
  /** Parsed date from filename, or null if unparseable */
  date: string | null;
  /** Whether this is the currently active (latest) log file */
  isActive: boolean;
}

/**
 * Filter criteria for log queries.
 * All fields are optional; when multiple are provided, they are ANDed.
 */
export interface LogFilter {
  /** Minimum log level (inclusive). E.g., 'WARN' returns WARN + ERROR + FATAL */
  minLevel?: PinoLevel;
  /** Exact log level match */
  level?: PinoLevel;
  /** Start time (inclusive, ISO 8601) */
  since?: string;
  /** End time (inclusive, ISO 8601) */
  until?: string;
  /** Filter by subsystem name (exact match) */
  subsystem?: string;
  /** Filter by CLEO error code (exact match) */
  code?: string;
  /** Filter by exit code (exact match) */
  exitCode?: number;
  /** Text search in msg field (case-insensitive substring) */
  msgContains?: string;
  /** Filter by PID */
  pid?: number;
  /** Maximum entries to return */
  limit?: number;
  /** Number of entries to skip (for pagination) */
  offset?: number;
}

/** Result of a log query operation. */
export interface LogQueryResult {
  /** Matched entries */
  entries: PinoLogEntry[];
  /** Total entries scanned (before limit/offset) */
  totalScanned: number;
  /** Total entries matching filters (before limit/offset) */
  totalMatched: number;
  /** Files that were read */
  files: string[];
}

/** Options for discovering log files. */
export interface LogDiscoveryOptions {
  /** Which log directory to scan: 'project', 'global', or 'both' (default: 'project') */
  scope?: 'project' | 'global' | 'both';
  /** Only include files modified after this date (ISO 8601) */
  since?: string;
  /** Include migration log files (default: false) */
  includeMigration?: boolean;
}

/** Summary of log activity across files. */
export interface LogSummary {
  totalEntries: number;
  byLevel: Record<string, number>;
  bySubsystem: Record<string, number>;
  dateRange: { earliest: string; latest: string } | null;
  files: LogFileInfo[];
}
