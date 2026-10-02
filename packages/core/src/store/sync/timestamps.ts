/**
 * Uniform timestamp format (journal spec §1.8, R3, M4; T12986, S3c).
 *
 * - {@link canonicalStoreTimestamp}: the strict, pure canonicalizer. Accepts
 *   ISO-8601 with `Z` or an explicit `±hh:mm` offset (any fractional
 *   precision) and SQLite's `YYYY-MM-DD HH:MM:SS[.fff]` UTC form; refuses
 *   zoneless `T` forms, date-only values and anything else.
 * - {@link SYNC_TIMESTAMP_COLUMNS}: the captured timestamp columns per table.
 * - {@link canonicalizeStoreTimestamps}: the one-time rewrite under the
 *   `timestamp_canon_v1` marker, run before the capture triggers go in. It
 *   never touches `tasks_tasks.updated_at` (the #1698 CAS token) and is
 *   refused once `row_identity_synced` exists.
 *
 * After genesis the sealer canonicalizes on the wire only; local rows are
 * never rewritten there.
 *
 * @module store/sync/timestamps
 * @task T12986
 * @epic T12323
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { ROW_IDENTITY_META_TABLE, ROW_IDENTITY_SYNCED_KEY } from '../row-identity.js';
import { withImmediateTransaction } from './clock-store.js';
import { hasTable } from './schema.js';
import { hasTriggerSuspendTable, withTriggersSuspended } from './trigger-classes.js';

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

// ---------------------------------------------------------------------------
// The one-time rewrite
// ---------------------------------------------------------------------------

/** Marker key in `tasks_row_identity_meta` once the rewrite has run. */
export const TIMESTAMP_CANON_MARKER = 'timestamp_canon_v1';

/** Per `table.column`, how many rows. */
export type ColumnCounts = Readonly<Record<string, number>>;

/** What {@link canonicalizeStoreTimestamps} did. */
export type TimestampCanonReport =
  | {
      readonly status: 'done';
      /** Rows rewritten to the canonical form. */
      readonly rewritten: ColumnCounts;
      /** Rows left as they are: refused by the canonicalizer (`timestamp_ambiguous`). */
      readonly ambiguous: ColumnCounts;
    }
  | { readonly status: 'already' }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'refused'; readonly reason: string };

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

function metaValue(db: DatabaseSync, key: string): string | undefined {
  const row = db
    .prepare(`SELECT value FROM ${q(ROW_IDENTITY_META_TABLE)} WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const info = db.prepare(`PRAGMA main.table_info(${q(table)})`).all() as Array<{ name: string }>;
  return new Set(info.map((c) => c.name));
}

/** Distinct text values of one column, read once. */
function distinctText(db: DatabaseSync, table: string, column: string): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT ${q(column)} AS v FROM ${q(table)} WHERE typeof(${q(column)}) = 'text'`,
      )
      .all() as Array<{ v: string }>
  ).map((r) => r.v);
}

function countValue(db: DatabaseSync, table: string, column: string, value: string): number {
  return (
    db.prepare(`SELECT count(*) AS n FROM ${q(table)} WHERE ${q(column)} = ?`).get(value) as {
      n: number;
    }
  ).n;
}

/**
 * Rows whose timestamp the canonicalizer refuses, per `table.column`: the
 * doctor's `timestamp_ambiguous` finding. Read-only.
 */
export function ambiguousTimestamps(db: DatabaseSync, scope: TableScope): ColumnCounts {
  const out: Record<string, number> = {};
  for (const [table, cols] of Object.entries(SYNC_TIMESTAMP_COLUMNS[scope])) {
    if (!hasTable(db, table)) continue;
    const present = columnsOf(db, table);
    for (const col of cols) {
      if (!present.has(col)) continue;
      let n = 0;
      for (const v of distinctText(db, table, col)) {
        if (canonicalStoreTimestamp(v) === null) n += countValue(db, table, col, v);
      }
      if (n > 0) out[`${table}.${col}`] = n;
    }
  }
  return out;
}

/**
 * The one-time rewrite (§1.8): every accepted legacy value in
 * {@link SYNC_TIMESTAMP_COLUMNS}, except {@link CANON_EXCLUDED_COLUMNS},
 * becomes canonical. Refused values stay as they are and are counted.
 *
 * - Runs once per store: the {@link TIMESTAMP_CANON_MARKER} row records it.
 * - Refused once `row_identity_synced` exists: values have left the device.
 * - Runs in one `BEGIN IMMEDIATE` (or the caller's transaction) with the
 *   capture and side-effect triggers suspended, so nothing is captured and
 *   no trigger reacts. Guards stay on; canonical values satisfy them.
 * - Deterministic: each distinct value maps through the pure canonicalizer,
 *   so two copies of a store agree.
 */
export function canonicalizeStoreTimestamps(
  db: DatabaseSync,
  scope: TableScope,
): TimestampCanonReport {
  const tables = Object.entries(SYNC_TIMESTAMP_COLUMNS[scope]);
  if (tables.length === 0) return { status: 'skipped', reason: `no timestamp columns in ${scope}` };
  if (!hasTable(db, ROW_IDENTITY_META_TABLE)) {
    return { status: 'skipped', reason: `${ROW_IDENTITY_META_TABLE} is absent` };
  }
  // Without the C2 flag table no trigger can be suspended, and a capture
  // trigger (which reads it) cannot exist either.
  if (!hasTriggerSuspendTable(db)) {
    return { status: 'skipped', reason: 'cleo_trigger_suspend is absent' };
  }
  const run = (): TimestampCanonReport => {
    if (metaValue(db, TIMESTAMP_CANON_MARKER) !== undefined) return { status: 'already' };
    if (metaValue(db, ROW_IDENTITY_SYNCED_KEY) !== undefined) {
      return {
        status: 'refused',
        reason: `${ROW_IDENTITY_SYNCED_KEY} exists: timestamps are canonical on the wire only`,
      };
    }
    const rewritten: Record<string, number> = {};
    const ambiguous: Record<string, number> = {};
    withTriggersSuspended(db, ['capture', 'side-effect'], 'forward', () => {
      for (const [table, cols] of tables) {
        if (!hasTable(db, table)) continue;
        const present = columnsOf(db, table);
        const excluded = new Set(CANON_EXCLUDED_COLUMNS[scope][table] ?? []);
        for (const col of cols) {
          if (excluded.has(col) || !present.has(col)) continue;
          const update = db.prepare(`UPDATE ${q(table)} SET ${q(col)} = ? WHERE ${q(col)} = ?`);
          for (const raw of distinctText(db, table, col)) {
            const canon = canonicalStoreTimestamp(raw);
            const key = `${table}.${col}`;
            if (canon === null) {
              ambiguous[key] = (ambiguous[key] ?? 0) + countValue(db, table, col, raw);
            } else if (canon !== raw) {
              const n = Number(update.run(canon, raw).changes);
              rewritten[key] = (rewritten[key] ?? 0) + n;
            }
          }
        }
      }
    });
    db.prepare(`INSERT INTO ${q(ROW_IDENTITY_META_TABLE)} (key, value) VALUES (?, ?)`).run(
      TIMESTAMP_CANON_MARKER,
      'done',
    );
    return { status: 'done', rewritten, ambiguous };
  };
  return db.isTransaction ? run() : withImmediateTransaction(db, run);
}
