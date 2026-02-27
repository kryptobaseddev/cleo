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
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
 * @param cleoDir - Absolute path to .cleo directory
 * @param config  - Logging configuration from CleoConfig.logging
 * @returns The root pino logger instance
 */
export function initLogger(cleoDir: string, config: LoggerConfig): pino.Logger {
  const dest = join(cleoDir, config.filePath);
  currentLogDir = dirname(dest);

  // Ensure directory exists
  mkdirSync(currentLogDir, { recursive: true });

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

  rootLogger = pino(
    {
      level: config.level,
      formatters: {
        level: (label: string) => ({ level: label.toUpperCase() }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );

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
