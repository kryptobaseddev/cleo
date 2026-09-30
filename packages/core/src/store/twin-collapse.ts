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
 *   every bare key is carried under the rules (the bare value wins every key
 *   both hold). A key only the twin holds is KEPT, never dropped (the union
 *   rule, T12535 audit 2026-09-29): it is listed as `kept` in the receipt and
 *   marker. When a key's twin value would be replaced by a different result,
 *   the twin value is copied to `twin_collapse_archive:<key>` in
 *   `tasks_schema_meta` (listed as `archived`; doctor shows it), so nothing
 *   unique is left only in the snapshot. `focus_state` merges instead: the
 *   bare value's current fields win and `sessionNotes` is the union of both,
 *   deduplicated by `(timestamp, note)` ({@link mergeFocusState}); its twin
 *   value is archived as well. The pre-collapse snapshot holds the store
 *   before any change and is pinned (never rotated).
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
 * - Initial collapse: bare tags are added. A twin-only tag the note's
 *   `tags_json` names is kept (listed as `kept`). One it does not name leaves
 *   the junction (which follows `tags_json`, the value every reader displays)
 *   and is recorded under `twin_collapse_archive:sticky_tags` in
 *   `brain_schema_meta` (listed as `archived`); adding it to `tags_json` would
 *   change the tags the user sees. A bare tag whose note no longer exists is
 *   not carried (`skipped`; it stays in the bare table).
 * - Incremental re-merge, per sticky id whose bare tag-set hash changed: if
 *   the twin's set for that id is unchanged since the last merge, the twin
 *   set is made equal to the bare set (additions AND removals propagate);
 *   if the twin set changed too, the twin wins and a conflict is recorded.
 * - After every merge the junction is recomputed from each note's
 *   `tags_json` ({@link syncStickyJunction}). Both builds write `tags_json`
 *   (on the shared `brain_sticky_notes` row) together with their own junction,
 *   so it is the one value both see; the junction is derived from it, and the
 *   tag filter can never disagree with the displayed tags. A conflict is still
 *   recorded for `cleo doctor`.
 *
 * `attachments` + `attachment_refs` → `docs_attachments` + `docs_attachment_refs`
 * merge as ONE pair, in one transaction (a doc and its refs never diverge).
 * The bare rows are authoritative over the columns both tables share, except
 * `ref_count`, which is derived: after every merge it is recomputed as the
 * number of refs in `docs_attachment_refs`, whoever wrote them (never carried,
 * never max'd). Rows are keyed `d:<id>` and `r:<attachment_id, owner_type,
 * owner_id>` in the marker hashes.
 *
 * - Initial collapse: the twins are made equal to the bare tables, even when
 *   the bare tables are empty (the older build never showed a twin-only row);
 *   frozen twin-only rows are dropped and listed.
 * - Incremental re-merge, per bare doc whose hash moved (see {@link planDocs}):
 *   twin changed too → conflict, the twin wins; bare row gone → the twin row
 *   goes unless a ref or a supersedes link still names it (`kept`); the
 *   content (sha256) already belongs to another twin row → merged into that
 *   row: the bare id is aliased to it (`twin_collapse_alias:attachments`) and
 *   its refs follow; the slug already belongs to another twin row → carried
 *   under `<slug>-<n>` (`renamed`). Natural keys are checked against the state
 *   after the merge, so a merge never fails on them. Per bare ref whose hash
 *   moved: added → added (aliased), removed → removed unless this build
 *   changed it since.
 * - Change detection: AFTER triggers on the bare tables (`t12535_track_*`)
 *   bump `twin_collapse_seq:attachments` on every write, the older build's
 *   included. An open compares that counter with the marker's instead of
 *   re-hashing every doc; a missing trigger falls back to the full compare.
 * - Union shape: migration `20260929000000_t12535-docs-attachments-union-shape`
 *   adds the bare-only `display_alias` column and indexes; the UNIQUE slug and
 *   sha256 indexes are dropped and re-created by the merge itself around the
 *   row changes. Every merge ends with them in place, or rolls back.
 * - The `supersedes` / `superseded_by` self-FKs are checked at commit
 *   (`PRAGMA defer_foreign_keys`), so a chain merges in any row order.
 * - A bare row that violates a twin CHECK (e.g. a non-ISO `created_at`) fails
 *   the merge; the docs pair opens degraded (docs writes refused, everything
 *   else writable) and `cleo doctor twin-collapse` shows the cause.
 * - Blobs: after each merge every twin doc's blob gets a keep-link (and is
 *   restored from it if the older build unlinked it), see `blob-keep.ts`.
 * - Freeze (option (a), D11160): every merge installs BEFORE
 *   INSERT/UPDATE/DELETE triggers on the bare docs tables that abort an
 *   older build's write with the upgrade message ({@link docsFrozenMessage}).
 *   This build never writes them, so there is no bypass. Every open checks the freeze and change
 *   triggers and re-installs missing ones (a rebuild or restore drops them);
 *   `cleo doctor` reports them missing. The (b) defences above cover the time
 *   a freeze is missing.
 *
 * ## Contract
 *
 * 1. **Snapshot first** (initial collapse only, only when the merge changes
 *    the twin). The free space is checked before the `VACUUM INTO`. One
 *    snapshot covers every pair collapsing in this open, registered as a
 *    PINNED `migration` backup: `cleo backup list` shows it, rotation never
 *    deletes it, and a snapshot an earlier build wrote unpinned is pinned at
 *    the next open (`cleo doctor` lists an unpinned one).
 * 2. **Atomic.** Each pair merges, verifies and writes its marker in one
 *    `BEGIN IMMEDIATE` transaction, the marker re-read under the write lock.
 *    Any failure rolls back: both tables byte-identical.
 * 3. **Verified.** Every row the merge decided is re-read and compared before
 *    the marker is written; a mismatch rolls back.
 * 4. **The bare table is never written**, with one sanctioned exception:
 *    {@link mirrorCounterToBare}. When this build writes a counter key
 *    (`task_id_sequence`, `sqlite_snapshot_gate`, `file_meta`) it raises the
 *    bare row's counter field to the twin's in the same transaction, and the
 *    allocation floors on the bare counter ({@link bareCounterOf}). The
 *    2026.9.20 build still allocates ids from the bare counter; without the
 *    mirror, an id one build reserved but had not stored yet could be issued
 *    by the other.
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
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ExitCode } from '@cleocode/contracts';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { z } from 'zod';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';
import { getCleoVersion } from '../scaffold/ensure-config.js';
import { isPinnedBackup, pinBackup } from './backup-sidecar.js';
import { blobFileForRow, pinBlob, restoreBlob } from './blob-keep.js';
import { planMigrationSnapshot, writeMigrationSnapshot } from './pre-repair-snapshot.js';

const log = getLogger('twin-collapse');

/** Prefix of the marker key holding a pair's collapse state. */
export const TWIN_COLLAPSE_MARKER_PREFIX = 'twin_collapse:';

/** Prefix of the key recording a pair's last failed collapse. */
export const TWIN_COLLAPSE_FAILURE_PREFIX = 'twin_collapse_failed:';

/**
 * The snapshot gate's key (`SNAPSHOT_GATE_META_KEY` in `snapshot-gate.ts`),
 * spelled out: `snapshot-gate.ts` imports this module to mirror its counter,
 * so importing it back would be a cycle.
 */
const SNAPSHOT_GATE_KEY = 'sqlite_snapshot_gate';

/** `schema_meta` keys whose named field is a monotonic counter (merged as max). */
export const SCHEMA_META_COUNTER_FIELDS: Readonly<Record<string, string>> = {
  task_id_sequence: 'counter',
  [SNAPSHOT_GATE_KEY]: 'generation',
  file_meta: 'generation',
};

/** `schema_meta` keys never deleted from the twin (a counter never moves back). */
export const SCHEMA_META_NEVER_DELETED: ReadonlySet<string> = new Set([
  'task_id_sequence',
  SNAPSHOT_GATE_KEY,
]);

/** Why a twin-collapse snapshot is pinned (never rotated). */
const SNAPSHOT_PIN_REASON =
  'T12535 twin collapse: the store before the merge (only copy of any row it replaced)';

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
  /** Twin rows the initial collapse dropped (none since the union rule; kept for old markers). */
  readonly dropped: readonly string[];
  /** Keys (or sticky ids) both builds changed since the last merge; the twin was kept. */
  readonly conflicts: readonly string[];
  /** Docs: bare rows merged into the twin row holding the same content (`<bare id> -> <twin id>`). */
  readonly merged: readonly string[];
  /** Docs: rows carried under a free slug because another doc holds theirs. */
  readonly renamed: readonly string[];
  /**
   * Rows kept by the union rule: twin-only keys / sticky tags the initial
   * collapse carried over, and (docs) twin rows the bare side deleted that a
   * ref or link still names.
   */
  readonly kept: readonly string[];
  /** Keys whose replaced twin value was copied to `twin_collapse_archive:<key>`. */
  readonly archived: readonly string[];
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
  /** The pair's change counter at the last merge (see `TwinPair.changeSeq`). */
  readonly seq: string | null;
  /** Rows the last merge that carried anything merged by content or renamed. */
  readonly merged: readonly string[];
  readonly renamed: readonly string[];
  /** Twin-only rows the initial collapse carried over (union rule). */
  readonly kept: readonly string[];
  /** Keys whose replaced twin value the initial collapse archived. */
  readonly archived: readonly string[];
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
  /** Bare rows merged into another twin row by content (`<bare id> -> <twin id>`). */
  readonly merged: string[];
  /** Rows carried under another slug (`<id>: <slug> -> <new slug>`). */
  readonly renamed: string[];
  /**
   * Rows kept: twin-only rows the initial collapse carried over (union rule),
   * and (docs) twin rows the bare side deleted that something still names.
   */
  readonly kept: string[];
  /** Keys whose replaced twin value was copied to `twin_collapse_archive:<key>`. */
  readonly archived: string[];
  /** The bare→twin id aliases after this plan (docs only). */
  aliases?: Record<string, string>;
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
  /** The TEMP shadows `shadow` builds (default: the twin). */
  readonly shadows?: readonly string[];
  /**
   * A cheap token that changes whenever the bare side is written (a change
   * counter), or `undefined` when it cannot be trusted: the open then
   * compares full hashes.
   */
  changeSeq?(db: DatabaseSync): string | undefined;
  /** Work outside the database after a merge committed (best effort). */
  afterCommit?(db: DatabaseSync, plan: Plan, dbPath: string): void;
  /** Whether the pair's triggers on the bare tables are all in place. */
  guardsIntact?(db: DatabaseSync): boolean;
  /** Re-install those triggers (idempotent). */
  installGuards?(db: DatabaseSync): void;
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
    seq: typeof parsed.seq === 'string' ? parsed.seq : null,
    merged: Array.isArray(parsed.merged) ? parsed.merged : [],
    renamed: Array.isArray(parsed.renamed) ? parsed.renamed : [],
    kept: Array.isArray(parsed.kept) ? parsed.kept : [],
    archived: Array.isArray(parsed.archived) ? parsed.archived : [],
  };
}

/** Whether the bare side moved since the stored hashes (or no usable state exists). */
function bareChanged(db: DatabaseSync, pair: TwinPair, state: CollapseState | undefined): boolean {
  if (!state?.hashes) return true;
  if (state.seq !== null && pair.changeSeq !== undefined) {
    const seq = pair.changeSeq(db);
    if (seq !== undefined) return seq !== state.seq;
  }
  return !sameHashes(state.hashes.bare, pair.bareHashes(db));
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

/**
 * Raise the BARE `schema_meta` row of a counter key to the twin's counter,
 * right after this build wrote the twin row, on the same connection (so inside
 * the writer's transaction).
 *
 * The one sanctioned write to a bare table (T12535): the 2026.9.20 build still
 * allocates task ids from the bare `task_id_sequence` and reads the bare
 * snapshot-gate and `file_meta` generations. Without this, an id this build
 * reserved but has not stored yet (the counter is advanced before the task
 * row is inserted) could be issued again by the older build. Only the counter
 * field moves (the bare row keeps its other fields, see
 * {@link mergeSchemaMetaValue}); a missing bare row gets the twin value. A
 * non-counter key, or a store without the bare table, is left alone. The
 * collapse treats the resulting bare change like any other: a counter key is
 * never a conflict.
 *
 * @param db - The project `cleo.db` connection that wrote the twin row.
 * @param key - The `schema_meta` key just written.
 * @task T12535
 */
export function mirrorCounterToBare(db: DatabaseSync, key: string): void {
  if (SCHEMA_META_COUNTER_FIELDS[key] === undefined) return;
  if (!hasMainTable(db, 'schema_meta')) return;
  const twin = readKv(db, 'tasks_schema_meta', key);
  if (twin === undefined) return;
  const bare = readKv(db, 'schema_meta', key);
  const next = bare === undefined ? twin : mergeSchemaMetaValue(key, bare, twin);
  if (next === null || next === bare) return;
  writeKv(db, 'schema_meta', key, next);
}

/**
 * The counter of a key's BARE `schema_meta` row (the older build's), or 0.
 * This build's allocation floors on it, so an id the older build reserved but
 * has not stored yet is never issued here either.
 *
 * @param db - The project `cleo.db` connection.
 * @param key - A counter key.
 * @returns The bare counter field, or 0 when absent.
 * @task T12535
 */
export function bareCounterOf(db: DatabaseSync, key: string): number {
  const name = SCHEMA_META_COUNTER_FIELDS[key];
  if (name === undefined || !hasMainTable(db, 'schema_meta')) return 0;
  const bare = readKv(db, 'schema_meta', key);
  return (bare === undefined ? undefined : counterOf(bare, name)) ?? 0;
}

function kvRows(db: DatabaseSync, table: string, schema = 'main'): Map<string, string> {
  const rows = db.prepare(`SELECT key, value FROM ${schema}.${table}`).all() as Array<{
    key: string;
    value: string;
  }>;
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** Prefix of the key holding a twin value the initial collapse replaced. */
export const TWIN_COLLAPSE_ARCHIVE_PREFIX = 'twin_collapse_archive:';

/**
 * `focus_state` when both tables hold it: the bare value's current fields
 * win, and the session-note history is the union of both
 * (`sessionNotes`, deduplicated by `(timestamp, note)`, sorted by timestamp).
 * The twin may hold months of notes the bare copy never saw (178 KB on the
 * cleocode Linux store). A value that is not a JSON object stays the bare one
 * (the replaced twin value is archived either way).
 *
 * @param bare - The bare value.
 * @param twin - The twin value.
 * @returns The merged value.
 * @task T12535
 */
export function mergeFocusState(bare: string, twin: string): string {
  const b = parseJson(bare);
  const t = parseJson(twin);
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return bare;
  const notesOf = (v: unknown): unknown[] =>
    v !== null &&
    typeof v === 'object' &&
    Array.isArray((v as Record<string, unknown>).sessionNotes)
      ? ((v as Record<string, unknown>).sessionNotes as unknown[])
      : [];
  const bareNotes = notesOf(b);
  const twinNotes = notesOf(t);
  if (twinNotes.length === 0) return bare;
  const keyOf = (n: unknown): string => {
    const r = (n ?? {}) as Record<string, unknown>;
    return `${String(r.timestamp ?? '')}\u0000${String(r.note ?? JSON.stringify(n))}`;
  };
  const seen = new Set<string>();
  const union: unknown[] = [];
  for (const n of [...twinNotes, ...bareNotes]) {
    const k = keyOf(n);
    if (seen.has(k)) continue;
    seen.add(k);
    union.push(n);
  }
  const ts = (n: unknown): string => String(((n ?? {}) as Record<string, unknown>).timestamp ?? '');
  union.sort((x, y) => ts(x).localeCompare(ts(y)));
  return JSON.stringify({ ...(b as Record<string, unknown>), sessionNotes: union });
}

/** Carried rows of a `schema_meta` table. */
function carriedRows(db: DatabaseSync, table: string): Map<string, string> {
  const all = kvRows(db, table);
  for (const key of [...all.keys()]) if (!carried(key)) all.delete(key);
  return all;
}

const hashMap = (m: ReadonlyMap<string, string>): Record<string, string> =>
  Object.fromEntries([...m].map(([k, v]) => [k, sha(v)]));

const emptyPlan = (): Plan => ({
  set: new Map(),
  del: [],
  dropped: [],
  conflicts: [],
  skipped: 0,
  merged: [],
  renamed: [],
  kept: [],
  archived: [],
});

function planSchemaMeta(db: DatabaseSync, state: CollapseState | undefined): Plan {
  const plan = emptyPlan();
  const bare = carriedRows(db, 'schema_meta');
  const twin = carriedRows(db, 'tasks_schema_meta');
  const want = (key: string, value: string | null): void => {
    if (value !== null && value !== twin.get(key)) plan.set.set(key, value);
  };
  if (state === undefined) {
    if (bare.size === 0) return plan;
    for (const [key, value] of [...bare].sort(([a], [b]) => a.localeCompare(b))) {
      const current = twin.get(key);
      const merged =
        key === 'focus_state' && current !== undefined
          ? mergeFocusState(value, current)
          : mergeSchemaMetaValue(key, value, current);
      want(key, merged);
      // The twin's own value would be replaced: keep a copy of it, so nothing
      // unique is left only in the snapshot.
      if (current !== undefined && merged !== null && merged !== current) {
        plan.set.set(`${TWIN_COLLAPSE_ARCHIVE_PREFIX}${key}`, current);
        plan.archived.push(key);
      }
    }
    // The union rule: a key only the twin holds is carried over, never
    // dropped (listed as kept). The bare value wins every key both hold.
    for (const key of [...twin.keys()].sort()) if (!bare.has(key)) plan.kept.push(key);
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
    // The union rule: bare tags are added. A twin-only tag the note's
    // tags_json names is kept (listed as kept). One tags_json does not name is
    // listed as archived: the junction follows tags_json (the value both
    // builds write and every reader displays), so it leaves the junction, and
    // its row is recorded under `twin_collapse_archive:sticky_tags`.
    const tagsJson = db.prepare('SELECT tags_json FROM main.brain_sticky_notes WHERE id = ?');
    for (const id of [...new Set([...bare.keys(), ...twin.keys()])].sort()) {
      const b = new Set(bare.get(id) ?? []);
      const t = new Set(twin.get(id) ?? []);
      const alive = b.size === 0 || noteExists.get(id) !== undefined;
      for (const tag of b) {
        if (!alive) plan.skipped++;
        else if (!t.has(tag)) plan.set.set(`${id}\t${tag}`, '');
      }
      const named = new Set(
        tagsOf((tagsJson.get(id) as { tags_json: string | null } | undefined)?.tags_json ?? null),
      );
      for (const tag of t) {
        if (b.has(tag)) continue;
        if (named.has(tag)) plan.kept.push(`${id}\t${tag}`);
        else plan.archived.push(`${id}\t${tag}`);
      }
    }
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

/** A note's tags as the accessor reads `tags_json` (strings, non-empty, deduplicated). */
function tagsOf(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const parsed: unknown = JSON.parse(tagsJson);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((t): t is string => typeof t === 'string' && t.length > 0))];
  } catch {
    return [];
  }
}

/**
 * Make the junction in `schema` equal every note's `tags_json`.
 *
 * `tags_json` lives on the shared `brain_sticky_notes` row, which both builds
 * write together with their own junction; the junction is derived from it.
 * Recomputing it after every merge keeps the tag filter (the junction) and the
 * displayed tags (`tags_json`) from disagreeing when both builds retag one
 * note (the merge's twin-wins rule would otherwise keep a stale set).
 *
 * @returns Junction rows added and removed.
 */
function syncStickyJunction(
  db: DatabaseSync,
  schema: string,
): { inserted: number; deleted: number } {
  const notes = db.prepare('SELECT id, tags_json FROM main.brain_sticky_notes').all() as Array<{
    id: string;
    tags_json: string | null;
  }>;
  const have = new Map<string, Set<string>>();
  for (const r of db
    .prepare(`SELECT sticky_id, tag FROM ${schema}.brain_sticky_tags`)
    .all() as Array<{ sticky_id: string; tag: string }>) {
    const set = have.get(r.sticky_id) ?? new Set<string>();
    set.add(r.tag);
    have.set(r.sticky_id, set);
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${schema}.brain_sticky_tags (sticky_id, tag) VALUES (?, ?)`,
  );
  const del = db.prepare(`DELETE FROM ${schema}.brain_sticky_tags WHERE sticky_id = ? AND tag = ?`);
  let inserted = 0;
  let deleted = 0;
  for (const note of notes) {
    const want = new Set(tagsOf(note.tags_json));
    const current = have.get(note.id) ?? new Set<string>();
    for (const tag of want)
      if (!current.has(tag)) inserted += Number(insert.run(note.id, tag).changes);
    for (const tag of current) if (!want.has(tag)) deleted += Number(del.run(note.id, tag).changes);
  }
  return { inserted, deleted };
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
    if (plan.archived.length > 0) {
      const key = `${TWIN_COLLAPSE_ARCHIVE_PREFIX}sticky_tags`;
      const previous = parseJson(readKv(db, 'brain_schema_meta', key) ?? '[]');
      const rows = new Set([...(Array.isArray(previous) ? previous : []), ...plan.archived]);
      writeKv(db, 'brain_schema_meta', key, JSON.stringify([...rows].sort()));
    }
    const synced = syncStickyJunction(db, 'main');
    return {
      inserted: counts.inserted + synced.inserted,
      replaced: 0,
      deleted: counts.deleted + synced.deleted,
    };
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
    syncStickyJunction(db, 'temp');
  },
};

