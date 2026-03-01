/**
 * CLEO Observability module -- log reading, parsing, filtering.
 *
 * Public API for Phase 1 of the Observability epic (T5186).
 * Read-only: discovers and reads pino JSONL log files from .cleo/logs/.
 *
 * @task T5187
 * @epic T5186
 */

export type {
  PinoLevel,
  PinoLogEntry,
  LogFileInfo,
  LogFilter,
  LogQueryResult,
  LogDiscoveryOptions,
  LogSummary,
} from './types.js';

export { PINO_LEVEL_VALUES } from './types.js';

export {
  discoverLogFiles,
  readLogFileLines,
  streamLogFileLines,
  getProjectLogDir,
  getGlobalLogDir,
} from './log-reader.js';

export { parseLogLine, parseLogLines, isValidLevel } from './log-parser.js';

export { filterEntries, matchesFilter, paginate, compareLevels } from './log-filter.js';

import type {
  PinoLogEntry,
  LogFilter,
  LogQueryResult,
  LogDiscoveryOptions,
  LogSummary,
} from './types.js';
import { discoverLogFiles, readLogFileLines } from './log-reader.js';
import { parseLogLine, parseLogLines } from './log-parser.js';
import { filterEntries, matchesFilter, paginate } from './log-filter.js';
import { streamLogFileLines } from './log-reader.js';

/**
 * High-level query: discover files, parse, filter, paginate.
 * Convenience wrapper combining all three layers.
 */
export function queryLogs(
  filter?: LogFilter,
  options?: LogDiscoveryOptions,
  cwd?: string,
): LogQueryResult {
  const files = discoverLogFiles(options, cwd);
  const filesPaths = files.map(f => f.path);

  let totalScanned = 0;
  let allEntries: PinoLogEntry[] = [];

  for (const file of files) {
    const lines = readLogFileLines(file.path);
    totalScanned += lines.length;
    const parsed = parseLogLines(lines);
    allEntries.push(...parsed);
  }

  // Apply filters (excluding limit/offset which are pagination)
  const matched = filter ? filterEntries(allEntries, filter) : allEntries;
  const totalMatched = matched.length;

  // Apply pagination
  const entries = paginate(matched, filter?.limit, filter?.offset);

  return {
    entries,
    totalScanned,
    totalMatched,
    files: filesPaths,
  };
}

/**
 * Stream-based query for large log datasets.
 * Yields matching entries one at a time.
 * Respects limit. Does not support offset (streaming is forward-only).
 */
export async function* streamLogs(
  filter?: LogFilter,
  options?: LogDiscoveryOptions,
  cwd?: string,
): AsyncGenerator<PinoLogEntry> {
  const files = discoverLogFiles(options, cwd);
  let yielded = 0;
  const limit = filter?.limit;

  for (const file of files) {
    if (limit !== undefined && yielded >= limit) break;

    for await (const line of streamLogFileLines(file.path)) {
      const entry = parseLogLine(line);
      if (!entry) continue;

      if (filter && !matchesFilter(entry, filter)) continue;

      yield entry;
      yielded++;
      if (limit !== undefined && yielded >= limit) return;
    }
  }
}

/**
 * Get a summary of log activity (counts by level, date range, subsystems).
 * Reads all discovered files but does not return individual entries.
 */
export function getLogSummary(
  options?: LogDiscoveryOptions,
  cwd?: string,
): LogSummary {
  const files = discoverLogFiles(options, cwd);
  const byLevel: Record<string, number> = {};
  const bySubsystem: Record<string, number> = {};
  let totalEntries = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const file of files) {
    const lines = readLogFileLines(file.path);
    const entries = parseLogLines(lines);
    totalEntries += entries.length;

    for (const entry of entries) {
      byLevel[entry.level] = (byLevel[entry.level] ?? 0) + 1;

      if (entry.subsystem) {
        bySubsystem[entry.subsystem] = (bySubsystem[entry.subsystem] ?? 0) + 1;
      }

      if (earliest === null || entry.time < earliest) earliest = entry.time;
      if (latest === null || entry.time > latest) latest = entry.time;
    }
  }

  return {
    totalEntries,
    byLevel,
    bySubsystem,
    dateRange: earliest && latest ? { earliest, latest } : null,
    files,
  };
}
