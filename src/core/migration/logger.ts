/**
 * Structured logging for migration operations.
 *
 * Provides audit trail and debugging support for all migration phases.
 * Logs are written in JSONL format for easy parsing and appending.
 *
 * @task T4727
 * @epic T4454
 */

import { existsSync, mkdirSync, statSync, appendFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

/** Log entry severity level */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/** Single migration log entry */
export interface MigrationLogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log level */
  level: LogLevel;
  /** Migration phase (init, backup, import, verify, complete, etc.) */
  phase: string;
  /** Specific operation within phase */
  operation: string;
  /** Human-readable message */
  message: string;
  /** Duration since migration start in milliseconds */
  durationMs: number;
  /** Additional structured data */
  data?: Record<string, unknown>;
}

/** Migration logger configuration */
export interface MigrationLoggerConfig {
  /** Maximum number of log files to retain */
  maxLogFiles?: number;
  /** Minimum log level to record */
  minLevel?: LogLevel;
  /** Enable console output in addition to file logging */
  consoleOutput?: boolean;
}

/** Structured logger for migration operations */
export class MigrationLogger {
  private logPath: string;
  private entries: MigrationLogEntry[] = [];
  private startTime: number;
  private cleoDir: string;
  private config: MigrationLoggerConfig;

  /**
   * Create a new migration logger.
   * @param cleoDir - Path to .cleo directory
   * @param config - Optional configuration
   */
  constructor(cleoDir: string, config: MigrationLoggerConfig = {}) {
    this.cleoDir = cleoDir;
    this.config = {
      maxLogFiles: config.maxLogFiles ?? 10,
      minLevel: config.minLevel ?? 'debug',
      consoleOutput: config.consoleOutput ?? false,
    };

    // Generate timestamped log filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logPath = join(cleoDir, 'logs', `migration-${timestamp}.jsonl`);

    // Ensure logs directory exists
    const logsDir = dirname(this.logPath);
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    this.startTime = Date.now();

    // Clean up old log files
    this.cleanupOldLogs();
  }