// ── attachments + attachment_refs (docs) ─────────────────────────────────────

/** Key of the bare→twin id aliases (bare rows merged into a twin row by sha256). */
export const DOCS_ALIAS_KEY = 'twin_collapse_alias:attachments';

/** Key the bare-side change triggers bump on every write to the bare docs tables. */
export const DOCS_CHANGE_SEQ_KEY = 'twin_collapse_seq:attachments';

/** The bare docs tables (the change triggers watch both). */
const DOCS_BARE = ['attachments', 'attachment_refs'] as const;

/** The docs twins (both shadowed in read-only-for-users mode). */
const DOCS_TWINS = ['docs_attachments', 'docs_attachment_refs'] as const;

/** Columns recomputed after every merge, never carried (a count of the refs). */
const DOCS_DERIVED: ReadonlySet<string> = new Set(['ref_count']);

/**
 * The UNIQUE indexes the docs code relies on (union shape with the bare table).
 * Dropped and re-created by every merge, inside its transaction.
 */
const DOCS_UNIQUE_INDEXES: ReadonlyArray<{ readonly name: string; readonly on: string }> = [
  { name: 'uniq_docs_attachments_slug', on: '(slug) WHERE slug IS NOT NULL' },
  { name: 'uniq_docs_attachments_sha256', on: '(sha256)' },
];

