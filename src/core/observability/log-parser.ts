/**
 * Pino JSONL log line parser.
 *
 * Parses individual JSONL lines into typed PinoLogEntry objects.
 * Handles malformed lines gracefully (returns null).
 * Separates known fields from extra fields.
 *
 * @task T5187
 * @epic T5186
 */

import type { PinoLogEntry, PinoLevel } from './types.js';
import { PINO_LEVEL_VALUES } from './types.js';

const VALID_LEVELS = new Set<string>(Object.keys(PINO_LEVEL_VALUES));

/** Known fields that are extracted into typed PinoLogEntry properties. */
const KNOWN_FIELDS = new Set([
  'level', 'time', 'pid', 'hostname', 'msg', 'subsystem', 'code', 'exitCode',
]);

/**
 * Validate that a string is a valid PinoLevel.
 */
export function isValidLevel(level: string): level is PinoLevel {
  return VALID_LEVELS.has(level);
}

/**
 * Parse a single JSONL line into a PinoLogEntry.
 * Returns null for empty lines, non-JSON, or lines missing required fields.
 */
export function parseLogLine(line: string): PinoLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;

  const level = raw.level;
  if (typeof level !== 'string' || !isValidLevel(level)) return null;

  const time = raw.time;
  if (typeof time !== 'string') return null;

  const pid = raw.pid;
  if (typeof pid !== 'number') return null;

  const hostname = raw.hostname;
  if (typeof hostname !== 'string') return null;

  const msg = raw.msg;
  if (typeof msg !== 'string') return null;

  // Collect extra fields
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      extra[key] = raw[key];
    }
  }

  const entry: PinoLogEntry = {
    level,
    time,
    pid,
    hostname,
    msg,
    extra,
  };

  // Optional typed fields
  if (typeof raw.subsystem === 'string') entry.subsystem = raw.subsystem;
  if (typeof raw.code === 'string') entry.code = raw.code;
  if (typeof raw.exitCode === 'number') entry.exitCode = raw.exitCode;

  return entry;
}

/**
 * Parse multiple JSONL lines into PinoLogEntry array.
 * Skips malformed lines.
 */
export function parseLogLines(lines: string[]): PinoLogEntry[] {
  const entries: PinoLogEntry[] = [];
  for (const line of lines) {
    const entry = parseLogLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}