  /**
   * Get numeric priority for log level comparison.
   */
  private getLevelPriority(level: LogLevel): number {
    const priorities: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };
    return priorities[level];
  }

  /**
   * Check if a log level should be recorded.
   */
  private shouldLog(level: LogLevel): boolean {
    return this.getLevelPriority(level) >= this.getLevelPriority(this.config.minLevel!);
  }

  /**
   * Write a log entry.
   */
  private log(
    level: LogLevel,
    phase: string,
    operation: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: MigrationLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      phase,
      operation,
      message,
      durationMs: Date.now() - this.startTime,
      data,
    };

    this.entries.push(entry);

    // Append to file
    try {
      appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      // If file logging fails, try console as fallback
      console.error(`Failed to write to migration log: ${String(err)}`);
    }

    // Console output if enabled
    if (this.config.consoleOutput) {
      const prefix = `[${level.toUpperCase()}] ${phase}.${operation}:`;
      if (level === 'error') {
        console.error(prefix, message, data ?? '');
      } else if (level === 'warn') {
        console.warn(prefix, message, data ?? '');
      } else {
        console.log(prefix, message, data ?? '');
      }
    }
  }

  /**
   * Log an info-level message.
   */
  info(phase: string, operation: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', phase, operation, message, data);
  }

  /**
   * Log a warning-level message.
   */
  warn(phase: string, operation: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', phase, operation, message, data);
  }

  /**
   * Log an error-level message.
   */
  error(phase: string, operation: string, message: string, data?: Record<string, unknown>): void {
    this.log('error', phase, operation, message, data);
  }

  /**
   * Log a debug-level message.
   */
  debug(phase: string, operation: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', phase, operation, message, data);
  }

  /**
   * Log file operation with size information.
   */
  logFileOperation(
    phase: string,
    operation: 'read' | 'write' | 'backup' | 'rename' | 'delete',
    sourcePath: string,
    targetPath?: string,
    additionalData?: Record<string, unknown>,
  ): void {
    const data: Record<string, unknown> = {
      sourcePath: relative(this.cleoDir, sourcePath),
      ...additionalData,
    };

    // Get source file size if it exists
    if (existsSync(sourcePath)) {
      try {
        const stats = statSync(sourcePath);
        data.sourceSize = stats.size;
        data.sourceModified = stats.mtime.toISOString();
      } catch {
        // Size not available
      }
    }

    // Get target file size if provided and exists
    if (targetPath) {
      data.targetPath = relative(this.cleoDir, targetPath);
      if (existsSync(targetPath)) {
        try {
          const stats = statSync(targetPath);
          data.targetSize = stats.size;
          data.targetModified = stats.mtime.toISOString();
        } catch {
          // Size not available
        }
      }
    }

    this.info(phase, `file-${operation}`, `File ${operation} operation`, data);
  }

  /**
   * Log validation result.
   */
  logValidation(
    phase: string,
    target: string,
    valid: boolean,
    details?: Record<string, unknown>,
    errors?: string[],
  ): void {
    const data: Record<string, unknown> = {
      target,
      valid,
      ...details,
    };

    if (errors && errors.length > 0) {
      data.errors = errors;
      this.error(phase, 'validation', `Validation failed for ${target}`, data);
    } else if (!valid) {
      this.warn(phase, 'validation', `Validation warning for ${target}`, data);
    } else {
      this.info(phase, 'validation', `Validation passed for ${target}`, data);
    }
  }

  /**
   * Log import progress.
   */
  logImportProgress(
    phase: string,
    entityType: string,
    imported: number,
    total: number,
    additionalData?: Record<string, unknown>,
  ): void {
    const percent = total > 0 ? Math.round((imported / total) * 100) : 0;

    this.info(phase, 'import-progress', `Imported ${imported} of ${total} ${entityType}`, {
      imported,
      total,
      percent,
      remaining: total - imported,
      ...additionalData,
    });
  }

  /**
   * Log phase start.
   */
  phaseStart(phase: string, data?: Record<string, unknown>): void {
    this.info(phase, 'start', `Starting phase: ${phase}`, data);
  }

  /**
   * Log phase completion.
   */
  phaseComplete(phase: string, data?: Record<string, unknown>): void {
    this.info(phase, 'complete', `Completed phase: ${phase}`, data);
  }

  /**
   * Log phase failure.
   */
  phaseFailed(phase: string, error: Error | string, data?: Record<string, unknown>): void {
    this.error(phase, 'failed', `Phase failed: ${phase}`, {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      ...data,
    });
  }

  /**
   * Clean up old log files, keeping only the most recent ones.
   */
  private cleanupOldLogs(): void {
    try {
      const logsDir = join(this.cleoDir, 'logs');
      if (!existsSync(logsDir)) {
        return;
      }

      const { readdirSync, unlinkSync } = require('node:fs');
      const files: Array<{ name: string; path: string; mtime: number }> = readdirSync(logsDir)
        .filter((f: string) => f.startsWith('migration-') && f.endsWith('.jsonl'))
        .map((f: string) => ({
          name: f,
          path: join(logsDir, f),
          mtime: statSync(join(logsDir, f)).mtime.getTime(),
        }))
        .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);

      // Remove files beyond the retention limit
      const filesToRemove = files.slice(this.config.maxLogFiles!);
      for (const file of filesToRemove) {
        try {
          unlinkSync(file.path);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch {
      // Cleanup is best-effort
    }
  }

  /**
   * Get the absolute path to the log file.
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Get the path to the log file relative to cleoDir.
   */
  getRelativeLogPath(): string {
    return relative(this.cleoDir, this.logPath);
  }

  /**
   * Get all logged entries.
   */
  getEntries(): MigrationLogEntry[] {
    return [...this.entries];
  }

  /**
   * Get entries filtered by level.
   */
  getEntriesByLevel(level: LogLevel): MigrationLogEntry[] {
    return this.entries.filter(e => e.level === level);
  }

  /**
   * Get entries for a specific phase.
   */
  getEntriesByPhase(phase: string): MigrationLogEntry[] {
    return this.entries.filter(e => e.phase === phase);
  }

  /**
   * Get the total duration of the migration so far.
   */
  getDurationMs(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Get summary statistics for the migration.
   */
  getSummary(): {
    totalEntries: number;
    durationMs: number;
    errors: number;
    warnings: number;
    info: number;
    debug: number;
    phases: string[];
  } {
    const counts = {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0,
    };

    const phases = new Set<string>();

    for (const entry of this.entries) {
      counts[entry.level]++;
      phases.add(entry.phase);
    }

    return {
      totalEntries: this.entries.length,
      durationMs: this.getDurationMs(),
      errors: counts.error,
      warnings: counts.warn,
      info: counts.info,
      debug: counts.debug,
      phases: Array.from(phases).sort(),
    };
  }
}

/**
 * Create a migration logger for the given cleo directory.
 * Convenience function for functional programming style.
 */
export function createMigrationLogger(
  cleoDir: string,
  config?: MigrationLoggerConfig,
): MigrationLogger {
  return new MigrationLogger(cleoDir, config);
}

/**
 * Read and parse a migration log file.
 */
export function readMigrationLog(logPath: string): MigrationLogEntry[] {
  const { readFileSync } = require('node:fs');
  const content = readFileSync(logPath, 'utf-8');

  return content
    .split('\n')
    .filter((line: string) => line.trim())
    .map((line: string) => JSON.parse(line) as MigrationLogEntry);
}

/**
 * Check if a log file exists and is readable.
 */
export function logFileExists(logPath: string): boolean {
  try {
    const { accessSync, constants } = require('node:fs');
    accessSync(logPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the most recent migration log file for a cleo directory.
 */
export function getLatestMigrationLog(cleoDir: string): string | null {
  try {
    const { readdirSync, statSync } = require('node:fs');
    const logsDir = join(cleoDir, 'logs');

    if (!existsSync(logsDir)) {
      return null;
    }

    const files: Array<{ name: string; path: string; mtime: number }> = readdirSync(logsDir)
      .filter((f: string) => f.startsWith('migration-') && f.endsWith('.jsonl'))
      .map((f: string) => ({
        name: f,
        path: join(logsDir, f),
        mtime: statSync(join(logsDir, f)).mtime.getTime(),
      }))
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);

    return files.length > 0 ? files[0]!.path : null;
  } catch {
    return null;
  }
}