/** Column names of a table, in declaration order. */
function columnsOf(db: DatabaseSync, schema: string, table: string): string[] {
  return (
    db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Columns both tables hold, in the bare table's order, minus `skip`. */
function sharedColumns(
  db: DatabaseSync,
  bare: string,
  twin: string,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  const twinCols = new Set(columnsOf(db, 'main', twin));
  return columnsOf(db, 'main', bare).filter((c) => twinCols.has(c) && !skip.has(c));
}

/** The carried doc columns (`ref_count` is derived). */
const docColumns = (db: DatabaseSync): string[] =>
  sharedColumns(db, 'attachments', 'docs_attachments', DOCS_DERIVED);

/** The carried ref columns. */
const refColumns = (db: DatabaseSync): string[] =>
  sharedColumns(db, 'attachment_refs', 'docs_attachment_refs');

/** One row: the JSON of its carried columns (hash and upsert payload) and its values. */
interface CarriedRow {
  readonly json: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** Rows of a table keyed by the JSON of `key` columns (or the bare id for docs). */
function carriedRowsOf(
  db: DatabaseSync,
  schema: string,
  table: string,
  columns: readonly string[],
  key: readonly string[],
): Map<string, CarriedRow> {
  const rows = db
    .prepare(`SELECT ${columns.map(quoteIdent).join(', ')} FROM ${schema}.${quoteIdent(table)}`)
    .all() as Array<Record<string, unknown>>;
  return new Map(
    rows.map((r) => [
      key.length === 1 ? String(r[key[0] as string]) : JSON.stringify(key.map((k) => r[k])),
      { json: JSON.stringify(columns.map((c) => r[c] ?? null)), values: r },
    ]),
  );
}

const REF_KEY = ['attachment_id', 'owner_type', 'owner_id'] as const;

/** Docs (`d:<id>`) and refs (`r:<key>`) of one side. */
function docsSide(
  db: DatabaseSync,
  side: 'bare' | 'twin',
): { docs: Map<string, CarriedRow>; refs: Map<string, CarriedRow> } {
  const [docTable, refTable] = side === 'bare' ? DOCS_BARE : DOCS_TWINS;
  return {
    docs: carriedRowsOf(db, 'main', docTable, docColumns(db), ['id']),
    refs: carriedRowsOf(db, 'main', refTable, refColumns(db), REF_KEY),
  };
}

function docsHashes(db: DatabaseSync, side: 'bare' | 'twin'): Record<string, string> {
  const { docs, refs } = docsSide(db, side);
  return Object.fromEntries([
    ...[...docs].map(([k, v]) => [`d:${k}`, sha(v.json)]),
    ...[...refs].map(([k, v]) => [`r:${k}`, sha(v.json)]),
  ]);
}

function readAliases(db: DatabaseSync): Record<string, string> {
  const raw = readKv(db, 'tasks_schema_meta', DOCS_ALIAS_KEY);
  if (raw === undefined) return {};
  const parsed = parseJson(raw);
  return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
}

/** The change-trigger name for one bare table and operation. */
const trackTrigger = (table: string, op: string): string =>
  `t12535_track_${table}_${op.toLowerCase()}`;

/**
 * AFTER triggers on the bare docs tables that bump {@link DOCS_CHANGE_SEQ_KEY}.
 * They fire for every writer, the older build included, so an open detects an
 * unchanged bare side by reading one row instead of re-hashing every doc.
 */
function ensureDocsTracking(db: DatabaseSync): void {
  for (const table of DOCS_BARE) {
    for (const op of SHADOW_WRITE_OPS) {
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS main.${trackTrigger(table, op)} AFTER ${op} ON ${table} BEGIN ` +
          `INSERT OR IGNORE INTO tasks_schema_meta (key, value) VALUES ('${DOCS_CHANGE_SEQ_KEY}', '0'); ` +
          `UPDATE tasks_schema_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = '${DOCS_CHANGE_SEQ_KEY}'; END`,
      );
    }
  }
}

/** The freeze-trigger name for one bare table and operation. */
const freezeTrigger = (table: string, op: string): string =>
  `t12535_freeze_${table}_${op.toLowerCase()}`;

/** Every freeze and change trigger the docs pair keeps on the bare tables. */
const docsGuardTriggers = (): string[] =>
  DOCS_BARE.flatMap((t) =>
    SHADOW_WRITE_OPS.flatMap((op) => [freezeTrigger(t, op), trackTrigger(t, op)]),
  );

/**
 * The message an older build's write to a frozen bare docs table aborts with.
 * It names the release that moved the docs, what fails (docs, changesets, and
 * the IVTR playbook provenance an older build attaches when a playbook run
 * finalises), and the upgrade command.
 *
 * It must never read as contention or corruption to an older build: those
 * retry on `sqlite_busy` / `database is locked` and restore backups on
 * `database disk image is malformed`, so none of those words appear (pinned by
 * a test, see {@link DOCS_FROZEN_FORBIDDEN}).
 */
export function docsFrozenMessage(version: string | null): string {
  const needs = version === null ? 'the latest cleo' : `cleo ${version} or newer`;
  return (
    `CLEO: docs moved to docs_attachments (T12535); this project needs ${needs} ` +
    'to write docs, changesets and IVTR playbook provenance. ' +
    'Run: npm i -g @cleocode/cleo@latest'
  );
}

/** Key recording the version of the build that first froze this store's bare docs tables. */
export const DOCS_FROZEN_BY_KEY = 'twin_collapse_frozen_by:attachments';

/**
 * The version the freeze message names: the first RELEASE build that froze
 * (or later opened) this store, recorded under {@link DOCS_FROZEN_BY_KEY}.
 *
 * Why recorded, not a literal: the release that ships the freeze was not
 * known when the code was written (2026.9.23 shipped without it). Why not the
 * running build's version: a trigger outlives the build that wrote it, and a
 * development build (a worktree, or the main checkout) reports the PREVIOUS
 * release's version, which cannot read the store. So only a published build
 * (running from an installed package, i.e. under `node_modules`) records its
 * version, and never the unreadable `0.0.0` fallback. Until one does, the
 * message names no version and points at `@latest`; the first release build
 * to open the store records itself and the triggers are re-written.
 *
 * @param db - The project `cleo.db` connection.
 * @returns The version to name, or `null` (no release build has frozen or
 *   opened this store yet).
 * @task T12535
 */
export function docsFrozenVersion(db: DatabaseSync): string | null {
  const recorded = readKv(db, 'tasks_schema_meta', DOCS_FROZEN_BY_KEY);
  if (recorded !== undefined) return recorded.replace(/[^0-9A-Za-z.+-]/g, '');
  return releaseBuildVersion();
}

/** Test hook: what this process counts as (a published build, and its version). */
let freezeBuildOverride: { published: boolean; version: string } | undefined;

/**
 * Test only: make this process count as a published build with `version`
 * (or restore the real detection with `undefined`).
 *
 * @param override - The build to pretend to be.
 * @task T12535
 */
export function setFreezeBuildForTests(
  override: { published: boolean; version: string } | undefined,
): void {
  freezeBuildOverride = override;
}

/**
 * This build's version when it is a published release, else `null`: running
 * from an installed package (under `node_modules`) with a real version.
 */
function releaseBuildVersion(): string | null {
  const published =
    freezeBuildOverride?.published ??
    fileURLToPath(import.meta.url)
      .split(/[\\/]/)
      .includes('node_modules');
  if (!published) return null;
  const version = (freezeBuildOverride?.version ?? getCleoVersion()).replace(
    /[^0-9A-Za-z.+-]/g,
    '',
  );
  return /^\d+\.\d+\.\d+/.test(version) && version !== '0.0.0' ? version : null;
}

/** Phrases the freeze message must never contain (older builds' retry and recovery matchers). */
export const DOCS_FROZEN_FORBIDDEN: readonly string[] = [
  'sqlite_busy',
  'database is locked',
  'database disk image is malformed',
  'malformed',
  'corrupt',
  'not a database',
];

/**
 * BEFORE INSERT/UPDATE/DELETE triggers on the bare docs tables that abort
 * every write with {@link docsFrozenMessage} (option (a), owner decision
 * D11160). SQLite enforces them whatever build writes, so the 2026.9.20 build
 * can no longer write rows this build treats as frozen: no duplicate content
 * or slug, no split ref counts, no stale-read deletes, no ADR number reuse.
 * Its reads keep working (they show the frozen docs).
 *
 * There is no bypass: this build never writes the bare tables. A migration
 * that rebuilds or drops them is not affected (DDL does not fire DML triggers;
 * the triggers go with a renamed or dropped table and are re-installed at the
 * next open, see {@link repairGuards}).
 */
function ensureDocsFreeze(db: DatabaseSync): void {
  if (readKv(db, 'tasks_schema_meta', DOCS_FROZEN_BY_KEY) === undefined) {
    const version = releaseBuildVersion();
    if (version !== null) writeKv(db, 'tasks_schema_meta', DOCS_FROZEN_BY_KEY, version);
  }
  for (const table of DOCS_BARE) {
    for (const op of SHADOW_WRITE_OPS) {
      const name = freezeTrigger(table, op);
      // A trigger with another text (an older message or version) is replaced.
      if (freezeSql(db, name) !== undefined && !freezeUpToDate(db, table, op))
        db.exec(`DROP TRIGGER main.${name}`);
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS main.${name} BEFORE ${op} ON ${table} ` +
          `BEGIN ${freezeBody(db)} END`,
      );
    }
  }
}

/** The freeze trigger's body (it carries the message). */
const freezeBody = (db: DatabaseSync): string =>
  `SELECT RAISE(ABORT, '${docsFrozenMessage(docsFrozenVersion(db)).replace(/'/g, "''")}');`;

/** The stored SQL of a trigger, or `undefined` when it does not exist. */
function freezeSql(db: DatabaseSync, name: string): string | undefined {
  return (
    db
      .prepare("SELECT sql FROM main.sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(name) as { sql: string } | undefined
  )?.sql;
}

/** Whether a freeze trigger exists with the current table, event and message. */
function freezeUpToDate(db: DatabaseSync, table: string, op: string): boolean {
  const sql = freezeSql(db, freezeTrigger(table, op));
  return sql?.includes(`BEFORE ${op} ON ${table} `) === true && sql.includes(freezeBody(db));
}

/** Whether every freeze and change trigger is in place. */
function docsGuardsIntact(db: DatabaseSync): boolean {
  const names = docsGuardTriggers();
  const present = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM main.sqlite_master WHERE type = 'trigger' AND name IN (${names.map(() => '?').join(', ')})`,
      )
      .get(...names) as { n: number }
  ).n;
  if (present !== names.length) return false;
  return DOCS_BARE.every((t) => SHADOW_WRITE_OPS.every((op) => freezeUpToDate(db, t, op)));
}

/** Install the freeze and change triggers (idempotent). */
function ensureDocsGuards(db: DatabaseSync): void {
  ensureDocsFreeze(db);
  ensureDocsTracking(db);
}

/** The bare side's change counter, or `undefined` when a change trigger is missing. */
function docsChangeSeq(db: DatabaseSync): string | undefined {
  const names = DOCS_BARE.flatMap((t) => SHADOW_WRITE_OPS.map((op) => trackTrigger(t, op)));
  const present = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM main.sqlite_master WHERE type = 'trigger' AND name IN (${names.map(() => '?').join(', ')})`,
      )
      .get(...names) as { n: number }
  ).n;
  if (present !== names.length) return undefined;
  return readKv(db, 'tasks_schema_meta', DOCS_CHANGE_SEQ_KEY) ?? '0';
}

/** The first `<slug>-<n>` (n ≥ 2) no other twin row holds. */
function freeSlug(slug: string, owners: ReadonlyMap<string, string>, id: string): string {
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    const holder = owners.get(candidate);
    if (holder === undefined || holder === id) return candidate;
  }
}

