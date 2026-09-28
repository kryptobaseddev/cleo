/**
 * Atomic twin collapses (T12535): fold a live BARE legacy table into its
 * prefixed twin, once, in one transaction, before the runtime reads the twin.
 *
 * ## Why
 *
 * The project `cleo.db` carries legacy bare tables beside their prefixed
 * (E6) twins. For some pairs the runtime still wrote the bare table while the
 * twin held a frozen exodus copy. Rebinding the runtime to the twin is only
 * safe together with the rows: otherwise the first read after the upgrade sees
 * the frozen copy (a May focus state, a stale task-id counter) or nothing.
 * Each collapse here therefore runs inside the domain bind, after the lineage
 * that creates the bare table and before any caller receives the handle, and
 * the runtime code that reads the twin ships in the same change.
 *
 * ## Contract (every collapse)
 *
 * 1. **Once.** A marker row (`twin_collapse:<bare table>`) is written into
 *    the domain's key/value table in the same transaction as the merge. With
 *    the marker present the collapse is a no-op, so a re-run changes nothing
 *    and a bare row written later by an OLDER CLEO build is not merged over
 *    newer twin values. That later row stays in the bare table, which is
 *    never modified (slice 3 drops it after a backup).
 * 2. **Snapshot first.** When the merge would change the twin, a full
 *    `VACUUM INTO` snapshot is written before the transaction (see
 *    {@link writePreRepairSnapshot}); a snapshot failure aborts the collapse.
 * 3. **Atomic.** Merge, verification and marker commit together under
 *    `BEGIN IMMEDIATE` (the write lock is taken before the marker is
 *    re-checked, so two processes cannot both merge). Any failure rolls back:
 *    both tables are byte-identical to before and the error propagates, so
 *    the bind fails rather than serve unmerged data. The next bind retries
 *    (resumable: nothing partial is ever committed).
 * 4. **Verified.** Before the marker is written, every carried bare row is
 *    re-read from the twin and compared with the value the merge rule
 *    decided; a mismatch throws and rolls back.
 *
 * ## `schema_meta` → `tasks_schema_meta`: key-aware merge
 *
 * Two rules: a monotonic counter or generation takes MAX(bare, twin); every
 * other key present in both tables takes the bare (live) value.
 * Until this collapse the bare table was the live one; the twin holds either
 * nothing, the fresh-store seeds, or an exodus copy from before the runtime
 * moved. Per key present in the bare table ({@link mergeSchemaMetaValue}):
 *
 * | Key | Rule |
 * |---|---|
 * | `task_id_sequence` (`{counter,lastId,checksum}`, written by `sequence/index.ts`) | the value with the LARGER `counter` wins whole; a tie keeps the twin. Never summed, never reset. A value that does not parse loses to one that does; if neither parses the bare value wins |
 * | `sqlite_snapshot_gate` (`{generation,prefixes}`, `snapshot-gate.ts`) | the value with the LARGER `generation` wins whole (generations are claimed monotonically); a tie keeps the bare value |
 * | `file_meta` (`FileMeta`; `generation` is bumped on session start/end/resume in `session/engine-ops.ts`) | same: the larger `generation` wins whole, a tie keeps the bare value |
 * | `backfill:*` (the two `t877` migration guard keys) | not carried: the drizzle-tasks lineage re-inserts them into every bare table and nothing reads them |
 * | `twin_collapse:*` | not carried (collapse markers live only in the twin) |
 * | every other key: `schemaVersion`, `version`, `focus_state`, `focus_state:<session>`, `project_meta`, `project`, `parallel_state`, `activeSession`, `reconcile.<task>.release`, and any unknown key | the BARE value wins (it was the last writer) |
 *
 * A key only the twin holds is kept as is.
 *
 * ## `sticky_tags` → `brain_sticky_tags`: union
 *
 * Both columns are the primary key `(sticky_id, tag)`, so two rows that
 * collide are identical and the union keeps one (`INSERT OR IGNORE`, in
 * `(sticky_id, tag)` order). A bare row whose sticky note no longer exists
 * (possible only where foreign keys were off) is not carried; it is counted in
 * the receipt and stays in the bare table.
 *
 * ## Gate 28
 *
 * This module is a sanctioned writer (`scripts/lint-no-raw-table-writes.mjs`
 * SANCTIONED): it runs on the chokepoint handle inside the domain bind, and
 * its writes cannot go through the accessors, which import the modules that
 * call it.
 *
 * @module
 * @task T12535
 */

