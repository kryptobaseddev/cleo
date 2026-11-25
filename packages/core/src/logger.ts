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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LoggerConfig, LoggingConfig } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import pino from 'pino';

// T9766 — `LoggerConfig` lives in `@cleocode/contracts`. Re-export here so
// existing `import { LoggerConfig } from '@cleocode/core'` continues to work
// without churn. New consumers should import from `@cleocode/contracts`
// directly.
export type { LoggerConfig };

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
let quietMode = false;

/**
 * Enable or disable quiet mode for the logger subsystem.
 *
 * When quiet=true:
 *   - The stderr fallback `getLogger()` returns silent-level loggers.
 *   - If the root logger is initialized, its level is set to 'silent'.
 *
 * Critical CLI errors that route through `cliError()` and `process.exit()`
 * are emitted via direct stderr writes outside this subsystem and are NOT
 * affected by quiet mode — see T9933 spec.
 *
 * @task T9933
 */
export function setLoggerQuiet(quiet: boolean): void {
  quietMode = quiet;
  if (quiet && rootLogger) {
    rootLogger.level = 'silent';
  }
}

/**
 * Inspect the current quiet-mode flag. Exposed for tests + diagnostics.
 *
 * @task T9933
 */
export function isLoggerQuiet(): boolean {
  return quietMode;
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
 * Default pino logging settings. They equal the logger fields of
 * `DEFAULTS.logging` in `config.ts` (pinned by `logger.test.ts`); config.ts
 * does not import them because many tests mock this module.
 */
export const LOGGER_CONFIG_DEFAULTS: Readonly<
  Pick<LoggingConfig, 'level' | 'filePath' | 'maxFileSize' | 'maxFiles'>
> = {
  level: 'info',
  filePath: 'logs/cleo.log',
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
};

/** Narrow an unknown JSON value to a plain object, else `{}`. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The well-typed logger fields of one config section. */
function pickLoggerFields(section: Record<string, unknown>): Partial<LoggerConfig> {
  const picked: Partial<LoggerConfig> = {};
  if (typeof section.level === 'string') picked.level = section.level;
  if (typeof section.filePath === 'string') picked.filePath = section.filePath;
  if (typeof section.maxFileSize === 'number') picked.maxFileSize = section.maxFileSize;
  if (typeof section.maxFiles === 'number') picked.maxFiles = section.maxFiles;
  return picked;
}

/** Parse a config.json file; a missing or malformed file reads as `{}`. */
function readConfigFile(path: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return {};
  }
}

/**
 * Resolve the logger settings the way `loadConfig()` resolves `logging`:
 * defaults, then the global `config.json`, then the project's (its legacy
 * `pinoLogging` section first, `logging` over it), then `CLEO_LOG_LEVEL` and
 * `CLEO_LOG_FILE`. Reads only the two JSON files, so CLI startup pays no
 * extra modules for it (T14605).
 *
 * @param cleoDir - Absolute path to the project's `.cleo` directory.
 * @returns The merged logger configuration.
 */
export function resolveLoggerConfig(cleoDir: string): LoggerConfig {
  const globalConfig = readConfigFile(join(getCleoHome(), 'config.json'));
  const projectConfig = readConfigFile(join(cleoDir, 'config.json'));
  const config: LoggerConfig = {
    ...LOGGER_CONFIG_DEFAULTS,
    ...pickLoggerFields(asRecord(globalConfig.logging)),
    ...pickLoggerFields(asRecord(projectConfig.pinoLogging)),
    ...pickLoggerFields(asRecord(projectConfig.logging)),
  };
  const envLevel = process.env['CLEO_LOG_LEVEL'];
  if (envLevel) config.level = envLevel;
  const envFile = process.env['CLEO_LOG_FILE'];
  if (envFile) config.filePath = envFile;
  return config;
}

/**
 * Start the file logger for a CLI process unless one is already running
 * (T14605). Reads the settings with {@link resolveLoggerConfig} and calls
 * {@link initLogger}; until this runs, {@link getLogger} returns the stderr
 * warn fallback and info/debug lines are dropped.
 *
 * @param cleoDir     - Absolute path to the project's `.cleo` directory.
 * @param projectHash - Project identity bound to every entry, when known.
 * @returns `true` when this call started the logger, `false` when one was
 *   already running.
 */
export function startFileLogger(cleoDir: string, projectHash?: string): boolean {
  if (rootLogger) return false;
  initLogger(cleoDir, resolveLoggerConfig(cleoDir), projectHash);
  return true;
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
    // Fallback: stderr logger (stdout reserved for structured output).
    // Under quiet mode (T9933), drop fallback warnings entirely so
    // operators piping JSON output see clean stderr.
    return pino(
      {
        level: quietMode ? 'silent' : 'warn',
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