/**
 * The initial docs collapse: a union that never drops content.
 *
 * - A row whose id the bare table has: the bare row is authoritative. When the
 *   twin's row under that id holds DIFFERENT bytes, the twin's version is
 *   kept as its own row `<id>~twin-<sha8>` (no slug, superseded by the bare
 *   row) and listed as merged, so no content leaves the twins (unless those
 *   bytes are already another row's). A metadata-only difference (same sha256)
 *   goes to the bare row.
 * - A twin-only row whose sha256 a bare row (or an earlier kept twin-only
 *   row) holds, i.e. the same content under another id: merged into that row
 *   (listed as merged), its refs and any supersedes link moved onto it.
 * - Any other twin-only row: kept under its own id. When a bare row holds its
 *   slug, the bare (live) doc keeps the slug and this one is carried as
 *   `<slug>-<n>` (listed as renamed).
 * - Refs: every bare ref and every twin ref (remapped onto merged ids) is kept.
 */
function planInitialDocs(
  db: DatabaseSync,
  plan: Plan,
  bare: { docs: Map<string, CarriedRow>; refs: Map<string, CarriedRow> },
  twin: { docs: Map<string, CarriedRow>; refs: Map<string, CarriedRow> },
): Plan {
  const columns = docColumns(db);
  const refCols = refColumns(db);
  const idAt = refCols.indexOf('attachment_id');
  const bareBySha = new Map<string, string>();
  const slugOwner = new Map<string, string>();
  for (const [id, row] of bare.docs) {
    bareBySha.set(String(row.values.sha256), id);
    if (typeof row.values.slug === 'string') slugOwner.set(row.values.slug, id);
  }
  for (const [id, row] of bare.docs)
    if (twin.docs.get(id)?.json !== row.json) plan.set.set(`d:${id}`, row.json);
  // An id both tables hold with DIFFERENT content: the bare row wins the id,
  // and the twin's version is kept as its own row (`<id>~twin-<sha8>`,
  // superseded by the bare row, no slug), so its bytes stay referenced and
  // visible. Same content (only metadata differs): the bare row wins.
  for (const [id, row] of bare.docs) {
    const twinRow = twin.docs.get(id);
    if (twinRow === undefined) continue;
    const content = String(twinRow.values.sha256);
    if (content === String(row.values.sha256)) continue;
    const owner = bareBySha.get(content);
    if (owner !== undefined) {
      plan.merged.push(`${id} (twin version) -> ${owner}`);
      continue;
    }
    const archiveId = `${id}~twin-${content.slice(0, 8)}`;
    const values: Record<string, unknown> = {
      ...twinRow.values,
      id: archiveId,
      slug: null,
      lifecycle_status: 'superseded',
      superseded_by: id,
    };
    plan.set.set(`d:${archiveId}`, JSON.stringify(columns.map((c) => values[c] ?? null)));
    plan.merged.push(`${id} (twin version) -> ${archiveId}`);
    bareBySha.set(content, archiveId);
  }
  // Twin-only rows: merge same-content duplicates into the bare row, keep the rest.
  const mergedInto = new Map<string, string>();
  const kept: string[] = [];
  for (const id of [...twin.docs.keys()].sort()) {
    if (bare.docs.has(id)) continue;
    const row = twin.docs.get(id) as CarriedRow;
    const content = String(row.values.sha256);
    // The same content in a bare row, or in a twin-only row kept already
    // (a frozen twin had no UNIQUE sha256 index).
    const owner = bareBySha.get(content);
    if (owner !== undefined) {
      mergedInto.set(id, owner);
      plan.del.push(`d:${id}`);
      plan.merged.push(`${id} -> ${owner}`);
    } else {
      bareBySha.set(content, id);
      kept.push(id);
    }
  }
  for (const id of kept) {
    const row = twin.docs.get(id) as CarriedRow;
    const values: Record<string, unknown> = { ...row.values };
    let changed = false;
    if (typeof values.slug === 'string') {
      const holder = slugOwner.get(values.slug);
      if (holder !== undefined && holder !== id) {
        const next = freeSlug(values.slug, slugOwner, id);
        plan.renamed.push(`${id}: ${values.slug} -> ${next}`);
        values.slug = next;
        changed = true;
      }
      slugOwner.set(values.slug as string, id);
    }
    for (const col of ['supersedes', 'superseded_by']) {
      const target = values[col];
      if (typeof target === 'string' && mergedInto.has(target)) {
        values[col] = mergedInto.get(target);
        changed = true;
      }
    }
    if (changed) plan.set.set(`d:${id}`, JSON.stringify(columns.map((c) => values[c] ?? null)));
  }
  // Refs: the union, twin refs remapped onto merged ids.
  for (const [key, row] of bare.refs)
    if (twin.refs.get(key)?.json !== row.json) plan.set.set(`r:${key}`, row.json);
  for (const [key, row] of twin.refs) {
    const [attachmentId, ownerType, ownerId] = JSON.parse(key) as [string, string, string];
    const target = mergedInto.get(attachmentId);
    if (target === undefined) continue; // kept as it is
    plan.del.push(`r:${key}`);
    const moved = JSON.stringify([target, ownerType, ownerId]);
    if (bare.refs.has(moved) || plan.set.has(`r:${moved}`)) continue;
    const values = JSON.parse(row.json) as unknown[];
    values[idAt] = target;
    plan.set.set(`r:${moved}`, JSON.stringify(values));
  }
  return plan;
}

/**
 * Plan the docs merge. Keys: `d:<twin id>` (doc rows) and `r:<JSON key>` (refs).
 *
 * Initial collapse, a union that never drops content ({@link planInitialDocs}):
 * bare rows are authoritative for their ids; twin-only rows are kept (on the
 * live cleocode store they are the whole docs history before 2026-06-03: ADRs,
 * specs, research, with live task refs), except a twin-only row whose content
 * a bare row holds, which is merged into that bare row; refs are united.
 *
 * Incremental re-merge, per bare doc whose row hash moved since the last merge
 * (its id translated through the aliases):
 * - twin row changed too → conflict, the twin wins;
 * - bare row gone → the twin row is deleted unless a ref (from either build)
 *   or a supersedes link still names it;
 * - the content (sha256) is another twin row's → no new row: the bare id is
 *   aliased to that row, and its refs follow it;
 * - the slug is another twin row's → the doc is carried under `<slug>-<n>`
 *   (listed as renamed);
 * - otherwise the bare row is upserted.
 * Per bare ref whose hash moved: an added ref is added (under the aliased id)
 * unless the twin has it or its doc is gone; a removed ref is removed unless
 * this build changed it since.
 */
function planDocs(db: DatabaseSync, state: CollapseState | undefined): Plan {
  const plan = emptyPlan();
  const bare = docsSide(db, 'bare');
  const twin = docsSide(db, 'twin');
  if (state === undefined) return planInitialDocs(db, plan, bare, twin);

  const last = lastHashes(db, DOCS, state);
  const aliases = { ...readAliases(db) };
  plan.aliases = aliases;
  const hashOf = (row: CarriedRow | undefined): string => (row ? sha(row.json) : ABSENT);
  const columns = docColumns(db);
  const deletions: string[] = [];
  const candidates: Array<{ b: string; x: string; twinRow: CarriedRow | undefined }> = [];
  const lastBareDocs = Object.keys(last.bare)
    .filter((k) => k.startsWith('d:'))
    .map((k) => k.slice(2));
  for (const b of [...new Set([...bare.docs.keys(), ...lastBareDocs])].sort()) {
    const bareRow = bare.docs.get(b);
    if (hashOf(bareRow) === (last.bare[`d:${b}`] ?? ABSENT)) continue;
    const x = aliases[b] ?? b;
    const twinRow = twin.docs.get(x);
    if (hashOf(twinRow) !== (last.twin[`d:${x}`] ?? ABSENT)) {
      plan.conflicts.push(JSON.stringify([b]));
      continue;
    }
    if (bareRow === undefined) {
      if (twinRow !== undefined) deletions.push(x);
    } else {
      candidates.push({ b, x, twinRow });
    }
  }
  // Natural keys are checked against the state AFTER the merge: twin rows the
  // merge does not touch, plus the carried rows (so two docs swapping a slug
  // do not collide with each other's old values).
  const moving = new Set([...deletions, ...candidates.map((c) => c.x)]);
  const shaOwner = new Map<string, string>();
  const slugOwner = new Map<string, string>();
  for (const [id, row] of twin.docs) {
    if (moving.has(id)) continue;
    shaOwner.set(String(row.values.sha256), id);
    if (typeof row.values.slug === 'string') slugOwner.set(row.values.slug, id);
  }
  for (const { b, x, twinRow } of candidates) {
    const values: Record<string, unknown> = { ...(bare.docs.get(b)?.values ?? {}), id: x };
    const content = String(values.sha256);
    const holder = shaOwner.get(content);
    if (holder !== undefined && holder !== x) {
      if (twinRow === undefined) {
        aliases[b] = holder;
        plan.merged.push(`${b} -> ${holder}`);
      } else {
        plan.conflicts.push(JSON.stringify([b]));
        // The twin row stays as it is: keep its keys owned.
        shaOwner.set(String(twinRow.values.sha256), x);
        if (typeof twinRow.values.slug === 'string') slugOwner.set(twinRow.values.slug, x);
      }
      continue;
    }
    if (typeof values.slug === 'string') {
      const slugHolder = slugOwner.get(values.slug);
      if (slugHolder !== undefined && slugHolder !== x) {
        const next = freeSlug(values.slug, slugOwner, x);
        plan.renamed.push(`${b}: ${values.slug} -> ${next}`);
        values.slug = next;
      }
    }
    shaOwner.set(content, x);
    if (typeof values.slug === 'string') slugOwner.set(values.slug, x);
    const json = JSON.stringify(columns.map((c) => values[c] ?? null));
    if (twinRow?.json !== json) plan.set.set(`d:${x}`, json);
  }

  const refCols = refColumns(db);
  const idAt = refCols.indexOf('attachment_id');
  const lastBareRefs = Object.keys(last.bare)
    .filter((k) => k.startsWith('r:'))
    .map((k) => k.slice(2));
  const docGoing = new Set(deletions);
  const docExists = (id: string): boolean =>
    (twin.docs.has(id) && !docGoing.has(id)) || plan.set.has(`d:${id}`);
  for (const key of [...new Set([...bare.refs.keys(), ...lastBareRefs])].sort()) {
    const bareRef = bare.refs.get(key);
    if (hashOf(bareRef) === (last.bare[`r:${key}`] ?? ABSENT)) continue;
    const [attachmentId, ownerType, ownerId] = JSON.parse(key) as [string, string, string];
    const target = aliases[attachmentId] ?? attachmentId;
    const twinKey = JSON.stringify([target, ownerType, ownerId]);
    const twinRef = twin.refs.get(twinKey);
    if (bareRef !== undefined) {
      if (twinRef !== undefined) continue; // the twin already holds this ref
      if (!docExists(target)) {
        plan.skipped++;
        continue;
      }
      const values = JSON.parse(bareRef.json) as unknown[];
      values[idAt] = target;
      plan.set.set(`r:${twinKey}`, JSON.stringify(values));
    } else if (twinRef !== undefined && hashOf(twinRef) === (last.twin[`r:${twinKey}`] ?? ABSENT)) {
      plan.del.push(`r:${twinKey}`);
    }
  }

  // A doc row goes only when nothing names it any more.
  const refsAfter = new Map<string, number>();
  for (const [key] of twin.refs) {
    if (plan.del.includes(`r:${key}`)) continue;
    const id = (JSON.parse(key) as string[])[0] as string;
    refsAfter.set(id, (refsAfter.get(id) ?? 0) + 1);
  }
  for (const key of plan.set.keys()) {
    if (!key.startsWith('r:')) continue;
    const id = (JSON.parse(key.slice(2)) as string[])[0] as string;
    refsAfter.set(id, (refsAfter.get(id) ?? 0) + 1);
  }
  const linked = new Set<string>();
  for (const [id, row] of twin.docs) {
    if (docGoing.has(id)) continue;
    for (const col of ['supersedes', 'superseded_by']) {
      const v = row.values[col];
      if (typeof v === 'string') linked.add(v);
    }
  }
  for (const id of deletions) {
    if ((refsAfter.get(id) ?? 0) > 0 || linked.has(id)) plan.kept.push(id);
    else plan.del.push(`d:${id}`);
  }
  return plan;
}

