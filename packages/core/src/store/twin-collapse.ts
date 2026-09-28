/**
 * Twin collapses (T12535): keep a prefixed twin in step with its BARE legacy
 * table, which stays authoritative while an older CLEO build still writes it.
 *
 * ## Why
 *
 * The project `cleo.db` carries legacy bare tables beside their prefixed (E6)
 * twins. For `schema_meta` and `sticky_tags` the runtime wrote the bare table
 * while the twin held a frozen exodus copy. This build reads and writes only
 * the twin. The release before it (2026.9.20) is still installed on machines
 * that share project stores, and it keeps writing the bare tables (its drizzle
 * `schemaMeta` / `stickyTags` point at them). So the collapse is not one-shot:
 *
 * - **Initial collapse** (no marker yet): snapshot the store, then fold the
 *   bare table into the twin under the bare-authoritative rules below.
 * - **Incremental re-merge** (marker present, on EVERY open): carry over only
 *   what the bare table changed since the last merge, under the same rules.
 *   No snapshot. An unchanged bare table costs one read of it and no write:
 *   its rows are compared with the state stored in the marker.
 *
 * A later release removes the incremental re-merge once no supported build
 * writes the bare tables; slice 3 then drops them after a backup.
 *
 * ## Contract (every pair)
 *
 * 1. **State and provenance.** The marker row `twin_collapse:<bare table>` in
 *    the twin's key/value table holds when the collapse first ran, its
 *    snapshot, and `seen`: the bare table as of the last merge (per key a
 *    sha256 of the value for `schema_meta`; per sticky id its tag set for
 *    `sticky_tags`). Only differences between the bare table and `seen` are
 *    carried, so a twin row this build wrote is never overwritten or deleted
 *    unless the older build changed that same key or tag afterwards.
 * 2. **Snapshot first** (initial collapse only, and only when the merge
 *    changes the twin). The free space is checked first. Then one
 *    `VACUUM INTO` covers every pair collapsing in this open, registered as a
 *    `migration` backup (`cleo backup list`, rotation). See
 *    `pre-repair-snapshot.ts`.
 * 3. **Atomic.** Each pair merges, verifies and writes its marker in one
 *    `BEGIN IMMEDIATE` transaction. The marker is re-read under the write
 *    lock, so two processes never both run the initial collapse. Any failure
 *    rolls back (both tables byte-identical), is recorded best-effort as
 *    `twin_collapse_failed:<table>` for `cleo doctor twin-collapse`, and is
 *    raised as `E_TWIN_COLLAPSE_FAILED` (table, cause, snapshot path, space
 *    needed). The next open, or `cleo doctor twin-collapse --retry`, runs it
 *    again; nothing partial was ever committed.
 * 4. **Verified.** Before the marker is written, every row the merge decided
 *    is re-read from the twin and compared; a mismatch rolls back.
 * 5. **The bare table is never written.**
 *
 * ## `schema_meta` → `tasks_schema_meta`
 *
 * Two rules: a monotonic counter or generation takes MAX(bare, twin); every
 * other key takes the bare value ({@link mergeSchemaMetaValue}).
 *
 * | Key | Rule |
 * |---|---|
 * | `task_id_sequence` (`{counter,lastId,checksum}`, written by `sequence/index.ts`) | the larger `counter` wins whole; a tie keeps the twin. Never summed, never reset, never deleted |
 * | `sqlite_snapshot_gate` (`{generation,prefixes}`, `snapshot-gate.ts`) | the larger `generation` wins whole; a tie keeps the bare value; never deleted |
 * | `file_meta` (`FileMeta`; `generation` is bumped on session start/end/resume in `session/engine-ops.ts`) | the larger `generation` wins whole; a tie keeps the bare value |
 * | `backfill:*` (the two `t877` migration guard keys) | not carried: the lineage re-inserts them into every bare table and nothing reads them |
 * | `twin_collapse*` | not carried: collapse state lives only in the twin |
 * | every other key: `schemaVersion`, `version`, `focus_state`, `focus_state:<session>`, `project_meta`, `project`, `parallel_state`, `activeSession`, `reconcile.<task>.release`, and any unknown key | the bare value wins |
 *
 * Initial collapse, when the bare table holds at least one carried key: a key
 * only the twin holds is a frozen copy and is DROPPED (listed in the receipt,
 * the marker and the log). Exceptions: `task_id_sequence` and
 * `sqlite_snapshot_gate`, since dropping them could move a counter backwards,
 * and the collapse keys. `file_meta` is dropped too. It is a whole record
 * (schema version, checksum, sessions), and a frozen one would feed
 * `getSchemaVersion`. When the bare table holds no carried key (a fresh
 * lineage, e.g. after exodus landed legacy rows in the twin), nothing is
 * dropped.
 *
 * Incremental re-merge: a key whose bare value differs from `seen` is carried
 * under the rules above, even over a value this build wrote since: the bare
 * table is authoritative, and counters still only move up. A key the bare
 * table no longer has but `seen` had is deleted from the twin, except the
 * two counter keys. A key the bare table never had is never touched.
 *
 * ## `sticky_tags` → `brain_sticky_tags`
 *
 * Rows are `(sticky_id, tag)`, both the primary key, so a collision is two
 * identical rows and one is kept.
 *
 * - Initial collapse, when the bare table has rows: the twin is made equal to
 *   the bare set (missing rows inserted, twin-only rows dropped and listed).
 *   A bare tag whose note no longer exists is not carried; it is counted as
 *   `skipped` and stays in the bare table.
 * - Incremental re-merge, per sticky id: `bare − seen` is inserted and
 *   `seen − bare` is deleted, so tag removals by the older build propagate.
 *   A tag this build added or removed is left alone, because only the delta
 *   against `seen` is applied.
 *
 * A marker written by the first (one-shot) version of this module has no
 * `seen`. It is read as `seen = {}`: every bare row is carried again under
 * the rules, and nothing is deleted.
 *
 * ## Gate 28
 *
 * This module is a sanctioned writer (`scripts/lint-no-raw-table-writes.mjs`
 * SANCTIONED): it runs on the chokepoint handle inside the domain bind, and
 * the accessors import the modules that call it.
 *
 * @module
 * @task T12535
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';
import { planMigrationSnapshot, writeMigrationSnapshot } from './pre-repair-snapshot.js';
import { SNAPSHOT_GATE_META_KEY } from './snapshot-gate.js';

const log = getLogger('twin-collapse');

/** Prefix of the marker key holding a pair's collapse state. */
export const TWIN_COLLAPSE_MARKER_PREFIX = 'twin_collapse:';

