/**
 * Centralized pino logger factory for CLEO.
 *
 * Singleton pattern. Uses pino-roll for automatic file rotation and retention.
 * Custom formatters for uppercase level labels and ISO timestamps.
 * Context via child loggers (getLogger('subsystem')).
 *
 * MCP safety: all diagnostic logging goes to files — stdout is reserved
 * for the MCP protocol. Fallback stderr logger if not yet initialized.
 */

import pino from 'pino';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

let rootLogger: pino.Logger | null = null;
let currentLogDir: string | null = null;

export interface LoggerConfig {
  level: string;
  filePath: string;
  maxFileSize: number;
  maxFiles: number;
}

/**
 * Convert bytes to a human-readable size string for pino-roll.
 * pino-roll accepts '10m', '1g', '500k', etc.
 */
function bytesToSizeString(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${Math.floor(bytes / (1024 * 1024 * 1024))}g`;
  if (bytes >= 1024 * 1024) return `${Math.floor(bytes / (1024 * 1024))}m`;
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)}k`;
  return `${bytes}`;
}

/**
 * Initialize the root logger. Call once at startup.
 *
 * Uses pino-roll for automatic size+daily rotation with built-in retention.
 * No custom rotation code needed.
 *
 * @param cleoDir      - Absolute path to .cleo directory
 * @param config       - Logging configuration from CleoConfig.logging
 * @param projectHash  - Stable project identity token bound to every log entry.
 *                        Optional for backward compatibility; warns if absent.
 * @returns The root pino logger instance
 */
export function initLogger(
  cleoDir: string,
  config: LoggerConfig,
  projectHash?: string,
): pino.Logger {
  const dest = join(cleoDir, config.filePath);
  currentLogDir = dirname(dest);

  // Log directory should already exist via ensureCleoStructure() which
  // creates all REQUIRED_CLEO_SUBDIRS including 'logs'. The pino-roll
  // transport has mkdir: true as a safety net for edge cases where the
  // logger is initialized before scaffold (e.g. early startup fallback).
  if (!existsSync(currentLogDir)) {
    // Emit to stderr — safe for MCP (protocol is stdout only)
    process.stderr.write(
      `[cleo:logger] Log directory missing: ${currentLogDir} — pino-roll will create it\n`,
    );
  }

  // Use pino-roll transport for automatic rotation and retention.
  // pino.transport() runs in a worker thread; sync: true ensures
  // no log loss on process exit (critical for CLI tools).
  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: dest,
      size: bytesToSizeString(config.maxFileSize),
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      mkdir: true,
      limit: {
        count: config.maxFiles,
        removeOtherLogFiles: true,
      },
    },
  });

  // Build base object: projectHash and platform info appear in every log entry.
  // Pino merges base with pid/hostname by default; we add our fields alongside.
  const base: Record<string, unknown> = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  };
  if (projectHash) {
    base.projectHash = projectHash;
  }

  rootLogger = pino(
    {
      level: config.level,
      base,
      formatters: {
        level: (label: string) => ({ level: label.toUpperCase() }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );

  // Warn after logger is initialized so the message goes to the log file
  if (!projectHash) {
    getLogger('engine').warn(
      'projectHash not provided to initLogger; audit correlation will be incomplete',
    );
  }

  return rootLogger;
}

/**
 * Get a child logger bound to a subsystem name.
 *
 * Safe to call before initLogger — returns a stderr fallback logger
 * so early startup code and tests never crash.
 *
 * @param subsystem - Logical subsystem name (e.g. 'audit', 'mcp', 'migration')
 */
export function getLogger(subsystem: string): pino.Logger {
  if (!rootLogger) {
    // Fallback: stderr logger (safe for MCP — protocol is stdout)
    return pino(
      {
        level: 'warn',
        formatters: { level: (label: string) => ({ level: label.toUpperCase() }) },
      },
      pino.destination(2),
    ).child({ subsystem });
  }
  return rootLogger.child({ subsystem });
}

/**
 * Get the current log directory path.
 * Useful for read APIs that need to scan log files.
 */
export function getLogDir(): string | null {
  return currentLogDir;
}

/**
 * Flush and close the logger. Call during graceful shutdown.
 */
export function closeLogger(): void {
  if (rootLogger) {
    rootLogger.flush();
  }
  rootLogger = null;
  currentLogDir = null;
}
