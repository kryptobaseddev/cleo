/**
 * The pure half of the uniform timestamp format (journal spec §1.8, R3, M4;
 * T12986): the strict canonicalizer and the captured timestamp columns. It
 * has no runtime imports, so the Gate B fingerprint script
 * (`scripts/fingerprint-store.mjs --canon-timestamps`) loads this file
 * directly and applies the very function the sealer applies on the wire
 * (T12987). {@link module:store/sync/timestamps} re-exports it.
 *
 * @module store/sync/timestamp-canon
 * @task T12986
 * @task T12987
 */

import type { TableScope } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// The canonicalizer
// ---------------------------------------------------------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const SQLITE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The canonical wire form of a stored timestamp,
 * `YYYY-MM-DDTHH:MM:SS.sssZ`, or `null` when the value is refused.
 *
 * Fractions beyond milliseconds are truncated, never rounded, so a carry can
 * never change the second. Pure: two replicas always agree.
 *
 * @example
 * ```ts
 * canonicalStoreTimestamp('2026-09-14 19:56:01');          // '2026-09-14T19:56:01.000Z'
 * canonicalStoreTimestamp('2026-09-14T21:56:01.5+02:00');  // '2026-09-14T19:56:01.500Z'
 * canonicalStoreTimestamp('2026-09-14T19:56:01');          // null (zoneless)
 * canonicalStoreTimestamp('2026-09-14');                   // null (date only)
 * ```
 */
export function canonicalStoreTimestamp(value: string): string | null {
  const m = ISO.exec(value) ?? SQLITE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = Number((m[7] ?? '').slice(0, 3).padEnd(3, '0'));
  let offsetMin = 0;
  const zone = m[8];
  if (zone !== undefined && zone !== 'Z') {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMin = (zone.startsWith('-') ? -1 : 1) * (oh * 60 + om);
  }
  // setUTCFullYear keeps years below 100 as written (Date.UTC would add 1900).
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(h, mi, s, ms);
  const at = t.getTime() - offsetMin * 60_000;
  const out = new Date(at);
  const year = out.getUTCFullYear();
  if (year < 0 || year > 9999) return null;
  return out.toISOString();
}

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

/**
 * Captured timestamp columns per sync-set table. The claim-lease columns
 * (`claimed_at`, `lease_expires_at`) are local-only and are not captured, so
 * they are not here. A test pins this map against every captured `*_at`
 * column of the sync set.
 */
export const SYNC_TIMESTAMP_COLUMNS: Readonly<
  Record<TableScope, Readonly<Record<string, readonly string[]>>>
> = {
  project: {
    tasks_tasks: ['created_at', 'updated_at', 'completed_at', 'cancelled_at', 'archived_at'],
    tasks_sessions: ['started_at', 'ended_at', 'task_started_at', 'handoff_consumed_at'],
    tasks_task_acceptance_criteria: ['created_at', 'updated_at'],
    tasks_task_acceptance_criteria_history: ['recorded_at'],
    tasks_evidence_ac_bindings: ['created_at'],
    tasks_display_id_aliases: ['created_at'],
    tasks_uid_aliases: ['created_at'],
  },
  global: {},
};

/**
 * Columns the one-time rewrite never touches: `tasks_tasks.updated_at` is the
 * #1698 CAS token, and rewriting it would invalidate a caller's `--if-match`.
 */
export const CANON_EXCLUDED_COLUMNS: Readonly<
  Record<TableScope, Readonly<Record<string, readonly string[]>>>
> = {
  project: { tasks_tasks: ['updated_at'] },
  global: {},
};

/** The captured timestamp columns of `table` (empty when it has none). */
export function timestampColumns(scope: TableScope, table: string): ReadonlySet<string> {
  const cols = SYNC_TIMESTAMP_COLUMNS[scope];
  return new Set(Object.hasOwn(cols, table) ? cols[table] : []);
}
