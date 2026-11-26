/**
 * Centralized pino logger factory for CLEO.
 *
 * Singleton pattern. Writes in-thread through pino's own async destination
 * (sonic-boom): no transport worker thread, so a CLI call pays no extra thread
 * or memory for it (T14605). Rotation and retention run once at startup and
 * keep pino-roll's file naming (`cleo.YYYY-MM-DD.N.log`).
 * Custom formatters for uppercase level labels and ISO timestamps.
 * Context via child loggers (getLogger('subsystem')).
 *
 * All diagnostic logging goes to files — stdout is reserved for structured
 * CLI output. Fallback stderr logger if not yet initialized.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { LoggerConfig, LoggingConfig } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import pino from 'pino';

// T9766 — `LoggerConfig` lives in `@cleocode/contracts`. Re-export here so
// existing `import { LoggerConfig } from '@cleocode/core'` continues to work
// without churn. New consumers should import from `@cleocode/contracts`
// directly.
export type { LoggerConfig };

/** The in-thread log destination (sonic-boom) pino writes to. */
type LogDestination = ReturnType<typeof pino.destination>;

let rootLogger: pino.Logger | null = null;
let currentLogDir: string | null = null;
let currentDestination: LogDestination | null = null;
let removeSignalFlush: (() => void) | null = null;
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

/** One rotated log file: `<stem>.<YYYY-MM-DD>.<N><ext>`. */
interface RotatedLogFile {
  name: string;
  date: string;
  number: number;
}

/** Local calendar date as `YYYY-MM-DD` (pino-roll's `dateFormat`). */
function formatLogDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Rotated files of one configured log path, oldest first. */
function listRotatedLogs(dir: string, stem: string, ext: string): RotatedLogFile[] {
  const pattern = new RegExp(
    `^${escapeRegExp(stem)}\\.(\\d{4}-\\d{2}-\\d{2})\\.(\\d+)${escapeRegExp(ext)}$`,
  );
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: RotatedLogFile[] = [];
  for (const name of names) {
    const match = pattern.exec(name);
    if (match) files.push({ name, date: match[1] ?? '', number: Number(match[2]) });
  }
  return files.sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number);
}

/** Size of a file in bytes, or 0 when it does not exist. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Pick the file this process appends to and prune old ones (T14605).
 *
 * Keeps pino-roll's naming, which `observability/log-reader.ts` reads: the
 * configured `logs/cleo.log` is written as `logs/cleo.<date>.<N>.log`. Today's
 * newest file is reused until it reaches `maxFileSize`, then the next number
 * starts; a new day starts at 1. Rotation happens here, once per process, so
 * a long-running process keeps its file. Like pino-roll's `limit.count`, it
 * keeps `maxFiles` older files besides the active one and deletes the rest,
 * but always keeps at least one: the newest older file may still be another
 * process's active file, so `maxFiles: 0` keeps it too.
 *
 * @param logPath     - Absolute configured log path (e.g. `.cleo/logs/cleo.log`).
 * @param maxFileSize - Bytes after which a new file is started.
 * @param maxFiles    - Older rotated files to keep besides the active one.
 * @param now         - Clock for the date part of the name.
 * @returns Absolute path of the file to append to.
 */
export function rotateLogAtStartup(
  logPath: string,
  maxFileSize: number,
  maxFiles: number,
  now: Date = new Date(),
): string {
  const dir = dirname(logPath);
  const ext = extname(logPath);
  const stem = basename(logPath, ext);
  const today = formatLogDate(now);
  const existing = listRotatedLogs(dir, stem, ext);
  const latestToday = existing.filter((f) => f.date === today).at(-1);
  let number = latestToday?.number ?? 1;
  if (latestToday && fileSize(join(dir, latestToday.name)) >= maxFileSize) number += 1;
  const activeName = `${stem}.${today}.${number}${ext}`;

  const older = existing.filter((f) => f.name !== activeName);
  const keep = Math.max(1, maxFiles);
  for (const file of older.slice(0, Math.max(0, older.length - keep))) {
    try {
      unlinkSync(join(dir, file.name));
    } catch {
      // Retention is best-effort: a file another process removed is fine.
    }
  }
  return join(dir, activeName);
}