/** Prefix of the key recording a pair's last failed collapse. */
export const TWIN_COLLAPSE_FAILURE_PREFIX = 'twin_collapse_failed:';

/** `schema_meta` keys that take MAX(bare, twin) over a numeric field. */
export const SCHEMA_META_MAX_KEYS: Readonly<
  Record<string, { readonly field: string; readonly tie: 'bare' | 'twin' }>
> = {
  task_id_sequence: { field: 'counter', tie: 'twin' },
  [SNAPSHOT_GATE_META_KEY]: { field: 'generation', tie: 'bare' },
  file_meta: { field: 'generation', tie: 'bare' },
};

/** `schema_meta` keys that are never deleted from the twin (a counter never moves back). */
export const SCHEMA_META_NEVER_DELETED: ReadonlySet<string> = new Set([
  'task_id_sequence',
  SNAPSHOT_GATE_META_KEY,
]);

/** What one call did to one pair. */
export interface TwinCollapseReceipt {
  /** The bare legacy table. */
  readonly table: string;
  /** The prefixed twin. */
  readonly twin: string;
  /**
   * `initial`: the first collapse ran. `incremental`: bare changes since the
   * last merge were carried. `unchanged`: the bare table matched `seen`.
   * `no-bare-table`: a table of the pair is missing.
   */
  readonly status: 'initial' | 'incremental' | 'unchanged' | 'no-bare-table';
  /** The initial collapse's snapshot, or `null`. */
  readonly snapshotPath: string | null;
  /** Rows added to the twin. */
  readonly inserted: number;
  /** Twin rows whose value was replaced. */
  readonly replaced: number;
  /** Twin rows deleted (bare deletions, and frozen rows dropped initially). */
  readonly deleted: number;
  /** Bare rows not carried by rule (dead keys, tags of deleted notes). */
  readonly skipped: number;
  /** Frozen twin rows the initial collapse dropped (keys, or `sticky_id\ttag`). */
  readonly dropped: readonly string[];
}