import type { DatabaseSync } from 'node:sqlite';
import { getLogger } from '../logger.js';
import { writePreRepairSnapshot } from './pre-repair-snapshot.js';
import { SNAPSHOT_GATE_META_KEY } from './snapshot-gate.js';

const log = getLogger('twin-collapse');

/** Prefix of the marker key a finished collapse leaves in its twin's domain. */
export const TWIN_COLLAPSE_MARKER_PREFIX = 'twin_collapse:';

/** Outcome of one collapse. */
export interface TwinCollapseReceipt {
  /** The bare legacy table. */
  readonly table: string;
  /** The prefixed twin it folds into. */
  readonly twin: string;
  /**
   * `collapsed`: this call merged and wrote the marker. `already-collapsed`:
   * the marker was present, nothing ran. `no-bare-table`: nothing to merge.
   */
  readonly status: 'collapsed' | 'already-collapsed' | 'no-bare-table';
  /** Pre-merge snapshot, or `null` when the merge changed nothing. */
  readonly snapshotPath: string | null;
  /** Rows added to the twin. */
  readonly inserted: number;
  /** Twin rows whose value the merge replaced. */
  readonly replaced: number;
  /** Bare rows already matching the twin, or where the twin's value won. */
  readonly kept: number;
  /** Bare rows not carried, by rule (dead keys, orphaned tags). */
  readonly skipped: number;
}

/** Which side a merged `schema_meta` value came from. */
export type SchemaMetaMergeSource = 'bare' | 'twin' | 'skip';

/** Numeric field of a JSON value, or `undefined`. */
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

/** Larger-field-wins rule; `tieWins` names the side a tie keeps. */
function maxBy(
  bare: string,
  twin: string,
  field: string,
  tieWins: 'bare' | 'twin',
): SchemaMetaMergeSource {
  const b = numericField(bare, field);
  const t = numericField(twin, field);
  if (b === undefined && t === undefined) return 'bare';
  if (b === undefined) return 'twin';
  if (t === undefined) return 'bare';
  if (b === t) return tieWins;
  return b > t ? 'bare' : 'twin';
}

/**
 * Decide which value a `schema_meta` key keeps in `tasks_schema_meta` (the
 * rule table is in the module comment).
 *
 * @param key - The key.
 * @param bare - Its value in the bare table.
 * @param twin - Its value in the twin, or `undefined` when absent.
 * @returns `bare` or `twin` for the value to keep, `skip` when the key is not
 *   carried at all.
 * @task T12535
 */
export function mergeSchemaMetaValue(
  key: string,
  bare: string,
  twin: string | undefined,
): SchemaMetaMergeSource {
  if (key.startsWith('backfill:') || key.startsWith(TWIN_COLLAPSE_MARKER_PREFIX)) return 'skip';
  if (twin === undefined) return 'bare';
  if (key === 'task_id_sequence') return maxBy(bare, twin, 'counter', 'twin');
  if (key === SNAPSHOT_GATE_META_KEY || key === 'file_meta')
    return maxBy(bare, twin, 'generation', 'bare');
  return 'bare';
}

/** Whether `main` holds a table of this name. */
function hasMainTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** Whether the marker is present in a key/value table. */
function hasMarker(db: DatabaseSync, kvTable: string, marker: string): boolean {
  return db.prepare(`SELECT 1 FROM main.${kvTable} WHERE key = ?`).get(marker) !== undefined;
}

