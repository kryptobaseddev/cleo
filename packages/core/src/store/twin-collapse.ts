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
 * that share project stores and keeps writing the bare tables, so the collapse
 * runs at every open:
 *
 * - **Initial collapse** (no marker yet): check the free space, snapshot the
 *   store, then fold the bare table into the twin, bare-authoritative.
 * - **Incremental re-merge** (marker present): carry over only the bare keys
 *   (sticky ids) whose hash changed since the last merge. No snapshot. An
 *   unchanged bare table costs one read of it and no write.
 *
 * A later release removes the incremental re-merge once no supported build
 * writes the bare tables; slice 3 then drops them after a backup.
 *
 * ## State and provenance
 *
 * The marker row `twin_collapse:<bare table>` in the twin's key/value table
 * holds, per key (`schema_meta`) or per sticky id (`sticky_tags`), a sha256
 * of the BARE value and of the TWIN value as of the last merge. A bare hash
 * that moved means the older build wrote it; a twin hash that moved means this
 * build wrote it.
 *
 * ## Rules
 *
 * The bare row is authoritative for every key. A monotonic counter FIELD is
 * merged on its own: the result is the bare value with that field set to
 * max(bare, twin). A whole twin value never replaces a bare one
 * ({@link mergeSchemaMetaValue}).
 *
 * | `schema_meta` key | Counter field |
 * |---|---|
 * | `task_id_sequence` (`{counter,lastId,checksum}` from `sequence/index.ts`, or a plain number) | `counter` (a plain number takes the max of the two numbers) |
 * | `sqlite_snapshot_gate` (`{generation,prefixes}`, `snapshot-gate.ts`) | `generation` |
 * | `file_meta` (`FileMeta`; `session/engine-ops.ts` bumps `generation` on session start/end/resume) | `generation` |
 * | `backfill:*` (the two `t877` guard keys) | not carried: the lineage re-inserts them into every bare table and nothing reads them |
 * | `twin_collapse*` | not carried: collapse state and failures live only in the twin |
 * | every other key (`schemaVersion`, `version`, `focus_state`, `focus_state:<session>`, `project_meta`, `project`, `parallel_state`, `activeSession`, `reconcile.<task>.release`, any unknown key) | none: the bare value |
 *
 * - **Initial collapse**, when the bare table holds at least one carried key:
 *   every bare key is carried under the rules, and a key only the twin holds
 *   is a frozen copy and is DROPPED (listed in the receipt, marker and log).
 *   The exceptions are `task_id_sequence` and `sqlite_snapshot_gate` (a
 *   counter must not move back) and the collapse keys. `file_meta` is dropped
 *   only when the bare table lacks it; when both have it the field rule
 *   applies. When the bare table holds no carried key (a fresh lineage, e.g.
 *   after exodus landed legacy rows in the twin), nothing is dropped.
 * - **Incremental re-merge**, per bare key whose hash changed since the last
 *   merge:
 *   - twin unchanged since the last merge → the bare value (counter fields
 *     maxed);
 *   - twin ALSO changed (this build wrote it too) → CONFLICT: the TWIN value
 *     wins, recorded in the marker and reported by `cleo doctor` as a warning.
 *     A counter key is never a conflict: the twin value is kept with its
 *     counter field maxed against the bare one.
 *   A key the older build deleted is deleted from the twin unless the twin
 *   changed it too (conflict) or it is `task_id_sequence` /
 *   `sqlite_snapshot_gate`. A key the bare table never changed is never
 *   touched.
 *
 * `sticky_tags` → `brain_sticky_tags` (rows are `(sticky_id, tag)`, both the
 * key, so a collision is two identical rows and one is kept):
 *
 * - Initial collapse, when the bare table has rows: the twin is made equal to
 *   the bare set; frozen twin-only rows are dropped and listed. A bare tag whose
 *   note no longer exists is not carried (`skipped`; it stays in the bare table).
 * - Incremental re-merge, per sticky id whose bare tag-set hash changed: if
 *   the twin's set for that id is unchanged since the last merge, the twin
 *   set is made equal to the bare set (additions AND removals propagate);
 *   if the twin set changed too, the twin wins and a conflict is recorded.
 *
 * `attachments` → `docs_attachments` (key `id`) and `attachment_refs` →
 * `docs_attachment_refs` (key `(attachment_id, owner_type, owner_id)`) use the
 * generic keyed-row pair ({@link rowPair}). Neither has a counter field; the
 * bare row is authoritative over the columns both tables share:
 *
 * - Initial collapse, when the bare table has rows: the twin is made equal to
 *   the bare table; frozen twin-only rows are dropped and listed.
 * - Incremental re-merge, per key whose bare row hash changed: twin unchanged
 *   → the bare row is upserted (or the twin row deleted when the bare row is
 *   gone); twin changed too → the twin wins and a conflict is recorded.
 * - Union shape: migration `20260929000000_t12535-docs-attachments-union-shape`
 *   adds the bare-only `display_alias` column and indexes; the UNIQUE slug and
 *   sha256 indexes are dropped and re-created by the merge itself around the
 *   row changes, so a frozen twin duplicate cannot fail the migration and
 *   two rows swapping a slug cannot fail the merge. Every merge ends with
 *   them in place, or rolls back.
 * - The `supersedes` / `superseded_by` self-FKs are checked at commit
 *   (`PRAGMA defer_foreign_keys`), so a chain merges in any row order.
 * - A bare row that violates a twin CHECK (e.g. a non-ISO `created_at`) fails
 *   the merge; the store opens degraded and `cleo doctor twin-collapse` shows
 *   the cause.
 *
 * ## Contract
 *
 * 1. **Snapshot first** (initial collapse only, only when the merge changes
 *    the twin). The free space is checked before the `VACUUM INTO`. One
 *    snapshot covers every pair collapsing in this open, registered as a
 *    `migration` backup (`cleo backup list`, rotation).
 * 2. **Atomic.** Each pair merges, verifies and writes its marker in one
 *    `BEGIN IMMEDIATE` transaction, the marker re-read under the write lock.
 *    Any failure rolls back: both tables byte-identical.
 * 3. **Verified.** Every row the merge decided is re-read and compared before
 *    the marker is written; a mismatch rolls back.
 * 4. **The bare table is never written.**
 * 5. **Never locked out** (inside a domain bind, `onFailure: 'degrade'`). A
 *    failed or impossible collapse does not fail the bind. The failure is
 *    recorded (`twin_collapse_failed:<table>`), and the connection is put in a
 *    READ-ONLY-FOR-USERS mode: the merged view the collapse would have
 *    committed is computed in memory and served from TEMP shadow tables of the
 *    same names (unqualified SQL resolves `temp` before `main`), so reads see
 *    bare-authoritative data while `main` stays untouched. Mutating operations
 *    are refused with `E_TWIN_COLLAPSE_FAILED` by the dispatch write guard
 *    ({@link twinCollapseFailureOf}), and the shadows carry TEMP triggers that
 *    abort any write into them ({@link SHADOW_WRITE_REFUSED}), so a direct SDK
 *    write fails instead of being lost. `cleo doctor twin-collapse --retry`
 *    runs the collapse with `onFailure: 'throw'`; on success the shadows and
 *    their triggers are dropped.
 *
 * ## Gate 28
 *
 * This module is a sanctioned writer (`scripts/lint-no-raw-table-writes.mjs`
 * SANCTIONED): it runs on the chokepoint handle inside the domain bind, and the
 * accessors import the modules that call it.
 *
 * @module
 * @task T12535
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';
import { planMigrationSnapshot, writeMigrationSnapshot } from './pre-repair-snapshot.js';
import { SNAPSHOT_GATE_META_KEY } from './snapshot-gate.js';