/** Apply a docs plan to `schema` (`main`, or `temp` for the shadows). */
function applyDocs(
  db: DatabaseSync,
  schema: string,
  plan: Plan,
): { inserted: number; replaced: number; deleted: number } {
  const docCols = docColumns(db);
  const refCols = refColumns(db);
  const [docs, refs] = DOCS_TWINS;
  const before = new Set(
    (db.prepare(`SELECT id FROM ${schema}.${docs}`).all() as Array<{ id: string }>).map(
      (r) => r.id,
    ),
  );
  const refsBefore = new Set(
    (
      db
        .prepare(`SELECT attachment_id, owner_type, owner_id FROM ${schema}.${refs}`)
        .all() as Array<Record<string, unknown>>
    ).map((r) => JSON.stringify(REF_KEY.map((k) => r[k]))),
  );
  const upsert = (table: string, cols: readonly string[], key: readonly string[]) =>
    db.prepare(
      `INSERT INTO ${schema}.${table} (${cols.map(quoteIdent).join(', ')}) ` +
        `VALUES (${cols.map(() => '?').join(', ')}) ` +
        `ON CONFLICT(${key.map(quoteIdent).join(', ')}) DO UPDATE SET ` +
        cols
          .filter((c) => !key.includes(c))
          .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
          .join(', '),
    );
  const upsertDoc = upsert(docs, docCols, ['id']);
  const upsertRef = upsert(refs, refCols, REF_KEY);
  const delDoc = db.prepare(`DELETE FROM ${schema}.${docs} WHERE id = ?`);
  const delRef = db.prepare(
    `DELETE FROM ${schema}.${refs} WHERE attachment_id = ? AND owner_type = ? AND owner_id = ?`,
  );
  let inserted = 0;
  let replaced = 0;
  let deleted = 0;
  const params = (json: string) => JSON.parse(json) as Array<string | number | null>;
  for (const key of plan.del)
    if (key.startsWith('r:')) deleted += Number(delRef.run(...params(key.slice(2))).changes);
  for (const key of plan.del)
    if (key.startsWith('d:')) deleted += Number(delDoc.run(key.slice(2)).changes);
  for (const [key, json] of plan.set) {
    if (!key.startsWith('d:')) continue;
    upsertDoc.run(...params(json));
    if (before.has(key.slice(2))) replaced++;
    else inserted++;
  }
  for (const [key, json] of plan.set) {
    if (!key.startsWith('r:')) continue;
    upsertRef.run(...params(json));
    if (refsBefore.has(key.slice(2))) replaced++;
    else inserted++;
  }
  // `ref_count` is derived: the number of refs, whoever wrote them.
  db.exec(
    `UPDATE ${schema}.${docs} SET ref_count = ` +
      `(SELECT COUNT(*) FROM ${schema}.${refs} r WHERE r.attachment_id = ${docs}.id) ` +
      `WHERE ref_count IS NOT (SELECT COUNT(*) FROM ${schema}.${refs} r WHERE r.attachment_id = ${docs}.id)`,
  );
  return { inserted, replaced, deleted };
}

/**
 * `attachments` + `attachment_refs` → `docs_attachments` + `docs_attachment_refs`,
 * merged as ONE pair in one transaction: a doc and its refs never diverge, and
 * `ref_count` is recomputed from the merged refs (never carried). See
 * {@link planDocs} for the rules. Every merge ends with the UNIQUE `slug` and
 * `sha256` indexes in place and the bare-side change triggers installed; after
 * the commit, every twin doc's blob is pinned (and restored if an older build
 * deleted it, see `blob-keep.ts`).
 */
const DOCS: TwinPair = {
  table: 'attachments',
  twin: 'docs_attachments',
  kvTable: 'tasks_schema_meta',
  tables: [...DOCS_BARE, ...DOCS_TWINS, 'tasks_schema_meta'],
  shadows: DOCS_TWINS,
  bareHashes: (db) => docsHashes(db, 'bare'),
  twinHashes: (db) => docsHashes(db, 'twin'),
  changeSeq: docsChangeSeq,
  guardsIntact: docsGuardsIntact,
  installGuards: ensureDocsGuards,
  plan: planDocs,
  apply(db, plan) {
    // Rows may reference each other (self foreign keys); check at COMMIT.
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const index of DOCS_UNIQUE_INDEXES)
      db.exec(`DROP INDEX IF EXISTS main.${quoteIdent(index.name)}`);
    const counts = applyDocs(db, 'main', plan);
    for (const index of DOCS_UNIQUE_INDEXES)
      db.exec(`CREATE UNIQUE INDEX main.${quoteIdent(index.name)} ON docs_attachments ${index.on}`);
    if (plan.aliases !== undefined)
      writeKv(db, 'tasks_schema_meta', DOCS_ALIAS_KEY, JSON.stringify(plan.aliases));
    ensureDocsGuards(db);
    const after = docsSide(db, 'twin');
    for (const [key, json] of plan.set) {
      const got = key.startsWith('d:')
        ? after.docs.get(key.slice(2))?.json
        : after.refs.get(key.slice(2))?.json;
      if (got !== json) throw new Error(`attachments collapse did not verify for ${key}`);
    }
    for (const key of plan.del) {
      const present = key.startsWith('d:')
        ? after.docs.has(key.slice(2))
        : after.refs.has(key.slice(2));
      if (present) throw new Error(`attachments collapse did not verify the removal of ${key}`);
    }
    return counts;
  },
  shadow(db, plan) {
    const keys: Record<string, readonly string[]> = {
      docs_attachments: ['id'],
      docs_attachment_refs: REF_KEY,
    };
    for (const twin of DOCS_TWINS) {
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${twin} AS SELECT * FROM main.${twin} WHERE 0`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS temp.${quoteIdent(`${twin}_shadow_key`)} ` +
          `ON ${twin} (${(keys[twin] ?? []).map(quoteIdent).join(', ')})`,
      );
      db.exec(`DELETE FROM temp.${twin}`);
      db.exec(`INSERT INTO temp.${twin} SELECT * FROM main.${twin}`);
    }
    applyDocs(db, 'temp', plan);
  },
  afterCommit(db, _plan, dbPath) {
    const cleoDir = dirname(dbPath);
    const rows = db
      .prepare('SELECT sha256, attachment_json FROM main.docs_attachments')
      .all() as Array<{ sha256: string; attachment_json: string }>;
    for (const row of rows) {
      const primary = blobFileForRow(cleoDir, row.sha256, row.attachment_json);
      if (primary === null) continue;
      restoreBlob(cleoDir, row.sha256, primary);
      pinBlob(cleoDir, row.sha256, primary);
    }
  },
};

/** The pairs this build collapses, in order. */
const PAIRS: readonly TwinPair[] = [SCHEMA_META, STICKY_TAGS, DOCS];

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
 * Refuse a write before its first statement when the collapse of the table it
 * writes failed. The write accessors of the collapsed tables
 * (`tasks_schema_meta`, sticky notes and tags, the docs tables) call it at
 * entry, so a degraded store never takes a partial write (e.g. a sticky's
 * `tags_json` without its tag rows). Only the failed pairs are blocked: a
 * docs merge failure leaves task and sticky writes alone. The shadows' TEMP
 * triggers stay as the backstop.
 *
 * @param handle - The connection the write would use: the native
 *   `DatabaseSync`, or a drizzle instance (its `$client` is checked).
 *   `null`/`undefined` (no bound handle) is not checked.
 * @param table - The bare table whose pair the write belongs to.
 * @throws {CleoError} `E_TWIN_COLLAPSE_FAILED` when that pair's collapse failed.
 * @task T12535
 */
export function assertTwinCollapseWritable(
  handle: DatabaseSync | NodeSQLiteDatabase | null | undefined,
  table: TwinCollapseTable,
): void {
  if (!handle) return;
  const native = '$client' in handle ? handle.$client : handle;
  if (typeof native !== 'object' || native === null) return;
  const failure = degraded.get(native);
  if (failure?.tables.includes(table)) throw twinCollapseError(failure);
}