/**
 * Initialize the root logger. Call once at startup.
 *
 * Rotates with {@link rotateLogAtStartup}, then writes in-thread through
 * `pino.destination` (no worker thread).
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

  // An unknown level makes pino throw; fall back before anything is opened.
  let level = config.level;
  if (!isLogLevel(level)) {
    process.stderr.write(
      `[cleo:logger] Unknown logging.level "${level}"; using "${LOGGER_CONFIG_DEFAULTS.level}"\n`,
    );
    level = LOGGER_CONFIG_DEFAULTS.level;
  }

  // Rotate once, then append in-thread. The fd is opened synchronously so the
  // destination is ready at once: pino's exit hook (registered for every
  // `sync: false` destination) flushes pending lines on a normal exit, which
  // needs an open fd.
  mkdirSync(currentLogDir, { recursive: true });
  const activeFile = rotateLogAtStartup(dest, config.maxFileSize, config.maxFiles);
  const fd = openSync(activeFile, 'a');
  let destination: LogDestination;
  let logger: pino.Logger;
  try {
    destination = pino.destination({ dest: fd, sync: false });

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

    logger = pino(
      {
        level,
        base,
        formatters: {
          level: (label: string) => ({ level: label.toUpperCase() }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      destination,
    );
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  currentDestination = destination;
  rootLogger = logger;
  removeSignalFlush?.();
  removeSignalFlush = flushOnTerminatingSignals(destination);

  // Warn after logger is initialized so the message goes to the log file
  if (!projectHash) {
    getLogger('engine').warn(
      'projectHash not provided to initLogger; audit correlation will be incomplete',
    );
  }

  return logger;
}

/** Whether `level` names a pino level (`silent` included). */
function isLogLevel(level: string): boolean {
  return level === 'silent' || Object.hasOwn(pino.levels.values, level);
}

/** Signals whose default action ends the process before pino's exit hook runs. */
const TERMINATING_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Flush buffered log lines when SIGINT or SIGTERM arrives (T14605). Node runs
 * no `exit` handlers on a signal's default action, so pino's exit hook never
 * fires and buffered lines would be lost. The handler flushes, removes itself
 * and, when no other listener handles the signal, re-raises it so the process
 * still dies by that signal with the usual exit status.
 *
 * @param destination - The destination to flush.
 * @returns A function that removes the handlers.
 */
function flushOnTerminatingSignals(destination: LogDestination): () => void {
  const handlers = TERMINATING_SIGNALS.map((signal) => {
    const handler = (): void => {
      try {
        destination.flushSync();
      } catch {
        // Nothing to flush, or the fd is gone: the signal still proceeds.
      }
      process.removeListener(signal, handler);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) process.removeListener(signal, handler);
  };
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

/** Outcome of {@link startProjectFileLogger}. */
export type ProjectFileLoggerStart =
  | { status: 'started'; cleoDir: string }
  | { status: 'running' }
  | { status: 'no-project' }
  | { status: 'failed'; error: string };

/**
 * Start the file logger for the current project: the CLI startup path
 * (T14605). Resolves the project root and its `.cleo` directory, reads
 * `projectHash`, and calls {@link startFileLogger}. Outside a project it
 * starts nothing. Any other failure is written to stderr once, as one
 * `[cleo] File logger not started: …` line, and returned, so a broken path
 * or config cannot silently disable logging. Never throws.
 *
 * The modules it needs are imported lazily: they are already loaded on every
 * command path, and importing them statically would make every
 * `getLogger()` caller load them.
 *
 * @returns What happened.
 */
export async function startProjectFileLogger(): Promise<ProjectFileLoggerStart> {
  if (rootLogger) return { status: 'running' };
  try {
    const [
      { getProjectRoot, isMissingProjectError },
      { getCleoDirAbsolute },
      { getProjectInfoSync },
    ] = await Promise.all([
      import('./project-scope.js'),
      import('./paths.js'),
      import('./project-info.js'),
    ]);
    let projectRoot: string;
    try {
      projectRoot = getProjectRoot();
    } catch (error) {
      if (isMissingProjectError(error)) return { status: 'no-project' };
      throw error;
    }
    const cleoDir = getCleoDirAbsolute(projectRoot);
    if (!existsSync(cleoDir)) return { status: 'no-project' };
    startFileLogger(cleoDir, getProjectInfoSync(projectRoot)?.projectHash);
    return { status: 'started', cleoDir };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cleo] File logger not started: ${message}\n`);
    return { status: 'failed', error: message };
  }
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
 * Buffered lines are written synchronously before this returns its
 * Promise, which resolves once the log file is closed. Callers that cannot
 * await may fire-and-forget: the flush has already happened, and pino's exit
 * hook flushes any line logged later on a normal exit.
 */
export function closeLogger(): Promise<void> {
  return new Promise<void>((resolve) => {
    const destination = currentDestination;
    removeSignalFlush?.();
    removeSignalFlush = null;
    rootLogger = null;
    currentLogDir = null;
    currentDestination = null;
    if (!destination) {
      resolve();
      return;
    }
    // Write every buffered line synchronously, then close the fd once any
    // in-flight async write lands ('close'). The unref'd fallback keeps a
    // missing 'close' from stalling shutdown.
    destination.once('close', () => resolve());
    setTimeout(resolve, 100).unref();
    try {
      destination.flushSync();
    } catch {
      // Nothing to flush, or the fd is already gone: closing still applies.
    }
    try {
      destination.end();
    } catch {
      resolve();
    }
  });
}