const log = getLogger('twin-collapse');

/** Prefix of the marker key holding a pair's collapse state. */
export const TWIN_COLLAPSE_MARKER_PREFIX = 'twin_collapse:';

/** Prefix of the key recording a pair's last failed collapse. */
export const TWIN_COLLAPSE_FAILURE_PREFIX = 'twin_collapse_failed:';

/** `schema_meta` keys whose named field is a monotonic counter (merged as max). */
export const SCHEMA_META_COUNTER_FIELDS: Readonly<Record<string, string>> = {
  task_id_sequence: 'counter',
  [SNAPSHOT_GATE_META_KEY]: 'generation',
  file_meta: 'generation',
};

/** `schema_meta` keys never deleted from the twin (a counter never moves back). */
export const SCHEMA_META_NEVER_DELETED: ReadonlySet<string> = new Set([
  'task_id_sequence',
  SNAPSHOT_GATE_META_KEY,
]);

/** Most conflicts kept in the marker (the doctor warning lists them). */
const MAX_CONFLICTS = 50;

/** What one call did to one pair. */
export interface TwinCollapseReceipt {
  /** The bare legacy table. */
  readonly table: string;
  /** The prefixed twin. */
  readonly twin: string;
  /**
   * `initial`: the first collapse ran. `incremental`: bare changes since the
   * last merge were carried. `unchanged`: the bare table matched the stored
   * hashes. `degraded`: the collapse failed inside a bind; reads are served
   * from TEMP shadows and writes are refused. `no-bare-table`: a table of the
   * pair is missing.
   */
  readonly status: 'initial' | 'incremental' | 'unchanged' | 'degraded' | 'no-bare-table';
  /** The initial collapse's snapshot, or `null`. */
  readonly snapshotPath: string | null;
  /** Rows added to the twin. */
  readonly inserted: number;
  /** Twin rows whose value was replaced. */
  readonly replaced: number;
  /** Twin rows deleted (bare deletions, frozen rows dropped initially). */
  readonly deleted: number;
  /** Bare rows not carried by rule (dead keys, tags of deleted notes). */
  readonly skipped: number;
  /** Frozen twin rows the initial collapse dropped (keys, or `sticky_id\ttag`). */
  readonly dropped: readonly string[];
  /** Keys (or sticky ids) both builds changed since the last merge; the twin was kept. */
  readonly conflicts: readonly string[];
}

/** Per-key (or per sticky id) hashes of both sides as of the last merge. */
interface Hashes {
  readonly bare: Readonly<Record<string, string>>;
  readonly twin: Readonly<Record<string, string>>;
}

/** Stored collapse state (the marker row's value). */
interface CollapseState {
  readonly version: 3;
  readonly task: 'T12535';
  readonly collapsedAt: string;
  readonly lastMergedAt: string;
  readonly snapshot: string | null;
  /** `null` for a pre-release marker without hashes. */
  readonly hashes: Hashes | null;
  readonly dropped: readonly string[];
  /** Conflicts of the last merge that carried anything. */
  readonly conflicts: readonly string[];
  readonly conflictsAt: string | null;
}

/** Row-level changes a plan makes to the twin. */
interface Plan {
  /** Rows to write (key → value, or `sticky_id\ttag` → ''). */
  readonly set: Map<string, string>;
  /** Rows to delete (keys, or `sticky_id\ttag`). */
  readonly del: string[];
  readonly dropped: string[];
  readonly conflicts: string[];
  skipped: number;
}