/** The bare tables a failed collapse can block writes for. */
export type TwinCollapseTable = 'schema_meta' | 'sticky_tags' | 'attachments';

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
  const snapshotProblem = failure.cause.startsWith(SNAPSHOT_FAILURE_PREFIX);
  return new CleoError(
    ExitCode.TWIN_COLLAPSE_FAILED,
    `Twin collapse of ${failure.tables.join(', ')} failed (both tables unchanged; reads still ` +
      `work, writes to them are refused): ${failure.cause}.${where}${space} ` +
      "Run 'cleo doctor twin-collapse'.",
    {
      fix: snapshotProblem
        ? 'The snapshot could not be written: free the space or make .cleo/backups/sqlite ' +
          "writable, then run 'cleo doctor twin-collapse --retry'."
        : 'The merge rejected a row of the bare table (the cause names the constraint, e.g. a ' +
          "CHECK or UNIQUE). Fix or remove that row, then run 'cleo doctor twin-collapse --retry'; " +
          "'cleo doctor twin-collapse' shows the details.",
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

/** Cause prefix of a failure to write the snapshot (before any merge). */
const SNAPSHOT_FAILURE_PREFIX = 'snapshot not written: ';

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
  for (const pair of PAIRS)
    for (const shadow of pair.shadows ?? [pair.twin])
      db.exec(`DROP TABLE IF EXISTS temp.${shadow}`);
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
    merged: [],
    renamed: [],
    kept: [],
    archived: [],
  };
}

/** Run one pair's merge in its own transaction. */
function collapsePair(
  db: DatabaseSync,
  pair: TwinPair,
  snapshotPath: string | null,
  dbPath: string,
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
      kept: state === undefined ? plan.kept.slice(0, MAX_CONFLICTS) : state.kept,
      archived: state === undefined ? plan.archived : state.archived,
      conflicts: plan.conflicts.slice(0, MAX_CONFLICTS),
      conflictsAt: plan.conflicts.length > 0 ? now : null,
      seq: pair.changeSeq?.(db) ?? null,
      merged: plan.merged.slice(0, MAX_CONFLICTS),
      renamed: plan.renamed.slice(0, MAX_CONFLICTS),
    };
    writeKv(db, pair.kvTable, `${TWIN_COLLAPSE_MARKER_PREFIX}${pair.table}`, JSON.stringify(next));
    db.prepare(`DELETE FROM main.${pair.kvTable} WHERE key = ?`).run(
      `${TWIN_COLLAPSE_FAILURE_PREFIX}${pair.table}`,
    );
    db.exec('COMMIT');
    try {
      pair.afterCommit?.(db, plan, dbPath);
    } catch (error) {
      log.warn({ err: error }, `after-merge work for ${pair.table} failed (T12535)`);
    }
    const done: TwinCollapseReceipt = {
      ...receipt(pair, state === undefined ? 'initial' : 'incremental', next.snapshot),
      ...counts,
      skipped: plan.skipped,
      dropped: plan.dropped,
      conflicts: plan.conflicts,
      merged: plan.merged,
      renamed: plan.renamed,
      kept: plan.kept,
      archived: plan.archived,
    };
    if (counts.inserted + counts.replaced + counts.deleted > 0 || plan.conflicts.length > 0)
      log.warn(done, `carried bare ${pair.table} into ${pair.twin} (${done.status}, T12535)`);
    return done;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Re-install a collapsed pair's bare-table triggers when something removed
 * them (a table rebuild, a restore, a journal probe that skipped a migration:
 * the T12541 class). One `sqlite_master` read per open; a write only when a
 * trigger is missing. Best effort: a failure is logged and `cleo doctor`
 * reports the missing triggers.
 */
function repairGuards(db: DatabaseSync, pair: TwinPair): void {
  if (!pair.guardsIntact || !pair.installGuards || pair.guardsIntact(db)) return;
  if (db.isTransaction || degraded.has(db)) return;
  try {
    db.exec('BEGIN IMMEDIATE');
    pair.installGuards(db);
    db.exec('COMMIT');
    log.warn({ table: pair.table }, `re-installed the bare ${pair.table} triggers (T12535)`);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    log.warn({ err: error, table: pair.table }, `could not re-install the bare triggers (T12535)`);
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
    // A snapshot an earlier collapse took (a build before pinning) is pinned
    // now, so rotation never deletes it. Best effort; one sidecar read.
    if (state?.snapshot) pinBackup(state.snapshot, 'migration', SNAPSHOT_PIN_REASON);
    if (bareChanged(nativeDb, pair, state)) pending.push(pair);
    else {
      if (state !== undefined) repairGuards(nativeDb, pair);
      byTable.set(pair.table, receipt(pair, 'unchanged', state?.snapshot ?? null));
    }
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
        for (const shadow of pair.shadows ?? [pair.twin]) unsealShadow(nativeDb, shadow);
        pair.shadow(nativeDb, pair.plan(nativeDb, readState(nativeDb, pair)));
        for (const shadow of pair.shadows ?? [pair.twin]) sealShadow(nativeDb, shadow);
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
        { pinnedReason: SNAPSHOT_PIN_REASON },
      );
    } catch (error) {
      fail(
        needSnapshot,
        {
          tables: needSnapshot.map((p) => p.table),
          cause: `${SNAPSHOT_FAILURE_PREFIX}${error instanceof Error ? error.message : String(error)}`,
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
      byTable.set(pair.table, collapsePair(nativeDb, pair, snapshotPath, dbPath));
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
  /** Docs: bare rows the last merge folded into the twin row with the same content. */
  readonly merged: readonly string[];
  /** Docs: rows the last merge carried under a free slug. */
  readonly renamed: readonly string[];
  /** Twin-only rows the initial collapse carried over (union rule). */
  readonly kept: readonly string[];
  /** Keys whose replaced twin value is archived under `twin_collapse_archive:<key>`. */
  readonly archived: readonly string[];
  /**
   * Whether the pair's triggers on the bare tables (the freeze against older
   * builds, the change counter) are all in place; `null` when the pair has
   * none or is not collapsed yet. Missing ones are re-installed at the next open.
   */
  readonly guardsIntact: boolean | null;
  /**
   * Whether the collapse snapshot is pinned (never rotated); `null` when there
   * is no snapshot on disk.
   */
  readonly snapshotPinned: boolean | null;
  /**
   * `true` when the marker names a pre-collapse snapshot that is no longer on
   * disk: the only copy of the store before the collapse is gone.
   */
  readonly snapshotMissing: boolean;
  /** The recorded failure, when the last attempt failed. */
  readonly failure: TwinCollapseFailure | null;
}

/** Whether a collapse snapshot on disk is pinned, or `null` when there is none. */
function snapshotPinnedOf(snapshot: string | null): boolean | null {
  if (!snapshot || !existsSync(snapshot)) return null;
  return isPinnedBackup(dirname(snapshot), basename(snapshot), 'migration');
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
      merged: [],
      renamed: [],
      kept: [],
      archived: [],
      guardsIntact: null,
      snapshotPinned: null,
      snapshotMissing: false,
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
      merged: state?.merged ?? [],
      renamed: state?.renamed ?? [],
      kept: state?.kept ?? [],
      archived: state?.archived ?? [],
      guardsIntact:
        state === undefined || pair.guardsIntact === undefined ? null : pair.guardsIntact(db),
      snapshotPinned: snapshotPinnedOf(state?.snapshot ?? null),
      snapshotMissing: typeof state?.snapshot === 'string' && !existsSync(state.snapshot),
      failure,
    };
  });
}

// ── recovery of what 2026.9.21 dropped or replaced (T12727) ─────────────────

/** Prefix of a recovery receipt key: `twin_collapse_recovery:<recoveredAt>`. */
export const TWIN_COLLAPSE_RECOVERY_PREFIX = 'twin_collapse_recovery:';

/** Error code of a recovery or rollback that cannot proceed; nothing was written. */
export const E_TWIN_COLLAPSE_RECOVER = 'E_TWIN_COLLAPSE_RECOVER';

const STICKY_ARCHIVE_KEY = `${TWIN_COLLAPSE_ARCHIVE_PREFIX}sticky_tags`;

/** A JSON object whose `sessionNotes` is an array (other fields pass through). */
const FocusNotesShape = z.object({ sessionNotes: z.array(z.unknown()) }).passthrough();
/** The sticky archive: `sticky_id\ttag` rows. */
const StickyArchiveShape = z.array(z.string());

/** Session notes of a `focus_state` value; `[]` when it has none or is not JSON. */
function sessionNotesOf(value: string | undefined): unknown[] {
  if (value === undefined) return [];
  const parsed = FocusNotesShape.safeParse(parseJson(value));
  return parsed.success ? parsed.data.sessionNotes : [];
}

/** The `(timestamp, note)` identity {@link mergeFocusState} deduplicates on. */
function noteKey(n: unknown): string {
  const r = (n !== null && typeof n === 'object' ? n : {}) as Record<string, unknown>;
  return `${String(r.timestamp ?? '')}\u0000${String(r.note ?? JSON.stringify(n))}`;
}

/** One twin value the recovery archives. */
export interface TwinCollapseRecoveryArchive {
  /** The `schema_meta` key. */
  readonly key: string;
  /** Where the value is written (`twin_collapse_archive:<key>`, or a suffixed key). */
  readonly archiveKey: string;
  /** `dropped`: only the twin held the key; `replaced`: the bare value won it. */
  readonly reason: 'dropped' | 'replaced';
  /** Length of the archived value, in characters. */
  readonly length: number;
}

/** What {@link planTwinCollapseRecovery} found, and what an apply would write. */
export interface TwinCollapseRecoveryPlan {
  /** The pre-collapse snapshot the `schema_meta` marker records; `null`: never collapsed. */
  readonly snapshot: string | null;
  /** Whether that snapshot is on disk. */
  readonly snapshotExists: boolean;
  /**
   * Whether that snapshot is pinned (its sidecar says `pinned: true`), so
   * rotation never deletes it. An apply refuses an unpinned snapshot unless
   * the caller pins it first (`--pin-snapshot`).
   */
  readonly snapshotPinned: boolean;
  /** Twin `schema_meta` values to archive. */
  readonly archive: readonly TwinCollapseRecoveryArchive[];
  /** Session notes the live `focus_state` gains from the twin history. */
  readonly focusNotesAdded: number;
  /** Twin-only sticky tags (`sticky_id\ttag`) to archive. */
  readonly stickyArchived: readonly string[];
  /** Where those tags go: `twin_collapse_archive:sticky_tags`, or a suffixed key. */
  readonly stickyArchiveKey: string;
  /** Receipt keys of earlier applies that were not rolled back. */
  readonly receipts: readonly string[];
  /** Whether an apply would write anything. */
  readonly changes: boolean;
  /**
   * The path the markers record, when the store moved (`/mnt` → `/home`,
   * Linux → Mac) and the snapshot was found by file name in the store's own
   * backup directory instead (T12788); `null` otherwise. An apply re-points
   * the markers at {@link snapshot}.
   */
  readonly movedFrom: string | null;
}

/** Options of {@link planTwinCollapseRecovery}. */
export interface TwinCollapseRecoveryPlanOptions {
  /** The snapshot file to use in place of the markers' path (a moved store, T12788). */
  readonly snapshotPath?: string;
}

/** Values a plan computed, and the snapshot it read. */
interface RecoveryWrites {
  readonly snapshot: DatabaseSync;
  readonly options: TwinCollapseRecoveryPlanOptions;
  readonly kv: ReadonlyMap<string, string>;
  readonly focusBefore: string | null;
  readonly focusState: string | null;
  readonly stickyBefore: string | null;
  readonly stickyArchive: string | null;
}

const recoveryWrites = new WeakMap<TwinCollapseRecoveryPlan, RecoveryWrites>();

