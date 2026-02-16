/**
 * Audit log viewing core module.
 * @task T4538
 * @epic T4454
 */

import { readLogEntries } from '../../store/json.js';
import { getLogPath } from '../paths.js';

interface LogEntry {
  operation: string;
  taskId?: string;
  timestamp: string;
  [key: string]: unknown;
}

/** Get log entries with filtering. */
export async function getLogEntries(opts: {
  limit?: number;
  offset?: number;
  operation?: string;
  task?: string;
  since?: string;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const raw = await readLogEntries(getLogPath(opts.cwd));
  let entries = raw as LogEntry[];

  // Apply filters
  if (opts.operation) {
    entries = entries.filter(e => e.operation === opts.operation);
  }
  if (opts.task) {
    entries = entries.filter(e => e.taskId === opts.task);
  }
  if (opts.since) {
    entries = entries.filter(e => e.timestamp >= opts.since!);
  }

  // Sort by timestamp descending
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const total = entries.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 20;
  const paginated = entries.slice(offset, offset + limit);

  return {
    entries: paginated,
    pagination: { total, offset, limit, hasMore: offset + limit < total },
  };
}