/** One bare/twin pair. */
interface TwinPair {
  readonly table: string;
  readonly twin: string;
  /** Key/value table holding the marker and failure rows. */
  readonly kvTable: string;
  /** Every table the pair reads or writes. */
  readonly tables: readonly string[];
  /** Current hashes of the bare side (per key / sticky id). */
  bareHashes(db: DatabaseSync): Record<string, string>;
  /** Current hashes of the twin side (per key / sticky id), read from `main`. */
  twinHashes(db: DatabaseSync): Record<string, string>;
  /** Plan against `main`: the initial collapse when `state` is undefined. */
  plan(db: DatabaseSync, state: CollapseState | undefined): Plan;
  /** Apply a plan to `main.<twin>` and verify it (inside the transaction). */
  apply(db: DatabaseSync, plan: Plan): { inserted: number; replaced: number; deleted: number };
  /** Build the TEMP shadow of the twin with a plan applied (read-only-for-users mode). */
  shadow(db: DatabaseSync, plan: Plan): void;
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Hash of an absent value (distinct from any real value's hash). */
const ABSENT = sha('\u0000absent');

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

function sameHashes(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** Parse a marker row; a pre-release marker (no hashes) yields `hashes: null`. */
function readState(db: DatabaseSync, pair: TwinPair): CollapseState | undefined {
  const raw = readKv(db, pair.kvTable, `${TWIN_COLLAPSE_MARKER_PREFIX}${pair.table}`);
  if (raw === undefined) return undefined;
  let parsed: Partial<CollapseState> = {};
  try {
    parsed = JSON.parse(raw) as Partial<CollapseState>;
  } catch {
    parsed = {};
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    version: 3,
    task: 'T12535',
    collapsedAt: str(parsed.collapsedAt),
    lastMergedAt: str(parsed.lastMergedAt),
    snapshot: typeof parsed.snapshot === 'string' ? parsed.snapshot : null,
    hashes: parsed.version === 3 && parsed.hashes ? parsed.hashes : null,
    dropped: Array.isArray(parsed.dropped) ? parsed.dropped : [],
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
    conflictsAt: typeof parsed.conflictsAt === 'string' ? parsed.conflictsAt : null,
  };
}

/** Whether the bare side moved since the stored hashes (or no usable state exists). */
function bareChanged(db: DatabaseSync, pair: TwinPair, state: CollapseState | undefined): boolean {
  return !state?.hashes || !sameHashes(state.hashes.bare, pair.bareHashes(db));
}

/** Hashes of the last merge; a pre-release marker treats the current twin as unchanged. */
function lastHashes(db: DatabaseSync, pair: TwinPair, state: CollapseState): Hashes {
  return state.hashes ?? { bare: {}, twin: pair.twinHashes(db) };
}

// ── schema_meta ──────────────────────────────────────────────────────────────

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** A counter field's value, whether the whole value is a number or an object holding it. */
function counterOf(value: string, field: string): number | undefined {
  const parsed = parseJson(value);
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const n = (parsed as Record<string, unknown>)[field];
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * `base` with its counter field raised to the other value's counter when that
 * is larger. `base` is returned verbatim otherwise, and when it has no
 * counter to raise (not a number, not an object holding the field).
 */
function withMaxCounter(base: string, other: string | undefined, field: string): string {
  if (other === undefined) return base;
  const b = counterOf(base, field);
  const o = counterOf(other, field);
  if (b === undefined || o === undefined || o <= b) return base;
  const parsed = parseJson(base);
  if (typeof parsed === 'number') return String(o);
  return JSON.stringify({ ...(parsed as Record<string, unknown>), [field]: o });
}

/** Whether a `schema_meta` key is carried at all. */
function carried(key: string): boolean {
  return !key.startsWith('backfill:') && !key.startsWith('twin_collapse');
}

/**
 * The value a `schema_meta` key gets when the bare side is authoritative (the
 * rule table is in the module comment).
 *
 * @param key - The key.
 * @param bare - Its value in the bare table.
 * @param twin - Its value in the twin, or `undefined` when absent.
 * @returns The value to keep, or `null` when the key is not carried.
 * @task T12535
 */
export function mergeSchemaMetaValue(
  key: string,
  bare: string,
  twin: string | undefined,
): string | null {
  if (!carried(key)) return null;
  const field = SCHEMA_META_COUNTER_FIELDS[key];
  return field === undefined ? bare : withMaxCounter(bare, twin, field);
}

function kvRows(db: DatabaseSync, table: string, schema = 'main'): Map<string, string> {
  const rows = db.prepare(`SELECT key, value FROM ${schema}.${table}`).all() as Array<{
    key: string;
    value: string;
  }>;
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Carried rows of a `schema_meta` table. */
function carriedRows(db: DatabaseSync, table: string): Map<string, string> {
  const all = kvRows(db, table);
  for (const key of [...all.keys()]) if (!carried(key)) all.delete(key);
  return all;
}

const hashMap = (m: ReadonlyMap<string, string>): Record<string, string> =>
  Object.fromEntries([...m].map(([k, v]) => [k, sha(v)]));

const emptyPlan = (): Plan => ({ set: new Map(), del: [], dropped: [], conflicts: [], skipped: 0 });

function planSchemaMeta(db: DatabaseSync, state: CollapseState | undefined): Plan {
  const plan = emptyPlan();
  const bare = carriedRows(db, 'schema_meta');
  const twin = carriedRows(db, 'tasks_schema_meta');
  const want = (key: string, value: string | null): void => {
    if (value !== null && value !== twin.get(key)) plan.set.set(key, value);
  };
  if (state === undefined) {
    if (bare.size === 0) return plan;
    for (const [key, value] of bare) want(key, mergeSchemaMetaValue(key, value, twin.get(key)));
    for (const key of [...twin.keys()].sort()) {
      if (!bare.has(key) && !SCHEMA_META_NEVER_DELETED.has(key)) {
        plan.del.push(key);
        plan.dropped.push(key);
      }
    }
    return plan;
  }
  const last = lastHashes(db, SCHEMA_META, state);
  const twinMoved = (key: string): boolean => {
    const now = twin.has(key) ? sha(twin.get(key) as string) : ABSENT;
    return now !== (last.twin[key] ?? ABSENT);
  };
  for (const key of [...bare.keys()].sort()) {
    const value = bare.get(key) as string;
    if (last.bare[key] === sha(value)) continue;
    const field = SCHEMA_META_COUNTER_FIELDS[key];
    const current = twin.get(key);
    if (field !== undefined) {
      // A counter is never a conflict: keep whichever side is authoritative
      // for the rest of the value, and max the counter field against the other.
      const base = twinMoved(key) && current !== undefined ? current : value;
      want(key, withMaxCounter(base, base === value ? current : value, field));
    } else if (twinMoved(key)) {
      plan.conflicts.push(key);
    } else {
      want(key, value);
    }
  }
  for (const key of Object.keys(last.bare).sort()) {
    if (bare.has(key) || SCHEMA_META_NEVER_DELETED.has(key) || !twin.has(key)) continue;
    if (twinMoved(key)) plan.conflicts.push(key);
    else plan.del.push(key);
  }
  return plan;
}

function applyKv(db: DatabaseSync, schema: string, table: string, plan: Plan) {
  const before = kvRows(db, table, schema);
  const upsert = db.prepare(
    `INSERT INTO ${schema}.${table} (key, value) VALUES (?, ?) ` +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const del = db.prepare(`DELETE FROM ${schema}.${table} WHERE key = ?`);
  let inserted = 0;
  let replaced = 0;
  let deleted = 0;
  for (const [key, value] of plan.set) {
    upsert.run(key, value);
    if (before.has(key)) replaced++;
    else inserted++;
  }
  for (const key of plan.del) deleted += Number(del.run(key).changes);
  return { inserted, replaced, deleted };
}

const SCHEMA_META: TwinPair = {
  table: 'schema_meta',
  twin: 'tasks_schema_meta',
  kvTable: 'tasks_schema_meta',
  tables: ['schema_meta', 'tasks_schema_meta'],
  bareHashes: (db) => hashMap(carriedRows(db, 'schema_meta')),
  twinHashes: (db) => hashMap(carriedRows(db, 'tasks_schema_meta')),
  plan: planSchemaMeta,
  apply(db, plan) {
    const counts = applyKv(db, 'main', 'tasks_schema_meta', plan);
    for (const [key, value] of plan.set) {
      if (readKv(db, 'tasks_schema_meta', key) !== value)
        throw new Error(`schema_meta collapse did not verify for key ${JSON.stringify(key)}`);
    }
    for (const key of plan.del) {
      if (readKv(db, 'tasks_schema_meta', key) !== undefined)
        throw new Error(
          `schema_meta collapse did not verify the removal of ${JSON.stringify(key)}`,
        );
    }
    return counts;
  },
  shadow(db, plan) {
    db.exec(
      'CREATE TEMP TABLE IF NOT EXISTS tasks_schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    db.exec('DELETE FROM temp.tasks_schema_meta');
    db.exec(
      'INSERT INTO temp.tasks_schema_meta (key, value) SELECT key, value FROM main.tasks_schema_meta',
    );
    applyKv(db, 'temp', 'tasks_schema_meta', plan);
  },
};

// ── sticky_tags ──────────────────────────────────────────────────────────────

/** Tag sets by sticky id (tags sorted). */
function stickySets(db: DatabaseSync, table: string): Map<string, string[]> {
  const rows = db
    .prepare(`SELECT sticky_id, tag FROM main.${table} ORDER BY sticky_id, tag`)
    .all() as Array<{ sticky_id: string; tag: string }>;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const tags = out.get(r.sticky_id) ?? [];
    tags.push(r.tag);
    out.set(r.sticky_id, tags);
  }
  return out;
}

const hashSets = (m: ReadonlyMap<string, readonly string[]>): Record<string, string> =>
  Object.fromEntries([...m].map(([k, tags]) => [k, sha(JSON.stringify(tags))]));

const EMPTY_SET = sha(JSON.stringify([]));

function planSticky(db: DatabaseSync, state: CollapseState | undefined): Plan {
  const plan = emptyPlan();
  const bare = stickySets(db, 'sticky_tags');
  const twin = stickySets(db, 'brain_sticky_tags');
  const noteExists = db.prepare('SELECT 1 FROM main.brain_sticky_notes WHERE id = ?');
  /** Make the twin's set for `id` equal the bare set. */
  const mirror = (id: string, dropping: boolean): void => {
    const b = new Set(bare.get(id) ?? []);
    const t = new Set(twin.get(id) ?? []);
    const alive = b.size === 0 || noteExists.get(id) !== undefined;
    for (const tag of b) {
      if (!alive) plan.skipped++;
      else if (!t.has(tag)) plan.set.set(`${id}\t${tag}`, '');
    }
    for (const tag of t) {
      if (b.has(tag)) continue;
      plan.del.push(`${id}\t${tag}`);
      if (dropping) plan.dropped.push(`${id}\t${tag}`);
    }
  };
  if (state === undefined) {
    if (bare.size === 0) return plan;
    for (const id of [...new Set([...bare.keys(), ...twin.keys()])].sort()) mirror(id, true);
    return plan;
  }
  const last = lastHashes(db, STICKY_TAGS, state);
  const ids = new Set([...bare.keys(), ...Object.keys(last.bare)]);
  for (const id of [...ids].sort()) {
    const bareNow = bare.has(id) ? sha(JSON.stringify(bare.get(id))) : EMPTY_SET;
    if (bareNow === (last.bare[id] ?? EMPTY_SET)) continue;
    const twinNow = twin.has(id) ? sha(JSON.stringify(twin.get(id))) : EMPTY_SET;
    if (twinNow !== (last.twin[id] ?? EMPTY_SET)) plan.conflicts.push(id);
    else mirror(id, false);
  }
  return plan;
}

function applyStickyRows(db: DatabaseSync, schema: string, plan: Plan) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${schema}.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)`,
  );
  const del = db.prepare(`DELETE FROM ${schema}.brain_sticky_tags WHERE sticky_id = ? AND tag = ?`);
  let inserted = 0;
  let deleted = 0;
  for (const row of plan.set.keys()) {
    const [id, tag] = row.split('\t') as [string, string];
    inserted += Number(insert.run(id, tag).changes);
  }
  for (const row of plan.del) {
    const [id, tag] = row.split('\t') as [string, string];
    deleted += Number(del.run(id, tag).changes);
  }
  return { inserted, replaced: 0, deleted };
}

const STICKY_TAGS: TwinPair = {
  table: 'sticky_tags',
  twin: 'brain_sticky_tags',
  kvTable: 'brain_schema_meta',
  tables: ['sticky_tags', 'brain_sticky_tags', 'brain_sticky_notes', 'brain_schema_meta'],
  bareHashes: (db) => hashSets(stickySets(db, 'sticky_tags')),
  twinHashes: (db) => hashSets(stickySets(db, 'brain_sticky_tags')),
  plan: planSticky,
  apply(db, plan) {
    const counts = applyStickyRows(db, 'main', plan);
    const present = db.prepare(
      'SELECT 1 FROM main.brain_sticky_tags WHERE sticky_id = ? AND tag = ?',
    );
    const has = (row: string): boolean => {
      const [id, tag] = row.split('\t') as [string, string];
      return present.get(id, tag) !== undefined;
    };
    const missing = [...plan.set.keys()].filter((r) => !has(r)).length;
    const lingering = plan.del.filter(has).length;
    if (missing > 0 || lingering > 0)
      throw new Error(
        `sticky_tags collapse did not verify: ${missing} missing, ${lingering} not removed`,
      );
    return counts;
  },
  shadow(db, plan) {
    db.exec(
      'CREATE TEMP TABLE IF NOT EXISTS brain_sticky_tags (sticky_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (sticky_id, tag))',
    );
    db.exec('DELETE FROM temp.brain_sticky_tags');
    db.exec(
      'INSERT INTO temp.brain_sticky_tags (sticky_id, tag) SELECT sticky_id, tag FROM main.brain_sticky_tags',
    );
    applyStickyRows(db, 'temp', plan);
  },
};

// ── row tables (generic) ─────────────────────────────────────────────────────

/** How a row-shaped bare table folds into its twin. */
interface RowPairSpec {
  /** The bare legacy table. */
  readonly table: string;
  /** The prefixed twin. */
  readonly twin: string;
  /** Key/value table holding the marker and failure rows. */
  readonly kvTable: string;
  /** The primary-key columns (the row identity, shared by both tables). */
  readonly key: readonly string[];
  /**
   * Union shape: UNIQUE indexes the bare (newer) table has and the twin lacks.
   * The merge drops them, applies the rows, and creates them again inside the
   * same transaction, so a frozen twin duplicate or two rows swapping a value
   * never trip them midway, and the result must satisfy them.
   */
  readonly uniqueIndexes?: ReadonlyArray<{ readonly name: string; readonly on: string }>;
}

/** Column names of a table, in declaration order. */
function columnsOf(db: DatabaseSync, schema: string, table: string): string[] {
  return (
    db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Rows of a table keyed by the JSON of their key columns; each row is the JSON
 * of the shared columns in `columns` order (the hash and upsert payload).
 */
function keyedRows(
  db: DatabaseSync,
  schema: string,
  table: string,
  key: readonly string[],
  columns: readonly string[],
): Map<string, string> {
  const rows = db
    .prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${schema}.${quoteIdent(table)}`)
    .all() as Array<Record<string, unknown>>;
  return new Map(
    rows.map((r) => [
      JSON.stringify(key.map((k) => r[k])),
      JSON.stringify(columns.map((c) => r[c] ?? null)),
    ]),
  );
}

/**
 * A bare/twin pair of row tables with a shared primary key. The bare row is
 * authoritative. Initial collapse: when the bare table has rows, the twin is
 * made equal to it (missing and differing rows upserted, frozen twin-only rows
 * dropped and listed). Incremental re-merge: a key whose bare row hash changed
 * since the last merge is carried (upserted, or deleted when the bare row is
 * gone) unless the twin row changed too, which is a conflict the twin wins.
 * No counters: no field is merged on its own.
 */
function rowPair(spec: RowPairSpec): TwinPair {
  // Shared columns: what both tables hold (after the union-shape migration the
  // twin holds every bare column). Resolved per connection.
  const shared = (db: DatabaseSync): string[] => {
    const twinCols = new Set(columnsOf(db, 'main', spec.twin));
    return columnsOf(db, 'main', spec.table).filter((c) => twinCols.has(c));
  };
  const rowsOf = (db: DatabaseSync, schema: string, table: string): Map<string, string> =>
    keyedRows(db, schema, table, spec.key, shared(db));
  const hashes = (rows: ReadonlyMap<string, string>): Record<string, string> =>
    Object.fromEntries([...rows].map(([k, v]) => [k, sha(v)]));
  const upsertInto = (db: DatabaseSync, schema: string, plan: Plan) => {
    const cols = shared(db);
    const before = keyedRows(db, schema, spec.twin, spec.key, cols);
    const nonKey = cols.filter((c) => !spec.key.includes(c));
    const upsert = db.prepare(
      `INSERT INTO ${schema}.${quoteIdent(spec.twin)} (${cols.map(quoteIdent).join(', ')}) ` +
        `VALUES (${cols.map(() => '?').join(', ')}) ` +
        `ON CONFLICT(${spec.key.map(quoteIdent).join(', ')}) DO UPDATE SET ` +
        nonKey.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(', '),
    );
    const del = db.prepare(
      `DELETE FROM ${schema}.${quoteIdent(spec.twin)} WHERE ` +
        spec.key.map((k) => `${quoteIdent(k)} IS ?`).join(' AND '),
    );
    let inserted = 0;
    let replaced = 0;
    let deleted = 0;
    for (const key of plan.del) {
      deleted += Number(del.run(...(JSON.parse(key) as Array<string | number | null>)).changes);
    }
    for (const [key, row] of plan.set) {
      upsert.run(...(JSON.parse(row) as Array<string | number | null>));
      if (before.has(key)) replaced++;
      else inserted++;
    }
    return { inserted, replaced, deleted };
  };
  return {
    table: spec.table,
    twin: spec.twin,
    kvTable: spec.kvTable,
    tables: [spec.table, spec.twin, spec.kvTable],
    bareHashes: (db) => hashes(rowsOf(db, 'main', spec.table)),
    twinHashes: (db) => hashes(rowsOf(db, 'main', spec.twin)),
    plan(db, state) {
      const plan = emptyPlan();
      const bare = rowsOf(db, 'main', spec.table);
      const twin = rowsOf(db, 'main', spec.twin);
      if (state === undefined) {
        if (bare.size === 0) return plan;
        for (const [key, row] of bare) if (twin.get(key) !== row) plan.set.set(key, row);
        for (const key of [...twin.keys()].sort()) {
          if (bare.has(key)) continue;
          plan.del.push(key);
          plan.dropped.push(key);
        }
        return plan;
      }
      const last = lastHashes(db, this, state);
      for (const key of [...new Set([...bare.keys(), ...Object.keys(last.bare)])].sort()) {
        const bareRow = bare.get(key);
        if ((bareRow === undefined ? ABSENT : sha(bareRow)) === (last.bare[key] ?? ABSENT))
          continue;
        const twinRow = twin.get(key);
        if ((twinRow === undefined ? ABSENT : sha(twinRow)) !== (last.twin[key] ?? ABSENT)) {
          plan.conflicts.push(key);
        } else if (bareRow !== undefined) {
          if (twinRow !== bareRow) plan.set.set(key, bareRow);
        } else if (twinRow !== undefined) {
          plan.del.push(key);
        }
      }
      return plan;
    },
    apply(db, plan) {
      // Rows may reference each other (self foreign keys); check at COMMIT.
      db.exec('PRAGMA defer_foreign_keys = ON');
      for (const index of spec.uniqueIndexes ?? [])
        db.exec(`DROP INDEX IF EXISTS main.${quoteIdent(index.name)}`);
      const counts = upsertInto(db, 'main', plan);
      for (const index of spec.uniqueIndexes ?? [])
        db.exec(
          `CREATE UNIQUE INDEX main.${quoteIdent(index.name)} ON ${quoteIdent(spec.twin)} ${index.on}`,
        );
      const after = rowsOf(db, 'main', spec.twin);
      for (const [key, row] of plan.set) {
        if (after.get(key) !== row)
          throw new Error(`${spec.table} collapse did not verify for row ${key}`);
      }
      for (const key of plan.del) {
        if (after.has(key))
          throw new Error(`${spec.table} collapse did not verify the removal of row ${key}`);
      }
      return counts;
    },
    shadow(db, plan) {
      const twin = quoteIdent(spec.twin);
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${twin} AS SELECT * FROM main.${twin} WHERE 0`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS temp.${quoteIdent(`${spec.twin}_shadow_key`)} ` +
          `ON ${twin} (${spec.key.map(quoteIdent).join(', ')})`,
      );
      db.exec(`DELETE FROM temp.${twin}`);
      db.exec(`INSERT INTO temp.${twin} SELECT * FROM main.${twin}`);
      upsertInto(db, 'temp', plan);
    },
  };
}

/**
 * `attachments` → `docs_attachments`. The union-shape migration
 * (`drizzle-cleo-project/…_t12535-docs-attachments-union-shape`) gives the twin
 * the bare table's `display_alias` column and its `type` / `display_alias`
 * indexes. The two UNIQUE indexes the docs code relies on (`slug`, partial;
 * `sha256`) are (re)created by every merge, after the rows are applied,
 * because a frozen twin could hold duplicates that the bare-authoritative
 * merge removes first.
 */
const ATTACHMENTS: TwinPair = rowPair({
  table: 'attachments',
  twin: 'docs_attachments',
  kvTable: 'tasks_schema_meta',
  key: ['id'],
  uniqueIndexes: [
    { name: 'uniq_docs_attachments_slug', on: '(slug) WHERE slug IS NOT NULL' },
    { name: 'uniq_docs_attachments_sha256', on: '(sha256)' },
  ],
});

/** `attachment_refs` → `docs_attachment_refs` (same columns and key). */
const ATTACHMENT_REFS: TwinPair = rowPair({
  table: 'attachment_refs',
  twin: 'docs_attachment_refs',
  kvTable: 'tasks_schema_meta',
  key: ['attachment_id', 'owner_type', 'owner_id'],
});

/** The pairs this build collapses, in order. */
const PAIRS: readonly TwinPair[] = [SCHEMA_META, STICKY_TAGS, ATTACHMENTS, ATTACHMENT_REFS];

// ── failure, read-only-for-users mode ────────────────────────────────────────

/** Why a collapse failed, as carried by `E_TWIN_COLLAPSE_FAILED`. */
export interface TwinCollapseFailure {
  /** The bare tables whose collapse did not complete. */
  readonly tables: readonly string[];
  /** The underlying error message. */
  readonly cause: string;
  /** The snapshot this collapse needs (the planned path) or wrote, or `null`. */
  readonly snapshotPath: string | null;
  /** Whether {@link snapshotPath} was written (`false`: only planned). */
  readonly snapshotWritten: boolean;
  /** Free space the snapshot needs, in bytes (0 when none was needed). */
  readonly requiredBytes: number;
  /** Free space measured on the backup filesystem, or `null`. */
  readonly availableBytes: number | null;
  /** When it failed (ISO-8601). */
  readonly failedAt: string;
}

/** Connections serving TEMP shadows because their collapse failed. */
const degraded = new WeakMap<object, TwinCollapseFailure>();

/**
 * The failure a connection is degraded by, if any: reads on it are served from
 * TEMP shadows and writes must be refused (the dispatch write guard does).
 *
 * @param db - A project `cleo.db` connection.
 * @returns The failure, or `undefined` when the store is fully collapsed.
 * @task T12535
 */
export function twinCollapseFailureOf(db: DatabaseSync): TwinCollapseFailure | undefined {
  return degraded.get(db);
}

/**
 * Refuse a write before its first statement when the store is degraded by a
 * failed twin collapse. The write accessors of the collapsed tables
 * (`tasks_schema_meta`, and sticky notes and tags) call it at entry, so a
 * degraded store never takes a partial write (e.g. a sticky's `tags_json`
 * without its tag rows). The shadows' TEMP triggers stay as the backstop.
 *
 * @param handle - The connection the write would use: the native
 *   `DatabaseSync`, or a drizzle instance (its `$client` is checked).
 *   `null`/`undefined` (no bound handle) is not checked.
 * @throws {CleoError} `E_TWIN_COLLAPSE_FAILED` when the connection is degraded.
 * @task T12535
 */
export function assertTwinCollapseWritable(
  handle: DatabaseSync | NodeSQLiteDatabase | null | undefined,
): void {
  if (!handle) return;
  const native = '$client' in handle ? handle.$client : handle;
  if (typeof native !== 'object' || native === null) return;
  const failure = degraded.get(native);
  if (failure) throw twinCollapseError(failure);
}

/**
 * Build the `E_TWIN_COLLAPSE_FAILED` error for a failure.
 *
 * @param failure - The failure.
 * @param cause - The underlying error, when there is one.
 * @returns The error.
 * @task T12535
 */
export function twinCollapseError(failure: TwinCollapseFailure, cause?: unknown): CleoError {
  const where = !failure.snapshotPath
    ? ''
    : failure.snapshotWritten
      ? ` Snapshot: ${failure.snapshotPath}.`
      : ` Snapshot would be written to ${failure.snapshotPath}.`;
  const space =
    failure.requiredBytes > 0
      ? ` The snapshot needs ${failure.requiredBytes} bytes free` +
        (failure.availableBytes === null ? '.' : ` (${failure.availableBytes} free).`)
      : '';
  return new CleoError(
    ExitCode.TWIN_COLLAPSE_FAILED,
    `Twin collapse of ${failure.tables.join(', ')} failed (both tables unchanged; reads still ` +
      `work, writes are refused): ${failure.cause}.${where}${space} Run 'cleo doctor twin-collapse'.`,
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
      // The store itself may be the problem (disk full, read-only); the
      // failure is still carried by the degraded state and the error.
    }
  }
}

/** Message a write into a sealed shadow aborts with. */
export const SHADOW_WRITE_REFUSED =
  'E_TWIN_COLLAPSE_FAILED: store is read-only until the twin collapse succeeds; run cleo doctor twin-collapse';

const SHADOW_WRITE_OPS = ['INSERT', 'UPDATE', 'DELETE'] as const;

/** Remove a shadow's write-refusing triggers (before it is rebuilt). */
function unsealShadow(db: DatabaseSync, twin: string): void {
  for (const op of SHADOW_WRITE_OPS) {
    db.exec(`DROP TRIGGER IF EXISTS temp.${twin}_refuse_${op.toLowerCase()}`);
  }
}

/**
 * Make a shadow refuse writes. A write through the store accessors that
 * bypasses the dispatch write guard (a direct SDK call) then fails with
 * {@link SHADOW_WRITE_REFUSED} instead of landing in the shadow and being lost
 * when the connection closes. The collapse itself writes `main.<twin>`
 * (schema-qualified), which these TEMP triggers do not cover.
 */
function sealShadow(db: DatabaseSync, twin: string): void {
  for (const op of SHADOW_WRITE_OPS) {
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS ${twin}_refuse_${op.toLowerCase()} BEFORE ${op} ON temp.${twin} ` +
        `BEGIN SELECT RAISE(ABORT, '${SHADOW_WRITE_REFUSED}'); END`,
    );
  }
}

/** Drop the TEMP shadows (and their triggers) of a connection that is no longer degraded. */
function clearShadows(db: DatabaseSync): void {
  for (const pair of PAIRS) db.exec(`DROP TABLE IF EXISTS temp.${pair.twin}`);
  degraded.delete(db);
}

function receipt(
  pair: TwinPair,
  status: TwinCollapseReceipt['status'],
  snapshotPath: string | null,
): TwinCollapseReceipt {
  return {
    table: pair.table,
    twin: pair.twin,
    status,
    snapshotPath,
    inserted: 0,
    replaced: 0,
    deleted: 0,
    skipped: 0,
    dropped: [],
    conflicts: [],
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
      return receipt(pair, 'unchanged', state?.snapshot ?? null);
    }
    const plan = pair.plan(db, state);
    if (state === undefined && snapshotPath === null && (plan.set.size > 0 || plan.del.length > 0))
      throw new Error(`bare ${pair.table} changed after the snapshot decision; retry the open`);
    const counts = pair.apply(db, plan);
    const now = new Date().toISOString();
    const next: CollapseState = {
      version: 3,
      task: 'T12535',
      collapsedAt: state?.collapsedAt || now,
      lastMergedAt: now,
      snapshot: state?.snapshot ?? snapshotPath,
      hashes: { bare: pair.bareHashes(db), twin: pair.twinHashes(db) },
      dropped: state === undefined ? plan.dropped : state.dropped,
      conflicts: plan.conflicts.slice(0, MAX_CONFLICTS),
      conflictsAt: plan.conflicts.length > 0 ? now : null,
    };
    writeKv(db, pair.kvTable, `${TWIN_COLLAPSE_MARKER_PREFIX}${pair.table}`, JSON.stringify(next));
    db.prepare(`DELETE FROM main.${pair.kvTable} WHERE key = ?`).run(
      `${TWIN_COLLAPSE_FAILURE_PREFIX}${pair.table}`,
    );
    db.exec('COMMIT');
    const done: TwinCollapseReceipt = {
      ...receipt(pair, state === undefined ? 'initial' : 'incremental', next.snapshot),
      ...counts,
      skipped: plan.skipped,
      dropped: plan.dropped,
      conflicts: plan.conflicts,
    };
    if (counts.inserted + counts.replaced + counts.deleted > 0 || plan.conflicts.length > 0)
      log.warn(done, `carried bare ${pair.table} into ${pair.twin} (${done.status}, T12535)`);
    return done;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** Options for {@link collapseTwinTables}. */
export interface CollapseTwinTablesOptions {
  /**
   * `throw` (default): raise `E_TWIN_COLLAPSE_FAILED`. `degrade` (the domain
   * binds): record the failure, serve reads from TEMP shadows, and let the
   * dispatch write guard refuse writes.
   */
  readonly onFailure?: 'throw' | 'degrade';
}

/**
 * Collapse every bare/twin pair present in the store: the initial collapse
 * (snapshot first) where no marker exists yet, an incremental re-merge of
 * changed bare keys where one does.
 *
 * @param nativeDb - The project `cleo.db` connection, outside any transaction.
 * @param dbPath - Its file path (locates `.cleo/backups/sqlite/`).
 * @param options - Failure handling.
 * @returns One receipt per pair.
 * @throws {CleoError} `E_TWIN_COLLAPSE_FAILED` with `onFailure: 'throw'`.
 * @task T12535
 */
export function collapseTwinTables(
  nativeDb: DatabaseSync,
  dbPath: string,
  options: CollapseTwinTablesOptions = {},
): TwinCollapseReceipt[] {
  const onFailure = options.onFailure ?? 'throw';
  // A bind on a connection already degraded in this process does not retry:
  // the cause is outside CLEO; `cleo doctor twin-collapse --retry` retries.
  if (onFailure === 'degrade' && degraded.has(nativeDb))
    return PAIRS.map((p) => receipt(p, 'degraded', null));

  const byTable = new Map<string, TwinCollapseReceipt>();
  const inOrder = (): TwinCollapseReceipt[] =>
    PAIRS.map((p) => byTable.get(p.table)).filter((r): r is TwinCollapseReceipt => r !== undefined);
  const pending: TwinPair[] = [];
  for (const pair of PAIRS) {
    if (!pair.tables.every((t) => hasMainTable(nativeDb, t))) {
      byTable.set(pair.table, receipt(pair, 'no-bare-table', null));
      continue;
    }
    const state = readState(nativeDb, pair);
    if (bareChanged(nativeDb, pair, state)) pending.push(pair);
    else byTable.set(pair.table, receipt(pair, 'unchanged', state?.snapshot ?? null));
  }
  if (pending.length === 0) {
    if (degraded.has(nativeDb)) clearShadows(nativeDb);
    return inOrder();
  }
  if (nativeDb.isTransaction)
    throw new Error('twin collapse needs a connection outside a transaction');

  const fail = (pairs: readonly TwinPair[], failure: TwinCollapseFailure, cause: unknown) => {
    recordFailure(nativeDb, pairs, failure);
    log.error(failure, `twin collapse of ${failure.tables.join(', ')} failed (T12535)`);
    if (onFailure === 'throw') throw twinCollapseError(failure, cause);
    // Read-only-for-users mode: serve the merged view from TEMP shadows. If
    // even that cannot be built, reads cannot be served correctly either.
    try {
      for (const pair of pairs) {
        unsealShadow(nativeDb, pair.twin);
        pair.shadow(nativeDb, pair.plan(nativeDb, readState(nativeDb, pair)));
        sealShadow(nativeDb, pair.twin);
      }
    } catch (shadowError) {
      throw twinCollapseError(failure, shadowError);
    }
    degraded.set(nativeDb, failure);
    for (const pair of pairs)
      byTable.set(pair.table, receipt(pair, 'degraded', failure.snapshotPath));
  };

  // One snapshot covers every pair whose INITIAL collapse changes its twin.
  const needSnapshot = pending.filter((p) => {
    if (readState(nativeDb, p) !== undefined) return false;
    const plan = p.plan(nativeDb, undefined);
    return plan.set.size > 0 || plan.del.length > 0;
  });
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
      fail(
        needSnapshot,
        {
          tables: needSnapshot.map((p) => p.table),
          cause: `snapshot not written: ${error instanceof Error ? error.message : String(error)}`,
          snapshotPath: plan.snapshotPath,
          snapshotWritten: false,
          requiredBytes: plan.requiredBytes,
          availableBytes: plan.availableBytes,
          failedAt: new Date().toISOString(),
        },
        error,
      );
      // Pairs that need no snapshot (incremental, or an initial no-op) still run.
      const rest = pending.filter((p) => !needSnapshot.includes(p));
      pending.length = 0;
      pending.push(...rest);
    }
  }

  const failed: TwinPair[] = [];
  let firstError: unknown;
  for (const pair of pending) {
    try {
      byTable.set(pair.table, collapsePair(nativeDb, pair, snapshotPath));
    } catch (error) {
      failed.push(pair);
      firstError ??= error;
    }
  }
  if (failed.length > 0) {
    fail(
      failed,
      {
        tables: failed.map((p) => p.table),
        cause: firstError instanceof Error ? firstError.message : String(firstError),
        snapshotPath,
        snapshotWritten: snapshotPath !== null,
        requiredBytes: 0,
        availableBytes: null,
        failedAt: new Date().toISOString(),
      },
      firstError,
    );
  } else if (degraded.has(nativeDb) && byTable.size === PAIRS.length) {
    if ([...byTable.values()].every((r) => r.status !== 'degraded')) clearShadows(nativeDb);
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
   * `collapsed`: marker present, bare side unchanged since the last merge.
   * `bare-changed`: the older build changed the bare side since; the next
   * open carries it. `pending`: no marker; the initial collapse runs at the
   * next open. `failed`: the last attempt failed (see `failure`); reads are
   * served, writes refused. `no-bare-table`: nothing to collapse.
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
  /** Keys (schema_meta) or sticky ids (sticky_tags) the bare side changed since the last merge. */
  readonly changedSinceMerge: number;
  /** Keys / sticky ids both builds changed in the last merge (the twin was kept). */
  readonly conflicts: readonly string[];
  /** When those conflicts were recorded. */
  readonly conflictsAt: string | null;
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
      conflicts: [],
      conflictsAt: null,
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
    const now = pair.bareHashes(db);
    const prev = state?.hashes?.bare ?? {};
    let changed = 0;
    for (const k of new Set([...Object.keys(now), ...Object.keys(prev)])) {
      if (now[k] !== prev[k]) changed++;
    }
    let wouldChangeTwin = false;
    if (state === undefined) {
      const plan = pair.plan(db, undefined);
      wouldChangeTwin = plan.set.size > 0 || plan.del.length > 0;
    }
    return {
      ...empty,
      state:
        failure !== null
          ? 'failed'
          : state === undefined
            ? 'pending'
            : changed > 0 || state.hashes === null
              ? 'bare-changed'
              : 'collapsed',
      wouldChangeTwin,
      snapshotPath: state?.snapshot ?? failure?.snapshotPath ?? null,
      collapsedAt: state?.collapsedAt || null,
      lastMergedAt: state?.lastMergedAt || null,
      changedSinceMerge: state === undefined ? 0 : changed,
      conflicts: state?.conflicts ?? [],
      conflictsAt: state?.conflictsAt ?? null,
      failure,
    };
  });
}