const RecoveryReceiptShape = z.object({
  task: z.literal('T12727'),
  id: z.string(),
  recoveredAt: z.string(),
  snapshot: z.string().nullable(),
  archived: z.array(z.object({ key: z.string(), archiveKey: z.string(), sha: z.string() })),
  focusNotesAdded: z.number(),
  stickyArchived: z.array(z.string()),
  stickyArchiveKey: z.string(),
  before: z.object({ focusState: z.string().nullable(), stickyArchive: z.string().nullable() }),
  after: z.object({ focusState: z.string().nullable(), stickyArchive: z.string().nullable() }),
  rolledBackAt: z.string().nullable(),
});

/**
 * Receipt an apply records under `twin_collapse_recovery:<recoveredAt>`
 * (never over an earlier one). `before` holds the values the apply replaced,
 * `after` the sha256 of what it wrote, so `--rollback` can undo it.
 */
export type TwinCollapseRecoveryReceipt = z.infer<typeof RecoveryReceiptShape>;

/** Parsed receipt rows, by key. */
function recoveryReceipts(live: DatabaseSync): Map<string, TwinCollapseRecoveryReceipt> {
  const out = new Map<string, TwinCollapseRecoveryReceipt>();
  for (const [key, value] of kvRows(live, 'tasks_schema_meta')) {
    if (!key.startsWith(TWIN_COLLAPSE_RECOVERY_PREFIX)) continue;
    const parsed = RecoveryReceiptShape.safeParse(parseJson(value));
    if (parsed.success) out.set(key, parsed.data);
  }
  return out;
}

/** Tag sets of a sticky junction; empty when the table is absent. */
function stickySetsIfPresent(db: DatabaseSync, table: string): Map<string, string[]> {
  return hasMainTable(db, table) ? stickySets(db, table) : new Map();
}

/**
 * Plan the recovery of the twin values a 2026.9.21 collapse dropped or
 * replaced, from the pre-collapse snapshot its marker records (T12727).
 *
 * The 9.21 initial collapse was bare-authoritative: it deleted keys and
 * sticky tags only the twin held and overwrote twin values with the bare
 * ones, keeping them only in that snapshot. This compares the snapshot's
 * twin and bare tables (read-only; a pair whose table the snapshot lacks is
 * skipped) and plans, for every twin value that is not live and not archived:
 * - `schema_meta`: the twin value is written to `twin_collapse_archive:<key>`
 *   (a suffixed key when that name already holds another value, so nothing is
 *   overwritten); for `focus_state` the twin's session notes are also merged
 *   into the live value ({@link mergeFocusState}: live current fields win,
 *   notes deduplicated by `(timestamp, note)` and sorted);
 * - `sticky_tags`: twin-only tags are added to
 *   `twin_collapse_archive:sticky_tags` in `brain_schema_meta` (a suffixed key
 *   when that row is not a list of tags).
 * The notes are merged once: not again after an apply that was not rolled
 * back, nor when the twin value is already archived, so notes pruned after a
 * recovery stay pruned. A second apply plans nothing.
 *
 * @param live - The project `cleo.db` connection (read-only is enough).
 * @param snapshot - The snapshot, opened read-only, or `null` when missing.
 * @returns The plan.
 * @task T12727
 */
export function planTwinCollapseRecovery(
  live: DatabaseSync,
  snapshot: DatabaseSync | null,
  options: TwinCollapseRecoveryPlanOptions = {},
): TwinCollapseRecoveryPlan {
  const state = readState(live, SCHEMA_META);
  const recorded = state?.snapshot ?? null;
  const snapshotPath = recorded === null ? null : (options.snapshotPath ?? recorded);
  const liveKv = kvRows(live, 'tasks_schema_meta');
  const receipts = [...recoveryReceipts(live)]
    .filter(([, r]) => r.rolledBackAt === null)
    .map(([k]) => k)
    .sort();
  const empty = {
    snapshot: snapshotPath,
    snapshotExists: snapshot !== null,
    snapshotPinned: recoverySnapshotPinned(snapshotPath),
    archive: [],
    focusNotesAdded: 0,
    stickyArchived: [],
    stickyArchiveKey: STICKY_ARCHIVE_KEY,
    receipts,
    changes: false,
    movedFrom: recorded !== null && snapshotPath !== recorded ? recorded : null,
  };
  if (snapshot === null) return empty;

  // A pair whose bare or twin table the snapshot lacks had nothing to collapse.
  const kvPair =
    hasMainTable(snapshot, 'schema_meta') && hasMainTable(snapshot, 'tasks_schema_meta');
  const sBare = kvPair ? carriedRows(snapshot, 'schema_meta') : new Map<string, string>();
  const sTwin = kvPair ? carriedRows(snapshot, 'tasks_schema_meta') : new Map<string, string>();
  const kv = new Map<string, string>();
  const archive: TwinCollapseRecoveryArchive[] = [];
  const archivedValues = new Set(
    [...liveKv].filter(([k]) => k.startsWith(TWIN_COLLAPSE_ARCHIVE_PREFIX)).map(([, v]) => v),
  );
  const focusBefore = liveKv.get('focus_state') ?? null;
  let focusState: string | null = null;
  let focusNotesAdded = 0;
  for (const [key, twinValue] of [...sTwin].sort(([a], [b]) => a.localeCompare(b))) {
    if (sBare.get(key) === twinValue) continue; // not replaced
    const reason = sBare.has(key) ? 'replaced' : 'dropped';
    const done = liveKv.get(key) === twinValue || archivedValues.has(twinValue);
    if (key === 'focus_state' && !done && receipts.length === 0) {
      if (focusBefore !== null) {
        const merged = mergeFocusState(focusBefore, twinValue);
        if (merged !== focusBefore) {
          focusNotesAdded = sessionNotesOf(merged).length - sessionNotesOf(focusBefore).length;
          focusState = merged;
        }
      } else if (reason === 'dropped') {
        // Only the twin held it (the kodomeet shape) and nothing replaced the
        // legacy key since: its notes are live again. Its pointer is not:
        // bound sessions keep their focus under `focus_state:<sessionId>`
        // (T11345, T12501), and the next keyless one would adopt a live legacy
        // pointer months stale. The full value stays in the archive (T12771).
        const parsed = FocusNotesShape.safeParse(parseJson(twinValue));
        if (parsed.success) {
          focusState = JSON.stringify({ ...parsed.data, currentTask: null });
          focusNotesAdded = parsed.data.sessionNotes.length;
        }
      }
    }
    if (done) continue;
    let archiveKey = `${TWIN_COLLAPSE_ARCHIVE_PREFIX}${key}`;
    if (liveKv.has(archiveKey)) archiveKey = `${archiveKey}:${sha(twinValue).slice(0, 8)}`;
    kv.set(archiveKey, twinValue);
    archive.push({ key, archiveKey, reason, length: twinValue.length });
  }

  // Sticky tags only the twin junction held in the snapshot.
  const stickyPair =
    hasMainTable(snapshot, 'sticky_tags') && hasMainTable(snapshot, 'brain_sticky_tags');
  const sb = stickyPair ? stickySets(snapshot, 'sticky_tags') : new Map<string, string[]>();
  const st = stickyPair ? stickySets(snapshot, 'brain_sticky_tags') : new Map<string, string[]>();
  const liveTags = stickySetsIfPresent(live, 'brain_sticky_tags');
  const stickyRaw = hasMainTable(live, 'brain_schema_meta')
    ? readKv(live, 'brain_schema_meta', STICKY_ARCHIVE_KEY)
    : undefined;
  const stickyParsed = StickyArchiveShape.safeParse(parseJson(stickyRaw ?? '[]'));
  // A row that is not a list of tags is someone's data: never overwrite it.
  const stickyArchiveKey = stickyParsed.success
    ? STICKY_ARCHIVE_KEY
    : `${STICKY_ARCHIVE_KEY}:${sha(stickyRaw ?? '').slice(0, 8)}`;
  const previousRaw = stickyParsed.success
    ? stickyRaw
    : readKv(live, 'brain_schema_meta', stickyArchiveKey);
  const previous = StickyArchiveShape.safeParse(parseJson(previousRaw ?? '[]'));
  const archivedTags = new Set(previous.success ? previous.data : []);
  const stickyArchived: string[] = [];
  for (const [id, tags] of st) {
    const bare = new Set(sb.get(id) ?? []);
    const now = new Set(liveTags.get(id) ?? []);
    for (const tag of tags) {
      const row = `${id}\t${tag}`;
      if (bare.has(tag) || now.has(tag) || archivedTags.has(row)) continue;
      stickyArchived.push(row);
    }
  }
  stickyArchived.sort();
  const stickyArchive =
    stickyArchived.length > 0
      ? JSON.stringify([...new Set([...archivedTags, ...stickyArchived])].sort())
      : null;

  const plan: TwinCollapseRecoveryPlan = {
    ...empty,
    archive,
    focusNotesAdded,
    stickyArchived,
    stickyArchiveKey,
    changes: kv.size > 0 || focusState !== null || stickyArchive !== null,
  };
  recoveryWrites.set(plan, {
    snapshot,
    options,
    kv,
    focusBefore,
    focusState,
    stickyBefore: previousRaw ?? null,
    stickyArchive,
  });
  return plan;
}

/**
 * Apply a recovery in one `BEGIN IMMEDIATE` transaction on the live store.
 *
 * The plan is recomputed INSIDE the transaction from the live values read
 * under the write lock, so a note written after `plan` was built is merged,
 * never lost; `plan` is the preview the caller showed. Writes the archive
 * keys, the merged `focus_state`, the sticky archive, and a new receipt.
 * Nothing is written when there is nothing to recover. Never touches the
 * snapshot.
 *
 * @param live - The project `cleo.db` connection, outside a transaction.
 * @param plan - From {@link planTwinCollapseRecovery} on the same connection.
 * @returns The plan applied and its receipt (`null` when nothing was written).
 * @throws {CleoError} {@link E_TWIN_COLLAPSE_RECOVER} when the recorded
 *   snapshot is missing (nothing is written).
 * @task T12727
 */
