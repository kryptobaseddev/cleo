/**
 * Log file discovery and reading.
 *
 * Discovers pino log files in .cleo/logs/ directories,
 * reads them synchronously or via async streaming.
 *
 * @task T5187
 * @epic T5186
 */

import { readdirSync, statSync, existsSync, readFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getLogDir } from '../logger.js';
import { getCleoHome, getCleoDirAbsolute } from '../paths.js';
import type { LogFileInfo, LogDiscoveryOptions } from './types.js';

/** Regex for standard CLEO pino log files: cleo.YYYY-MM-DD.N.log */
const CLEO_LOG_PATTERN = /^cleo\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log$/;

/** Regex for migration log files: migration-*.jsonl */
const MIGRATION_LOG_PATTERN = /^migration-.*\.jsonl$/;

/**
 * Get the project log directory path.
 * Uses getLogDir() from logger if available, falls back to config-based resolution.
 */
export function getProjectLogDir(cwd?: string): string | null {
  // Try the runtime-initialized log dir first
  const runtimeDir = getLogDir();
  if (runtimeDir) return runtimeDir;

  // Fall back to standard path
  const cleoDir = getCleoDirAbsolute(cwd);
  const logsDir = join(cleoDir, 'logs');
  return existsSync(logsDir) ? logsDir : null;
}

/**
 * Get the global log directory path (~/.cleo/logs/).
 */
export function getGlobalLogDir(): string {
  return join(getCleoHome(), 'logs');
}

/**
 * Scan a directory for log files and build LogFileInfo entries.
 */
function scanLogDir(dir: string, includeMigration: boolean): LogFileInfo[] {
  if (!existsSync(dir)) return [];

  let fileNames: string[];
  try {
    fileNames = readdirSync(dir);
  } catch {
    return [];
  }

  const files: LogFileInfo[] = [];
  for (const name of fileNames) {
    const cleoMatch = name.match(CLEO_LOG_PATTERN);
    const isMigration = MIGRATION_LOG_PATTERN.test(name);

    if (!cleoMatch && (!isMigration || !includeMigration)) continue;

    const filePath = join(dir, name);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }

    files.push({
      path: filePath,
      name,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      date: cleoMatch ? cleoMatch[1]! : null,
      isActive: false, // set below
    });
  }

  return files;
}

/**
 * Discover all log files in the specified scope.
 * Returns file info sorted by date (newest first).
 */
export function discoverLogFiles(
  options?: LogDiscoveryOptions,
  cwd?: string,
): LogFileInfo[] {
  const scope = options?.scope ?? 'project';
  const includeMigration = options?.includeMigration ?? false;
  const sinceDate = options?.since;

  let files: LogFileInfo[] = [];

  if (scope === 'project' || scope === 'both') {
    const dir = getProjectLogDir(cwd);
    if (dir) files.push(...scanLogDir(dir, includeMigration));
  }

  if (scope === 'global' || scope === 'both') {
    const dir = getGlobalLogDir();
    files.push(...scanLogDir(dir, includeMigration));
  }

  // Filter by modification date
  if (sinceDate) {
    files = files.filter(f => f.mtime >= sinceDate);
  }

  // Sort newest first by mtime
  files.sort((a, b) => b.mtime.localeCompare(a.mtime));

  // Mark the newest file as active
  if (files.length > 0) {
    files[0]!.isActive = true;
  }

  return files;
}

/**
 * Read all lines from a log file synchronously.
 * Returns raw JSON strings (one per line). Suitable for small-to-medium files.
 */
export function readLogFileLines(filePath: string): string[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!content.trim()) return [];
  return content.split('\n').filter(line => line.trim() !== '');
}

/**
 * Create an async iterable over lines of a log file.
 * Suitable for large files -- does not load entire file into memory.
 */
export async function* streamLogFileLines(filePath: string): AsyncGenerator<string> {
  if (!existsSync(filePath)) return;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) yield line;
  }
}
