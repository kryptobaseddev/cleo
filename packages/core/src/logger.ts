/**
 * Centralized pino logger factory for CLEO.
 *
 * Singleton pattern. Uses pino-roll for automatic file rotation and retention.
 * Custom formatters for uppercase level labels and ISO timestamps.
 * Context via child loggers (getLogger('subsystem')).
 *
 * All diagnostic logging goes to files — stdout is reserved for structured
 * CLI output. Fallback stderr logger if not yet initialized.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pino from 'pino';

/**
 * Minimal shape of the pino-roll transport return value. `pino.transport()`
 * returns a writable stream that backs a worker thread; we only call
 * `.end(callback?)` on it during shutdown to terminate the worker so
 * pino-roll's rotation logic can't fire after the containing tmpdir is
 * removed (Vitest uncaught-exception repro, test.YYYY-MM-DD.N.log ENOENT).
 */
interface TransportStream {
  end: (callback?: () => void) => void;
}

let rootLogger: pino.Logger | null = null;
let currentLogDir: string | null = null;
let currentTransport: TransportStream | null = null;

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
    // Emit to stderr — stdout is reserved for structured output
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

  currentTransport = transport as unknown as TransportStream;
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
 * @param subsystem - Logical subsystem name (e.g. 'audit', 'dispatch', 'migration')
 */
export function getLogger(subsystem: string): pino.Logger {
  if (!rootLogger) {
    // Fallback: stderr logger (stdout reserved for structured output)
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
 *
 * Returns a Promise that resolves once the pino transport worker thread
 * has processed all pending writes. Callers that cannot await (e.g. sync
 * shutdown handlers) may fire-and-forget safely — the underlying flush
 * will still occur before the process exits.
 */
export function closeLogger(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!rootLogger) {
      resolve();
      return;
    }
    const logger = rootLogger;
    const transport = currentTransport;
    // Flush pending writes through the pino-roll worker, then terminate the
    // worker's writable stream. Without `.end()` the worker keeps its
    // rotation timer alive and can try to open the next rotation file
    // (e.g. `.1.log`) after the containing tmpdir has been rm'd, producing
    // an ENOENT uncaught exception that Vitest surfaces even when every
    // test passed. The end-callback is not guaranteed to fire (pino's
    // transport worker may exit before acknowledging), so a short timeout
    // fallback ensures closeLogger() always resolves promptly.
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      rootLogger = null;
      currentLogDir = null;
      currentTransport = null;
      resolve();
    };
    logger.flush(() => {
      if (transport && typeof transport.end === 'function') {
        try {
          transport.end(done);
        } catch {
          done();
        }
        // Fallback: resolve after a short delay if the end-callback
        // never fires. 100ms is enough for the worker thread to
        // finish flushing + terminate in the normal path.
        setTimeout(done, 100);
      } else {
        done();
      }
    });
  });
}