export function applyTwinCollapseRecovery(
  live: DatabaseSync,
  plan: TwinCollapseRecoveryPlan,
  onRepoint?: (repoint: TwinCollapseSnapshotRepoint) => void,
): {
  readonly plan: TwinCollapseRecoveryPlan;
  readonly receipt: TwinCollapseRecoveryReceipt | null;
  readonly repointed: TwinCollapseSnapshotRepoint | null;
} {
  if (plan.snapshot === null) return { plan, receipt: null, repointed: null };
  const preview = recoveryWrites.get(plan);
  if (!plan.snapshotExists || preview === undefined) throw missingSnapshot(plan.snapshot);
  live.exec('BEGIN IMMEDIATE');
  try {
    const fresh = planTwinCollapseRecovery(live, preview.snapshot, preview.options);
    const writes = recoveryWrites.get(fresh);
    // Only when there is something to write (T12772): a re-run on a
    // recovered store is a no-op whatever the pin. Checked before anything
    // (the re-point, its audit row) is written.
    if (fresh.changes && writes !== undefined && !fresh.snapshotPinned)
      throw unpinnedSnapshot(fresh.snapshot);
    // A moved store (T12788): the markers name the file where it lives now,
    // whether or not anything is left to recover; `onRepoint` audits it.
    let repointed: TwinCollapseSnapshotRepoint | null = null;
    if (fresh.movedFrom !== null && fresh.snapshot !== null) {
      repointed = repointSnapshotMarkers(live, fresh.movedFrom, fresh.snapshot);
      onRepoint?.(repointed);
    }
    if (!fresh.changes || writes === undefined) {
      live.exec(repointed === null ? 'ROLLBACK' : 'COMMIT');
      return { plan: fresh, receipt: null, repointed };
    }
    const recoveredAt = new Date().toISOString();
    let id = `${TWIN_COLLAPSE_RECOVERY_PREFIX}${recoveredAt}`;
    for (let n = 2; readKv(live, 'tasks_schema_meta', id) !== undefined; n++)
      id = `${TWIN_COLLAPSE_RECOVERY_PREFIX}${recoveredAt}:${n}`;
    const receipt: TwinCollapseRecoveryReceipt = {
      task: 'T12727',
      id,
      recoveredAt,
      snapshot: fresh.snapshot,
      archived: fresh.archive.map((a) => ({
        key: a.key,
        archiveKey: a.archiveKey,
        sha: sha(writes.kv.get(a.archiveKey) ?? ''),
      })),
      focusNotesAdded: fresh.focusNotesAdded,
      stickyArchived: [...fresh.stickyArchived],
      stickyArchiveKey: fresh.stickyArchiveKey,
      before: {
        focusState: writes.focusState === null ? null : writes.focusBefore,
        stickyArchive: writes.stickyArchive === null ? null : writes.stickyBefore,
      },
      after: {
        focusState: writes.focusState === null ? null : sha(writes.focusState),
        stickyArchive: writes.stickyArchive === null ? null : sha(writes.stickyArchive),
      },
      rolledBackAt: null,
    };
    for (const [key, value] of writes.kv) writeKv(live, 'tasks_schema_meta', key, value);
    if (writes.focusState !== null)
      writeKv(live, 'tasks_schema_meta', 'focus_state', writes.focusState);
    if (writes.stickyArchive !== null)
      writeKv(live, 'brain_schema_meta', fresh.stickyArchiveKey, writes.stickyArchive);
    writeKv(live, 'tasks_schema_meta', id, JSON.stringify(receipt));
    live.exec('COMMIT');
    return { plan: fresh, receipt, repointed };
  } catch (error) {
    if (live.isTransaction) live.exec('ROLLBACK');
    throw error;
  }
}

/** Markers re-pointed from a moved store's old snapshot path (T12788). */
export interface TwinCollapseSnapshotRepoint {
  /** The path the markers recorded. */
  readonly from: string;
  /** The file in the store's own backup directory they name now. */
  readonly to: string;
  /** The marker keys rewritten (`<kvTable>:twin_collapse:<table>`). */
  readonly markers: readonly string[];
}

/** Point every marker that records `from` at `to` (inside the caller's transaction). */
function repointSnapshotMarkers(
  live: DatabaseSync,
  from: string,
  to: string,
): TwinCollapseSnapshotRepoint {
  const markers: string[] = [];
  for (const pair of PAIRS) {
    if (!hasMainTable(live, pair.kvTable)) continue;
    const key = `${TWIN_COLLAPSE_MARKER_PREFIX}${pair.table}`;
    const raw = readKv(live, pair.kvTable, key);
    const parsed = raw === undefined ? undefined : parseJson(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    if ((parsed as { snapshot?: unknown }).snapshot !== from) continue;
    writeKv(live, pair.kvTable, key, JSON.stringify({ ...parsed, snapshot: to }));
    markers.push(`${pair.kvTable}:${key}`);
  }
  return { from, to, markers };
}

/** The error for a recorded snapshot that is not on disk. */
export function missingSnapshot(path: string | null): CleoError {
  return new CleoError(
    ExitCode.NOT_FOUND,
    `${E_TWIN_COLLAPSE_RECOVER}: the pre-collapse snapshot ${path ?? '(none recorded)'} is missing; nothing was recovered`,
    {
      fix: 'Restore that file from a backup of .cleo/backups/sqlite/ and re-run; without it there is nothing to recover from.',
      details: { field: 'snapshot', actual: path },
    },
  );
}

/** The error for a recorded snapshot rotation could still delete. */
export function unpinnedSnapshot(path: string | null): CleoError {
  return new CleoError(
    ExitCode.VALIDATION_ERROR,
    `${E_TWIN_COLLAPSE_RECOVER}: the pre-collapse snapshot ${path ?? '(none recorded)'} is not pinned, so backup rotation may delete it; nothing was recovered`,
    {
      fix: 'cleo doctor twin-collapse --recover --pin-snapshot  # pins it (writes only its .meta.json sidecar), then recovers',
      details: { field: 'snapshotPinned', expected: true, actual: false },
    },
  );
}

/** Whether the recorded snapshot is on disk and pinned. */
function recoverySnapshotPinned(path: string | null): boolean {
  return (
    path !== null && existsSync(path) && isPinnedBackup(dirname(path), basename(path), 'migration')
  );
}

/**
 * Pin the recorded pre-collapse snapshot before a recovery
 * (`--pin-snapshot`): writes its `.meta.json` sidecar only, never the snapshot.
 *
 * @param path - The snapshot the marker records.
 * @returns Whether it is pinned now.
 * @task T12727
 */
export function pinRecoverySnapshot(path: string): boolean {
  return pinBackup(path, 'migration', SNAPSHOT_PIN_REASON);
}

/** What {@link rollbackTwinCollapseRecovery} undid. */
export interface TwinCollapseRecoveryRollback {
  /** The receipt key. */
  readonly id: string;
  /** Archive keys deleted (they still held what the recovery wrote). */
  readonly archiveDeleted: readonly string[];
  /** Archive keys left alone (changed since; not the recovery's value any more). */
  readonly archiveKept: readonly string[];
  /**
   * `restored`: `focus_state` was unchanged since, so the pre-merge value is
   * back; `notes-removed`: it changed since, so only the notes the recovery
   * added were removed; `none`: the recovery did not touch it.
   */
  readonly focusState: 'restored' | 'notes-removed' | 'none';
  /** Session notes removed from `focus_state`. */
  readonly notesRemoved: number;
  /** Sticky rows removed from the sticky archive. */
  readonly stickyRemoved: number;
}

/**
 * Undo one recovery apply (`cleo doctor twin-collapse --rollback <id>`), in
 * one `BEGIN IMMEDIATE` transaction:
 * - archive keys it wrote are deleted when they still hold that value;
 * - `focus_state` is restored to its pre-merge value when unchanged since,
 *   else only the notes the recovery added are removed (notes written since
 *   stay);
 * - the sticky archive is restored when unchanged since, else only the rows
 *   the recovery added are removed;
 * - the receipt is kept, stamped `rolledBackAt`.
 *
 * @param live - The project `cleo.db` connection, outside a transaction.
 * @param id - The receipt key (`twin_collapse_recovery:<recoveredAt>`).
 * @returns What was undone.
 * @throws {CleoError} {@link E_TWIN_COLLAPSE_RECOVER} when the receipt is
 *   unknown or already rolled back (nothing is written).
 * @task T12727
 */
export function rollbackTwinCollapseRecovery(
  live: DatabaseSync,
  id: string,
): TwinCollapseRecoveryRollback {
  live.exec('BEGIN IMMEDIATE');
  try {
    const receipt = recoveryReceipts(live).get(id);
    if (receipt === undefined || receipt.rolledBackAt !== null)
      throw new CleoError(
        ExitCode.NOT_FOUND,
        `${E_TWIN_COLLAPSE_RECOVER}: ${receipt === undefined ? 'no recovery receipt' : 'already rolled back:'} ${id}; nothing was changed`,
        {
          fix: 'cleo doctor twin-collapse --recover --dry-run  # lists the receipts not rolled back',
        },
      );
    const archiveDeleted: string[] = [];
    const archiveKept: string[] = [];
    let addedNotes = new Set<string>();
    for (const a of receipt.archived) {
      const value = readKv(live, 'tasks_schema_meta', a.archiveKey);
      if (value === undefined || sha(value) !== a.sha) {
        archiveKept.push(a.archiveKey);
        continue;
      }
      if (a.key === 'focus_state') {
        const before = new Set(sessionNotesOf(receipt.before.focusState ?? undefined).map(noteKey));
        addedNotes = new Set(
          sessionNotesOf(value)
            .map(noteKey)
            .filter((k) => !before.has(k)),
        );
      }
      live.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(a.archiveKey);
      archiveDeleted.push(a.archiveKey);
    }

    let focusState: TwinCollapseRecoveryRollback['focusState'] = 'none';
    let notesRemoved = 0;
    if (receipt.after.focusState !== null) {
      const current = readKv(live, 'tasks_schema_meta', 'focus_state');
      if (current !== undefined && sha(current) === receipt.after.focusState) {
        notesRemoved =
          sessionNotesOf(current).length -
          sessionNotesOf(receipt.before.focusState ?? undefined).length;
        if (receipt.before.focusState === null)
          live.prepare("DELETE FROM main.tasks_schema_meta WHERE key = 'focus_state'").run();
        else writeKv(live, 'tasks_schema_meta', 'focus_state', receipt.before.focusState);
        focusState = 'restored';
      } else if (current !== undefined) {
        const parsed = FocusNotesShape.safeParse(parseJson(current));
        if (parsed.success) {
          const kept = parsed.data.sessionNotes.filter((n) => !addedNotes.has(noteKey(n)));
          notesRemoved = parsed.data.sessionNotes.length - kept.length;
          if (notesRemoved > 0)
            writeKv(
              live,
              'tasks_schema_meta',
              'focus_state',
              JSON.stringify({ ...parsed.data, sessionNotes: kept }),
            );
          focusState = 'notes-removed';
        }
      }
    }

    let stickyRemoved = 0;
    if (receipt.after.stickyArchive !== null) {
      const current = readKv(live, 'brain_schema_meta', receipt.stickyArchiveKey);
      if (current !== undefined && sha(current) === receipt.after.stickyArchive) {
        stickyRemoved = receipt.stickyArchived.length;
        if (receipt.before.stickyArchive === null)
          live
            .prepare('DELETE FROM main.brain_schema_meta WHERE key = ?')
            .run(receipt.stickyArchiveKey);
        else
          writeKv(
            live,
            'brain_schema_meta',
            receipt.stickyArchiveKey,
            receipt.before.stickyArchive,
          );
      } else if (current !== undefined) {
        const parsed = StickyArchiveShape.safeParse(parseJson(current));
        if (parsed.success) {
          const added = new Set(receipt.stickyArchived);
          const kept = parsed.data.filter((r) => !added.has(r));
          stickyRemoved = parsed.data.length - kept.length;
          writeKv(live, 'brain_schema_meta', receipt.stickyArchiveKey, JSON.stringify(kept));
        }
      }
    }

    writeKv(
      live,
      'tasks_schema_meta',
      id,
      JSON.stringify({ ...receipt, rolledBackAt: new Date().toISOString() }),
    );
    live.exec('COMMIT');
    return { id, archiveDeleted, archiveKept, focusState, notesRemoved, stickyRemoved };
  } catch (error) {
    if (live.isTransaction) live.exec('ROLLBACK');
    throw error;
  }
}
