/**
 * Log entry filtering and pagination.
 *
 * Applies filter criteria to parsed PinoLogEntry arrays.
 * All filter fields use AND logic when multiple are specified.
 *
 * @task T5187
 * @epic T5186
 */

import type { PinoLogEntry, PinoLevel, LogFilter } from './types.js';
import { PINO_LEVEL_VALUES } from './types.js';

/**
 * Compare two pino levels numerically.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareLevels(a: PinoLevel, b: PinoLevel): number {
  return PINO_LEVEL_VALUES[a] - PINO_LEVEL_VALUES[b];
}

/**
 * Check if a single entry matches the filter criteria.
 * All specified fields must match (AND logic).
 */
export function matchesFilter(entry: PinoLogEntry, filter: LogFilter): boolean {
  if (filter.level !== undefined && entry.level !== filter.level) return false;

  if (filter.minLevel !== undefined && compareLevels(entry.level, filter.minLevel) < 0) return false;

  if (filter.since !== undefined && entry.time < filter.since) return false;

  if (filter.until !== undefined && entry.time > filter.until) return false;

  if (filter.subsystem !== undefined && entry.subsystem !== filter.subsystem) return false;

  if (filter.code !== undefined && entry.code !== filter.code) return false;

  if (filter.exitCode !== undefined && entry.exitCode !== filter.exitCode) return false;

  if (filter.pid !== undefined && entry.pid !== filter.pid) return false;

  if (filter.msgContains !== undefined) {
    if (!entry.msg.toLowerCase().includes(filter.msgContains.toLowerCase())) return false;
  }

  return true;
}

/**
 * Filter an array of parsed log entries against criteria.
 * Returns entries matching ALL specified criteria (AND logic).
 * Does not apply pagination (limit/offset) -- use paginate() for that.
 */
export function filterEntries(entries: PinoLogEntry[], filter: LogFilter): PinoLogEntry[] {
  return entries.filter(entry => matchesFilter(entry, filter));
}

/**
 * Apply pagination (limit/offset) to a result set.
 */
export function paginate(
  entries: PinoLogEntry[],
  limit?: number,
  offset?: number,
): PinoLogEntry[] {
  const start = offset ?? 0;
  if (limit !== undefined) {
    return entries.slice(start, start + limit);
  }
  return start > 0 ? entries.slice(start) : entries;
}