/** Write the marker row (inside the collapse transaction). */
function writeMarker(
  db: DatabaseSync,
  kvTable: string,
  marker: string,
  receipt: Omit<TwinCollapseReceipt, 'status'>,
): void {
  db.prepare(
    `INSERT INTO main.${kvTable} (key, value) VALUES (?, ?) ` +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(
    marker,
    JSON.stringify({
      task: 'T12535',
      collapsedAt: new Date().toISOString(),
      twin: receipt.twin,
      inserted: receipt.inserted,
      replaced: receipt.replaced,
      kept: receipt.kept,
      skipped: receipt.skipped,
      snapshot: receipt.snapshotPath,
    }),
  );
}

/** The work one collapse does: plan (read-only) and apply (in the transaction). */
interface CollapseSteps {
  readonly table: string;
  readonly twin: string;
  /** Key/value table holding the marker. */
  readonly kvTable: string;
  /** Rows the merge would add or change right now. */
  plannedChanges(db: DatabaseSync): number;
  /** Merge, verify, and return the counts. Runs inside the transaction. */
  apply(db: DatabaseSync): { inserted: number; replaced: number; kept: number; skipped: number };
}

/** Run one collapse under the module contract. */
function runCollapse(
  nativeDb: DatabaseSync,
  dbPath: string,
  steps: CollapseSteps,
): TwinCollapseReceipt {
  const { table, twin, kvTable } = steps;
  const marker = `${TWIN_COLLAPSE_MARKER_PREFIX}${table}`;
  const none = { table, twin, snapshotPath: null, inserted: 0, replaced: 0, kept: 0, skipped: 0 };
  if (!hasMainTable(nativeDb, table)) return { ...none, status: 'no-bare-table' };
  if (hasMarker(nativeDb, kvTable, marker)) return { ...none, status: 'already-collapsed' };
  if (nativeDb.isTransaction)
    throw new Error(`twin collapse of ${table} needs a connection outside a transaction`);

  const snapshotPath =
    steps.plannedChanges(nativeDb) > 0
      ? writePreRepairSnapshot(nativeDb, dbPath, `t12535-${table.replaceAll('_', '-')}-collapse`)
      : null;

  nativeDb.exec('BEGIN IMMEDIATE');
  try {
    // Re-checked under the write lock: another process may have collapsed
    // between the first check and the lock.
    if (hasMarker(nativeDb, kvTable, marker)) {
      nativeDb.exec('ROLLBACK');
      return { ...none, status: 'already-collapsed' };
    }
    if (snapshotPath === null && steps.plannedChanges(nativeDb) > 0)
      throw new Error(`bare ${table} rows appeared after the snapshot decision; retry the open`);
    const counts = steps.apply(nativeDb);
    const receipt = { table, twin, snapshotPath, ...counts };
    writeMarker(nativeDb, kvTable, marker, receipt);
    nativeDb.exec('COMMIT');
    if (counts.inserted + counts.replaced > 0)
      log.warn(receipt, `collapsed bare ${table} into ${twin} (T12535)`);
    return { ...receipt, status: 'collapsed' };
  } catch (error) {
    nativeDb.exec('ROLLBACK');
    log.error(
      { table, twin, snapshotPath, error },
      `twin collapse of ${table} failed and was rolled back (T12535)`,
    );
    throw error;
  }
}

/** Every bare `schema_meta` row with the twin's current value and the rule's decision. */
function schemaMetaPlan(db: DatabaseSync) {
  const bare = db.prepare('SELECT key, value FROM main.schema_meta ORDER BY key').all() as Array<{
    key: string;
    value: string;
  }>;
  const twinRows = db.prepare('SELECT key, value FROM main.tasks_schema_meta').all() as Array<{
    key: string;
    value: string;
  }>;
  const twin = new Map(twinRows.map((r) => [r.key, r.value]));
  return bare.map((row) => {
    const current = twin.get(row.key);
    const source = mergeSchemaMetaValue(row.key, row.value, current);
    return { key: row.key, bare: row.value, current, source };
  });
}

/** A plan row that changes the twin. */
function changesTwin(p: { bare: string; current: string | undefined; source: string }): boolean {
  return p.source === 'bare' && p.current !== p.bare;
}

/**
 * Fold the bare `schema_meta` into `tasks_schema_meta` once (key-aware merge;
 * see the module comment). Runs in the tasks-domain bind, after the
 * drizzle-tasks lineage and before `seedTasksMeta`.
 *
 * @param nativeDb - The project `cleo.db` connection, outside any transaction.
 * @param dbPath - Its file path (locates the snapshot directory).
 * @returns The receipt.
 * @throws When the snapshot or the merge fails; the database is unchanged.
 * @task T12535
 */
export function collapseSchemaMetaTwin(
  nativeDb: DatabaseSync,
  dbPath: string,
): TwinCollapseReceipt {
  return runCollapse(nativeDb, dbPath, {
    table: 'schema_meta',
    twin: 'tasks_schema_meta',
    kvTable: 'tasks_schema_meta',
    plannedChanges: (db) => schemaMetaPlan(db).filter(changesTwin).length,
    apply: (db) => {
      const plan = schemaMetaPlan(db);
      const upsert = db.prepare(
        'INSERT INTO main.tasks_schema_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      let inserted = 0;
      let replaced = 0;
      let kept = 0;
      let skipped = 0;
      for (const p of plan) {
        if (p.source === 'skip') skipped++;
        else if (!changesTwin(p)) kept++;
        else {
          upsert.run(p.key, p.bare);
          if (p.current === undefined) inserted++;
          else replaced++;
        }
      }
      const read = db.prepare('SELECT value FROM main.tasks_schema_meta WHERE key = ?');
      for (const p of plan) {
        if (p.source === 'skip') continue;
        const want = p.source === 'bare' ? p.bare : p.current;
        const got = (read.get(p.key) as { value: string } | undefined)?.value;
        if (got !== want)
          throw new Error(`schema_meta collapse did not verify for key ${JSON.stringify(p.key)}`);
      }
      return { inserted, replaced, kept, skipped };
    },
  });
}

/** Bare sticky tags whose note exists and that the twin lacks. */
const STICKY_MISSING =
  'FROM main.sticky_tags s WHERE EXISTS (SELECT 1 FROM main.brain_sticky_notes n WHERE n.id = s.sticky_id) ' +
  'AND NOT EXISTS (SELECT 1 FROM main.brain_sticky_tags t WHERE t.sticky_id = s.sticky_id AND t.tag = s.tag)';

/**
 * Fold the bare `sticky_tags` into `brain_sticky_tags` once (union on the
 * `(sticky_id, tag)` key; see the module comment). Runs in the brain-domain
 * bind, after the legacy brain schema is established.
 *
 * @param nativeDb - The project `cleo.db` connection, outside any transaction.
 * @param dbPath - Its file path (locates the snapshot directory).
 * @returns The receipt.
 * @throws When the snapshot or the merge fails; the database is unchanged.
 * @task T12535
 */
export function collapseStickyTagsTwin(
  nativeDb: DatabaseSync,
  dbPath: string,
): TwinCollapseReceipt {
  const count = (db: DatabaseSync, sql: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c ${sql}`).get() as { c: number }).c;
  return runCollapse(nativeDb, dbPath, {
    table: 'sticky_tags',
    twin: 'brain_sticky_tags',
    kvTable: 'brain_schema_meta',
    plannedChanges: (db) => count(db, STICKY_MISSING),
    apply: (db) => {
      const total = count(db, 'FROM main.sticky_tags');
      const orphans = count(
        db,
        'FROM main.sticky_tags s WHERE NOT EXISTS (SELECT 1 FROM main.brain_sticky_notes n WHERE n.id = s.sticky_id)',
      );
      const inserted = Number(
        db
          .prepare(
            `INSERT OR IGNORE INTO main.brain_sticky_tags (sticky_id, tag) SELECT s.sticky_id, s.tag ${STICKY_MISSING} ORDER BY s.sticky_id, s.tag`,
          )
          .run().changes,
      );
      const left = count(db, STICKY_MISSING);
      if (left !== 0)
        throw new Error(`sticky_tags collapse did not verify: ${left} row(s) missing`);
      return { inserted, replaced: 0, kept: total - orphans - inserted, skipped: orphans };
    },
  });
}