/** A bare table in `seen` form. */
type Seen = Readonly<Record<string, string | readonly string[]>>;

/** Stored collapse state (the marker row's value). */
interface CollapseState {
  readonly version: 2;
  readonly task: 'T12535';
  readonly collapsedAt: string;
  readonly lastMergedAt: string;
  readonly snapshot: string | null;
  /** Bare table as of the last merge; `null` for a one-shot (v1) marker. */
  readonly seen: Seen | null;
  readonly dropped: readonly string[];
}

/** Counts a merge returns. */
interface MergeCounts {
  inserted: number;
  replaced: number;
  deleted: number;
  skipped: number;
  dropped: string[];
}

/** One bare/twin pair. */
interface TwinPair {
  readonly table: string;
  readonly twin: string;
  /** Key/value table holding the marker and failure rows. */
  readonly kvTable: string;
  /** Every table the pair reads or writes. */
  readonly tables: readonly string[];
  /** The bare table now, in `seen` form. */
  seenOf(db: DatabaseSync): Seen;
  /** Whether the initial collapse would change the twin (read-only). */
  initialChangesTwin(db: DatabaseSync): boolean;
  /** Initial collapse; runs inside the transaction and verifies. */
  initial(db: DatabaseSync): MergeCounts;
  /** Incremental re-merge against `seen`; runs inside the transaction and verifies. */
  incremental(db: DatabaseSync, seen: Seen | null): MergeCounts;
}

const zero = (): MergeCounts => ({ inserted: 0, replaced: 0, deleted: 0, skipped: 0, dropped: [] });

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Canonical form (sorted keys) so equal states compare equal as strings. */
function canonical(value: Seen): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .map((k) => [k, value[k]]),
  );
}

function hasMainTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function readKv(db: DatabaseSync, kvTable: string, key: string): string | undefined {
  return (
    db.prepare(`SELECT value FROM main.${kvTable} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
  )?.value;
}

function writeKv(db: DatabaseSync, kvTable: string, key: string, value: string): void {
  db.prepare(
    `INSERT INTO main.${kvTable} (key, value) VALUES (?, ?) ` +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Parse a marker row; a one-shot (v1) marker yields `seen: null`. */
function readState(db: DatabaseSync, pair: TwinPair): CollapseState | undefined {
  const raw = readKv(db, pair.kvTable, `${TWIN_COLLAPSE_MARKER_PREFIX}${pair.table}`);
  if (raw === undefined) return undefined;
  let parsed: Partial<CollapseState> = {};
  try {
    parsed = JSON.parse(raw) as Partial<CollapseState>;
  } catch {
    parsed = {};
  }
  return {
    version: 2,
    task: 'T12535',
    collapsedAt: typeof parsed.collapsedAt === 'string' ? parsed.collapsedAt : '',
    lastMergedAt: typeof parsed.lastMergedAt === 'string' ? parsed.lastMergedAt : '',
    snapshot: typeof parsed.snapshot === 'string' ? parsed.snapshot : null,
    seen: parsed.version === 2 && parsed.seen ? parsed.seen : null,
    dropped: Array.isArray(parsed.dropped) ? parsed.dropped : [],
  };
}

/** Whether the bare table differs from the stored `seen` (or no usable state exists). */
function bareChanged(db: DatabaseSync, pair: TwinPair, state: CollapseState | undefined): boolean {
  return !state?.seen || canonical(state.seen) !== canonical(pair.seenOf(db));
}

// ── schema_meta ──────────────────────────────────────────────────────────────

/** Which side a merged `schema_meta` value comes from. */
export type SchemaMetaMergeSource = 'bare' | 'twin' | 'skip';

function numericField(value: string, field: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const n = (parsed as Record<string, unknown>)[field];
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a `schema_meta` key is carried at all. */
function carried(key: string): boolean {
  return !key.startsWith('backfill:') && !key.startsWith('twin_collapse');
}

/**
 * Decide which value a `schema_meta` key keeps in `tasks_schema_meta` (the
 * rule table is in the module comment).
 *
 * @param key - The key.
 * @param bare - Its value in the bare table.
 * @param twin - Its value in the twin, or `undefined` when absent.
 * @returns `bare` or `twin` for the value to keep, `skip` when not carried.
 * @task T12535
 */
export function mergeSchemaMetaValue(
  key: string,
  bare: string,
  twin: string | undefined,
): SchemaMetaMergeSource {
  if (!carried(key)) return 'skip';
  if (twin === undefined) return 'bare';
  const max = SCHEMA_META_MAX_KEYS[key];
  if (max === undefined) return 'bare';
  const b = numericField(bare, max.field);
  const t = numericField(twin, max.field);
  if (b === undefined && t === undefined) return 'bare';
  if (b === undefined) return 'twin';
  if (t === undefined) return 'bare';
  if (b === t) return max.tie;
  return b > t ? 'bare' : 'twin';
}

function kvRows(db: DatabaseSync, table: string): Map<string, string> {
  const rows = db.prepare(`SELECT key, value FROM main.${table}`).all() as Array<{
    key: string;
    value: string;
  }>;
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Carried bare `schema_meta` rows. */
function bareSchemaMeta(db: DatabaseSync): Map<string, string> {
  const all = kvRows(db, 'schema_meta');
  for (const key of [...all.keys()]) if (!carried(key)) all.delete(key);
  return all;
}

/** Twin-only keys the initial collapse drops. */
function frozenTwinKeys(db: DatabaseSync, bare: ReadonlyMap<string, string>): string[] {
  return [...kvRows(db, 'tasks_schema_meta').keys()]
    .filter((k) => carried(k) && !bare.has(k) && !SCHEMA_META_NEVER_DELETED.has(k))
    .sort();
}

/**
 * Carry the given bare keys into the twin by rule, delete the given twin
 * keys, then verify both.
 */
function applySchemaMeta(
  db: DatabaseSync,
  bare: ReadonlyMap<string, string>,
  carry: readonly string[],
  remove: readonly string[],
  counts: MergeCounts,
): void {
  const twin = kvRows(db, 'tasks_schema_meta');
  const expected = new Map<string, string | undefined>();
  for (const key of carry) {
    const value = bare.get(key) as string;
    const current = twin.get(key);
    const want = mergeSchemaMetaValue(key, value, current) === 'bare' ? value : current;
    expected.set(key, want);
    if (want === current) continue;
    writeKv(db, 'tasks_schema_meta', key, value);
    if (current === undefined) counts.inserted++;
    else counts.replaced++;
  }
  const del = db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?');
  for (const key of remove) {
    counts.deleted += Number(del.run(key).changes);
    expected.set(key, undefined);
  }
  for (const [key, want] of expected) {
    if (readKv(db, 'tasks_schema_meta', key) !== want)
      throw new Error(`schema_meta collapse did not verify for key ${JSON.stringify(key)}`);
  }
}

const SCHEMA_META: TwinPair = {
  table: 'schema_meta',
  twin: 'tasks_schema_meta',
  kvTable: 'tasks_schema_meta',
  tables: ['schema_meta', 'tasks_schema_meta'],
  seenOf: (db) => Object.fromEntries([...bareSchemaMeta(db)].map(([k, v]) => [k, sha(v)])),
  initialChangesTwin(db) {
    const bare = bareSchemaMeta(db);
    if (bare.size === 0) return false;
    const twin = kvRows(db, 'tasks_schema_meta');
    for (const [key, value] of bare) {
      if (mergeSchemaMetaValue(key, value, twin.get(key)) === 'bare' && twin.get(key) !== value)
        return true;
    }
    return frozenTwinKeys(db, bare).length > 0;
  },
  initial(db) {
    const counts = zero();
    const bare = bareSchemaMeta(db);
    if (bare.size === 0) return counts;
    const dropped = frozenTwinKeys(db, bare);
    applySchemaMeta(db, bare, [...bare.keys()].sort(), dropped, counts);
    counts.dropped = dropped;
    return counts;
  },
  incremental(db, seen) {
    const counts = zero();
    const bare = bareSchemaMeta(db);
    const prev = seen ?? {};
    const changed = [...bare.keys()].filter((k) => prev[k] !== sha(bare.get(k) as string)).sort();
    const gone = Object.keys(prev)
      .filter((k) => !bare.has(k) && !SCHEMA_META_NEVER_DELETED.has(k))
      .sort();
    applySchemaMeta(db, bare, changed, gone, counts);
    return counts;
  },
};

// ── sticky_tags ──────────────────────────────────────────────────────────────

/** Bare tag sets by sticky id, tags sorted. */
function bareStickySets(db: DatabaseSync): Record<string, string[]> {
  const rows = db
    .prepare('SELECT sticky_id, tag FROM main.sticky_tags ORDER BY sticky_id, tag')
    .all() as Array<{ sticky_id: string; tag: string }>;
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const tags = out[r.sticky_id] ?? [];
    tags.push(r.tag);
    out[r.sticky_id] = tags;
  }
  return out;
}

/** Rows of a sticky junction as `sticky_id\ttag`. */
function stickyRows(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`SELECT sticky_id, tag FROM main.${table}`).all() as Array<{
    sticky_id: string;
    tag: string;
  }>;
  return new Set(rows.map((r) => `${r.sticky_id}\t${r.tag}`));
}

/** Insert and delete `sticky_id\ttag` rows in the twin, then verify. */
function applySticky(
  db: DatabaseSync,
  add: readonly string[],
  remove: readonly string[],
  counts: MergeCounts,
): void {
  const noteExists = db.prepare('SELECT 1 FROM main.brain_sticky_notes WHERE id = ?');
  const insert = db.prepare(
    'INSERT OR IGNORE INTO main.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)',
  );
  const del = db.prepare('DELETE FROM main.brain_sticky_tags WHERE sticky_id = ? AND tag = ?');
  const carriedRows: string[] = [];
  for (const row of add) {
    const [id, tag] = row.split('\t') as [string, string];
    if (noteExists.get(id) === undefined) {
      counts.skipped++;
      continue;
    }
    counts.inserted += Number(insert.run(id, tag).changes);
    carriedRows.push(row);
  }
  for (const row of remove) {
    const [id, tag] = row.split('\t') as [string, string];
    counts.deleted += Number(del.run(id, tag).changes);
  }
  const twin = stickyRows(db, 'brain_sticky_tags');
  const missing = carriedRows.filter((r) => !twin.has(r)).length;
  const lingering = remove.filter((r) => twin.has(r)).length;
  if (missing > 0 || lingering > 0)
    throw new Error(
      `sticky_tags collapse did not verify: ${missing} missing, ${lingering} not removed`,
    );
}

const STICKY_TAGS: TwinPair = {
  table: 'sticky_tags',
  twin: 'brain_sticky_tags',
  kvTable: 'brain_schema_meta',
  tables: ['sticky_tags', 'brain_sticky_tags', 'brain_sticky_notes', 'brain_schema_meta'],
  seenOf: (db) => bareStickySets(db),
  initialChangesTwin(db) {
    const bare = stickyRows(db, 'sticky_tags');
    if (bare.size === 0) return false;
    const twin = stickyRows(db, 'brain_sticky_tags');
    return [...bare].some((r) => !twin.has(r)) || [...twin].some((r) => !bare.has(r));
  },
  initial(db) {
    const counts = zero();
    const bare = stickyRows(db, 'sticky_tags');
    if (bare.size === 0) return counts;
    const twin = stickyRows(db, 'brain_sticky_tags');
    const dropped = [...twin].filter((r) => !bare.has(r)).sort();
    applySticky(db, [...bare].sort(), dropped, counts);
    counts.dropped = dropped;
    return counts;
  },
  incremental(db, seen) {
    const counts = zero();
    const bare = bareStickySets(db);
    const prev = (seen ?? {}) as Readonly<Record<string, readonly string[]>>;
    const add: string[] = [];
    const remove: string[] = [];
    for (const id of new Set([...Object.keys(bare), ...Object.keys(prev)])) {
      const now = new Set(bare[id] ?? []);
      const before = new Set(prev[id] ?? []);
      for (const tag of now) if (!before.has(tag)) add.push(`${id}\t${tag}`);
      for (const tag of before) if (!now.has(tag)) remove.push(`${id}\t${tag}`);
    }
    applySticky(db, add.sort(), remove.sort(), counts);
    return counts;
  },
};

/** The pairs this build collapses, in order. */
const PAIRS: readonly TwinPair[] = [SCHEMA_META, STICKY_TAGS];

// ── runner ───────────────────────────────────────────────────────────────────

/** Why a collapse failed, as carried by `E_TWIN_COLLAPSE_FAILED`. */
export interface TwinCollapseFailure {
  /** The bare tables whose collapse did not complete. */
  readonly tables: readonly string[];
  /** The underlying error message. */
  readonly cause: string;
  /** The snapshot this collapse needs (the planned path) or wrote, or `null`. */
  readonly snapshotPath: string | null;
  /** Free space the snapshot needs, in bytes (0 when none was needed). */
  readonly requiredBytes: number;
  /** Free space measured on the backup filesystem, or `null`. */
  readonly availableBytes: number | null;
  /** When it failed (ISO-8601). */
  readonly failedAt: string;
}

/** Build the `E_TWIN_COLLAPSE_FAILED` error. */
function collapseError(failure: TwinCollapseFailure, cause: unknown): CleoError {
  const where = failure.snapshotPath ? ` Snapshot: ${failure.snapshotPath}.` : '';
  const space =
    failure.requiredBytes > 0
      ? ` The snapshot needs ${failure.requiredBytes} bytes free` +
        (failure.availableBytes === null ? '.' : ` (${failure.availableBytes} free).`)
      : '';
  return new CleoError(
    ExitCode.TWIN_COLLAPSE_FAILED,
    `Twin collapse of ${failure.tables.join(', ')} failed and was rolled back (both tables ` +
      `unchanged): ${failure.cause}.${where}${space} Run 'cleo doctor twin-collapse'.`,
    {
      fix:
        "Run 'cleo doctor twin-collapse' for details, clear the cause (free the space, make " +
        ".cleo/backups/sqlite writable), then 'cleo doctor twin-collapse --retry'.",
      details: { field: 'twinCollapse', ...failure },
      cause,
    },
  );
}

/** Record a failure outside the rolled-back transaction; best effort. */
function recordFailure(
  db: DatabaseSync,
  pairs: readonly TwinPair[],
  failure: TwinCollapseFailure,
): void {
  for (const pair of pairs) {
    try {
      writeKv(
        db,
        pair.kvTable,
        `${TWIN_COLLAPSE_FAILURE_PREFIX}${pair.table}`,
        JSON.stringify(failure),
      );
    } catch {
      // The store itself may be the problem (disk full, read-only); the error
      // raised to the caller still carries everything.
    }
  }
}

function unchangedReceipt(pair: TwinPair, snapshotPath: string | null): TwinCollapseReceipt {
  return {
    table: pair.table,
    twin: pair.twin,
    status: 'unchanged',
    snapshotPath,
    inserted: 0,
    replaced: 0,
    deleted: 0,
    skipped: 0,
    dropped: [],
  };
}

/** Run one pair's merge in its own transaction. */
function collapsePair(
  db: DatabaseSync,
  pair: TwinPair,
  snapshotPath: string | null,
): TwinCollapseReceipt {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-read under the write lock: another process may have merged since.
    const state = readState(db, pair);
    if (!bareChanged(db, pair, state)) {
      db.exec('ROLLBACK');
      return unchangedReceipt(pair, state?.snapshot ?? null);
    }
    if (state === undefined && snapshotPath === null && pair.initialChangesTwin(db))
      throw new Error(`bare ${pair.table} changed after the snapshot decision; retry the open`);
    const counts = state === undefined ? pair.initial(db) : pair.incremental(db, state.seen);
    const now = new Date().toISOString();
    const next: CollapseState = {
      version: 2,
      task: 'T12535',
      collapsedAt: state?.collapsedAt || now,
      lastMergedAt: now,
      snapshot: state?.snapshot ?? snapshotPath,
      seen: pair.seenOf(db),
      dropped: state?.dropped ?? counts.dropped,
    };
    writeKv(db, pair.kvTable, `${TWIN_COLLAPSE_MARKER_PREFIX}${pair.table}`, JSON.stringify(next));
    db.prepare(`DELETE FROM main.${pair.kvTable} WHERE key = ?`).run(
      `${TWIN_COLLAPSE_FAILURE_PREFIX}${pair.table}`,
    );
    db.exec('COMMIT');
    const receipt: TwinCollapseReceipt = {
      table: pair.table,
      twin: pair.twin,
      status: state === undefined ? 'initial' : 'incremental',
      snapshotPath: next.snapshot,
      ...counts,
    };
    if (counts.inserted + counts.replaced + counts.deleted > 0)
      log.warn(receipt, `carried bare ${pair.table} into ${pair.twin} (${receipt.status}, T12535)`);
    return receipt;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Collapse every bare/twin pair present in the store: the initial collapse
 * (snapshot first) where no marker exists yet, an incremental re-merge of
 * bare changes where one does. Called from the tasks and brain domain binds,
 * and by `cleo doctor twin-collapse --retry`.
 *
 * @param nativeDb - The project `cleo.db` connection, outside any transaction.
 * @param dbPath - Its file path (locates `.cleo/backups/sqlite/`).
 * @returns One receipt per pair.
 * @throws {CleoError} `E_TWIN_COLLAPSE_FAILED` when a snapshot or merge fails;
 *   the failing pair is unchanged.
 * @task T12535
 */
export function collapseTwinTables(nativeDb: DatabaseSync, dbPath: string): TwinCollapseReceipt[] {
  const byTable = new Map<string, TwinCollapseReceipt>();
  const inOrder = (): TwinCollapseReceipt[] =>
    PAIRS.map((p) => byTable.get(p.table)).filter((r): r is TwinCollapseReceipt => r !== undefined);
  const present: TwinPair[] = [];
  for (const pair of PAIRS) {
    if (pair.tables.every((t) => hasMainTable(nativeDb, t))) present.push(pair);
    else byTable.set(pair.table, { ...unchangedReceipt(pair, null), status: 'no-bare-table' });
  }
  // Fast path: every pair collapsed and its bare table unchanged since.
  const pending: TwinPair[] = [];
  for (const pair of present) {
    const state = readState(nativeDb, pair);
    if (bareChanged(nativeDb, pair, state)) pending.push(pair);
    else byTable.set(pair.table, unchangedReceipt(pair, state?.snapshot ?? null));
  }
  if (pending.length === 0) return inOrder();
  if (nativeDb.isTransaction)
    throw new Error('twin collapse needs a connection outside a transaction');

  // One snapshot covers every pair whose INITIAL collapse changes its twin.
  const needSnapshot = pending.filter(
    (p) => readState(nativeDb, p) === undefined && p.initialChangesTwin(nativeDb),
  );
  let snapshotPath: string | null = null;
  if (needSnapshot.length > 0) {
    const plan = planMigrationSnapshot(nativeDb, dbPath);
    try {
      snapshotPath = writeMigrationSnapshot(
        nativeDb,
        plan,
        `T12535 twin collapse of ${needSnapshot.map((p) => p.table).join(', ')} (store before the merge)`,
      );
    } catch (error) {
      const failure: TwinCollapseFailure = {
        tables: needSnapshot.map((p) => p.table),
        cause: `snapshot not written: ${error instanceof Error ? error.message : String(error)}`,
        snapshotPath: plan.snapshotPath,
        requiredBytes: plan.requiredBytes,
        availableBytes: plan.availableBytes,
        failedAt: new Date().toISOString(),
      };
      recordFailure(nativeDb, needSnapshot, failure);
      log.error(failure, 'twin collapse aborted before any write: the snapshot failed (T12535)');
      throw collapseError(failure, error);
    }
  }

  for (const pair of pending) {
    try {
      byTable.set(pair.table, collapsePair(nativeDb, pair, snapshotPath));
    } catch (error) {
      const failure: TwinCollapseFailure = {
        tables: [pair.table],
        cause: error instanceof Error ? error.message : String(error),
        snapshotPath,
        requiredBytes: 0,
        availableBytes: null,
        failedAt: new Date().toISOString(),
      };
      recordFailure(nativeDb, [pair], failure);
      log.error(failure, `twin collapse of ${pair.table} failed and was rolled back (T12535)`);
      throw collapseError(failure, error);
    }
  }
  return inOrder();
}

/** Read-only status of one pair, for `cleo doctor`. */
export interface TwinCollapseStatus {
  /** The bare legacy table. */
  readonly table: string;
  /** The prefixed twin. */
  readonly twin: string;
  /**
   * `collapsed`: marker present, bare table unchanged since the last merge.
   * `bare-changed`: marker present, but the bare table changed since the last
   * merge (an older build writes it); the next open carries the change.
   * `pending`: no marker; the initial collapse runs at the next open.
   * `failed`: the last attempt failed (see `failure`). `no-bare-table`:
   * nothing to collapse.
   */
  readonly state: 'collapsed' | 'bare-changed' | 'pending' | 'failed' | 'no-bare-table';
  /** Whether a pending initial collapse would change the twin (and so needs a snapshot). */
  readonly wouldChangeTwin: boolean;
  /** The initial collapse's snapshot (or the planned one of a failed attempt). */
  readonly snapshotPath: string | null;
  /** When the initial collapse ran. */
  readonly collapsedAt: string | null;
  /** When the last merge ran. */
  readonly lastMergedAt: string | null;
  /** Keys (schema_meta) or sticky ids (sticky_tags) the bare table changed since the last merge. */
  readonly changedSinceMerge: number;
  /** The recorded failure, when the last attempt failed. */
  readonly failure: TwinCollapseFailure | null;
}

/**
 * Report every pair's collapse state without writing (for `cleo doctor`).
 *
 * @param db - A connection on the project `cleo.db`; read-only is enough.
 * @returns One status per pair.
 * @task T12535
 */
export function inspectTwinCollapse(db: DatabaseSync): TwinCollapseStatus[] {
  return PAIRS.map((pair): TwinCollapseStatus => {
    const empty = {
      table: pair.table,
      twin: pair.twin,
      wouldChangeTwin: false,
      snapshotPath: null,
      collapsedAt: null,
      lastMergedAt: null,
      changedSinceMerge: 0,
      failure: null,
    };
    if (!pair.tables.every((t) => hasMainTable(db, t))) return { ...empty, state: 'no-bare-table' };
    let failure: TwinCollapseFailure | null = null;
    try {
      const raw = readKv(db, pair.kvTable, `${TWIN_COLLAPSE_FAILURE_PREFIX}${pair.table}`);
      failure = raw === undefined ? null : (JSON.parse(raw) as TwinCollapseFailure);
    } catch {
      failure = null;
    }
    const state = readState(db, pair);
    const seen = pair.seenOf(db);
    const prev: Seen = state?.seen ?? {};
    let changed = 0;
    for (const k of new Set([...Object.keys(seen), ...Object.keys(prev)])) {
      if (JSON.stringify(seen[k]) !== JSON.stringify(prev[k])) changed++;
    }
    return {
      ...empty,
      state:
        failure !== null
          ? 'failed'
          : state === undefined
            ? 'pending'
            : changed > 0 || state.seen === null
              ? 'bare-changed'
              : 'collapsed',
      wouldChangeTwin: state === undefined && pair.initialChangesTwin(db),
      snapshotPath: state?.snapshot ?? failure?.snapshotPath ?? null,
      collapsedAt: state?.collapsedAt || null,
      lastMergedAt: state?.lastMergedAt || null,
      changedSinceMerge: state === undefined ? 0 : changed,
      failure,
    };
  });
}
