/**
 * Explicit, verified reconcile of stranded legacy project stores into `cleo.db`.
 *
 * ## Why this exists (T12319)
 *
 * Measured 2026-09-24: ~21 projects ran on an EMPTY consolidated `cleo.db`
 * while their legacy `.cleo/tasks.db` / `.cleo/brain.db` still held everything
 * (llmtxt: 849 tasks + 1,696 observations; claude-todo: 5,330 + 5,148). Two
 * things kept exodus-on-open from ever copying them: a machine-wide
 * `CLEO_DISABLE_EXODUS_ON_OPEN=1` incident kill-switch (skip, silently), and —
 * with the switch off — a copy engine that aborted on real legacy data (FK
 * order, pre-T1408 archive reasons, pre-T877 stages, grandfathered hierarchy
 * rows, NULL `valid_at`). `cleo doctor superseded-store` saw the rows but
 * could only say "reconcile the contents first", with no command to do it.
 *
 * This module is that command's engine. It does NOT write a second copier: the
 * copy is {@link runExodusMigrate} (same transforms, receipts and recovery),
 * restricted to the project target. What it adds is the envelope:
 *
 * - **Assessment by key, not count.** For every legacy table the number of
 *   source rows whose primary key is ABSENT from the live table. A count can
 *   look complete while unrelated rows written into the empty shell mask real
 *   gaps; a key cannot.
 * - **Additive only.** `INSERT OR IGNORE` never overwrites or duplicates a row
 *   already in `cleo.db`; the legacy files are read-only inputs and are never
 *   moved, archived or deleted.
 * - **Verified or reverted.** After the copy the assessment is re-run; any
 *   missing key (or a live table that shrank) reverts exactly the rows this run
 *   inserted, via their receipts, and the outcome is `refused`.
 * - **Idempotent.** A fully reconciled project is a no-op: nothing is written.
 *
 * @module
 * @task T12319
 * @see ./migrate.ts — the single copy engine
 * @see ../../doctor/superseded-store.ts — the survey that points here
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  SupersededStoreConflict,
  SupersededStoreReconcileResult,
  SupersededStoreTableCount,
} from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import { resolveCleoDir } from '../../paths.js';
import { resolveDualScopeDbPath } from '../dual-scope-db.js';
import { lockCompromiseTracker, withLock } from '../lock.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { rowIdentityColumns } from '../row-identity-registry.js';
import { EXODUS_LOCK_STALE_MS, exodusRunLockPath, whileExodusRunHeld } from './abort-events.js';
// Loaded on demand: the exodus barrel is on the CLI open path (gate 39).
import type { BareStrandSource } from './bare-family.js';
import { legacyRowProjection } from './column-transforms.js';
import { runExodusMigrate } from './migrate.js';
import { buildExodusPlan } from './plan.js';
import { rollbackExodusReceipts } from './recovery.js';
import { buildRuntimeTargetResolver, type TargetResolver } from './runtime-targets.js';
import { resolveConsolidatedTableName, resolveTableTargetScope } from './table-name-map.js';
import { countRows, hasTable, ident, orderTablesForCopy } from './table-order.js';
import {
  describeRemaps,
  describeUndecided,
  remapCollidingTaskIds,
  type TaskIdRemapResult,
  unlandedRemaps,
} from './task-id-remap.js';
import { BARE_SOURCE_NAME, BARE_STRANDS_SOURCE_NAME, type LegacyDbDescriptor } from './types.js';

const log = getLogger('exodus-reconcile');

/** Prefix of a reconcile staging dir — deliberately NOT `exodus-staging-`, which on-open resumes. */
const RECONCILE_DIR_PREFIX = 'exodus-reconcile-' as const;

/** Receipt filename written inside the reconcile staging dir. */
const RECEIPT_FILENAME = 'reconcile-receipt.json' as const;

/**
 * Count rows of the attached legacy table whose primary key is absent from the
 * live table, or `null` when the tables share no complete primary key.
 */
function countMissing(
  live: DatabaseSync,
  alias: string,
  sourceTable: string,
  targetTable: string,
  transformTable: string,
): number | null {
  const targetPk = (
    live.prepare(`PRAGMA main.table_info(${ident(targetTable)})`).all() as Array<{
      name: string;
      pk: number;
    }>
  )
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  const sourceCols = new Set(
    (
      live.prepare(`PRAGMA ${ident(alias)}.table_info(${ident(sourceTable)})`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name),
  );
  // A projected key (e.g. release_manifests.id → 'legacy:' || version, T12346)
  // is compared in its PROJECTED form — the form migrate writes.
  const projection = legacyRowProjection(transformTable, sourceTable);
  const sourceKey = (c: string): string | null => {
    const project = projection.get(c);
    if (project) return project((name) => `s.${ident(name)}`);
    return sourceCols.has(c) ? `s.${ident(c)}` : null;
  };
  if (targetPk.length === 0 || !targetPk.every((c) => sourceKey(c) !== null)) return null;
  const match = targetPk.map((c) => `t.${ident(c)} = ${sourceKey(c)}`).join(' AND ');
  const row = live
    .prepare(
      `SELECT COUNT(*) AS n FROM ${ident(alias)}.${ident(sourceTable)} s ` +
        `WHERE NOT EXISTS (SELECT 1 FROM main.${ident(targetTable)} t WHERE ${match})`,
    )
    .get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Account for every data-bearing legacy project table against the live store.
 *
 * Read-only on both sides: the live store is opened `readOnly` and each legacy
 * file is ATTACHed to that connection, which SQLite opens read-only too.
 *
 * @param liveStorePath - Absolute path of the live project `cleo.db`.
 * @param sources - Existing project-scope legacy sources.
 * @param resolveTarget - Where each legacy table lands; a reconcile passes the
 *   runtime-read targets ({@link buildRuntimeTargetResolver}).
 * @returns One entry per legacy table holding rows, in copy order.
 * @task T12319
 */
export function assessSupersededProjectStores(
  liveStorePath: string,
  sources: readonly LegacyDbDescriptor[],
  resolveTarget: TargetResolver = resolveConsolidatedTableName,
): SupersededStoreTableCount[] {
  const counts: SupersededStoreTableCount[] = [];
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  try {
    sources.forEach((src, index) => {
      const alias = `_reconcile_src_${index}`;
      live.db.exec(`ATTACH DATABASE '${src.path.replace(/'/g, "''")}' AS ${ident(alias)}`);
      const snap = openCleoDbSnapshot(src.path, { readOnly: true });
      try {
        for (const sourceTable of orderTablesForCopy(snap.db)) {
          const resolution = resolveTarget(src.name, sourceTable);
          const consolidated = resolveConsolidatedTableName(src.name, sourceTable);
          const transformTable =
            consolidated.kind === 'skip' ? sourceTable : consolidated.targetName;
          if (resolution.kind === 'skip') continue;
          if (resolveTableTargetScope(src.name, sourceTable, 'project') !== 'project') continue;
          const sourceRows = countRows(live.db, alias, sourceTable);
          if (sourceRows === 0) continue;
          const targetTable = resolution.targetName;
          const present = hasTable(live.db, 'main', targetTable);
          counts.push({
            sourceDb: src.name,
            sourceTable,
            targetTable,
            sourceRows,
            liveRows: present ? countRows(live.db, 'main', targetTable) : 0,
            missingInLive: present
              ? countMissing(live.db, alias, sourceTable, targetTable, transformTable)
              : sourceRows,
          });
        }
      } finally {
        snap.close();
        live.db.exec(`DETACH DATABASE ${ident(alias)}`);
      }
    });
  } finally {
    live.close();
  }
  return counts;
}

/**
 * Whether any of `sources` holds at least one row in a table exodus would copy.
 *
 * Cheap by construction — stops at the first non-empty table — because it runs
 * on the open path whenever a consolidated store is empty and its migration is
 * being skipped, to decide whether that skip is stranding real data.
 *
 * @param sources - Legacy source descriptors of ONE scope.
 * @returns `true` when a legacy file still holds copyable rows.
 * @task T12319
 */
export function legacySourcesHoldRows(sources: readonly LegacyDbDescriptor[]): boolean {
  for (const src of sources) {
    if (!existsSync(src.path)) continue;
    const snap = openCleoDbSnapshot(src.path, { readOnly: true });
    try {
      for (const table of orderTablesForCopy(snap.db)) {
        if (resolveConsolidatedTableName(src.name, table).kind === 'skip') continue;
        if (snap.db.prepare(`SELECT 1 AS ok FROM ${ident(table)} LIMIT 1`).get() !== undefined)
          return true;
      }
    } finally {
      snap.close();
    }
  }
  return false;
}

/**
 * From the bare task-core snapshot, extract the rows that are strictly NEWER
 * (`updated_at`) than the same-key row in the legacy `tasks.db`, into their own
 * file — copied FIRST so the fresher version of a task wins.
 *
 * Legacy files normally hold the newer copy, but not always: in forge-ts 58 of
 * the 65 tasks that differ were last updated in `cleo.db`'s bare table (7 with
 * a different status). Copy order alone decides which version `INSERT OR
 * IGNORE` keeps, so the freshest rows are given their own, earlier source.
 *
 * @returns The file path, or `null` when no bare row is fresher.
 */
function snapshotFresherBareRows(
  barePath: string,
  legacyTasksPath: string | undefined,
  stagingDir: string,
): string | null {
  if (legacyTasksPath === undefined) return null;
  const path = join(stagingDir, 'cleo-bare-task-core-fresher.db');
  const snap = openCleoDbSnapshot(barePath, { readOnly: true });
  try {
    snap.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  } finally {
    snap.close();
  }
  const fresher = openCleoDbSnapshot(path, { readOnly: false });
  let kept = 0;
  try {
    fresher.db.exec('PRAGMA foreign_keys=OFF');
    fresher.db.exec(`ATTACH DATABASE '${legacyTasksPath.replace(/'/g, "''")}' AS legacy`);
    const tables = (
      fresher.db.prepare("SELECT name FROM main.sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    for (const table of tables) {
      const cols = fresher.db.prepare(`PRAGMA main.table_info(${ident(table)})`).all() as Array<{
        name: string;
        pk: number;
      }>;
      const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
      const inLegacy = hasTable(fresher.db, 'legacy', table);
      const legacyCols = inLegacy
        ? new Set(
            (
              fresher.db.prepare(`PRAGMA legacy.table_info(${ident(table)})`).all() as Array<{
                name: string;
              }>
            ).map((c) => c.name),
          )
        : new Set<string>();
      const comparable =
        inLegacy &&
        pk.length > 0 &&
        cols.some((c) => c.name === 'updated_at') &&
        legacyCols.has('updated_at') &&
        pk.every((k) => legacyCols.has(k));
      if (!comparable) {
        fresher.db.exec(`DELETE FROM main.${ident(table)}`);
        continue;
      }
      const match = pk.map((k) => `l.${ident(k)} = b.${ident(k)}`).join(' AND ');
      fresher.db.exec(
        `DELETE FROM main.${ident(table)} WHERE rowid NOT IN (SELECT b.rowid FROM main.${ident(table)} b ` +
          `JOIN legacy.${ident(table)} l ON ${match} WHERE COALESCE(b.updated_at, '') > COALESCE(l.updated_at, ''))`,
      );
      kept += countRows(fresher.db, 'main', table);
    }
  } finally {
    fresher.close();
  }
  return kept > 0 ? path : null;
}

/** Whether an assessment shows every legacy row present in the live store. */
function isComplete(counts: readonly SupersededStoreTableCount[]): boolean {
  return counts.every((c) =>
    c.missingInLive === null ? c.liveRows >= c.sourceRows : c.missingInLive === 0,
  );
}

/** Tables whose live row count went DOWN between two assessments (never expected). */
function shrunk(
  before: readonly SupersededStoreTableCount[],
  after: readonly SupersededStoreTableCount[],
): string[] {
  return after
    .filter((a) => {
      const b = before.find((x) => x.sourceDb === a.sourceDb && x.sourceTable === a.sourceTable);
      return b !== undefined && a.liveRows < b.liveRows;
    })
    .map((a) => a.targetTable);
}

/** Human-readable list of the tables that still have rows missing. */
function describeGaps(counts: readonly SupersededStoreTableCount[]): string {
  return counts
    .filter((c) => (c.missingInLive === null ? c.liveRows < c.sourceRows : c.missingInLive > 0))
    .map(
      (c) =>
        `${c.targetTable} (${c.missingInLive ?? c.sourceRows - c.liveRows} of ${c.sourceRows} missing)`,
    )
    .join(', ');
}

/** Revert every row this reconcile inserted, proven by its receipts. */
async function revertReconcile(liveStorePath: string, stagingDir: string): Promise<number> {
  const { getDualScopeNativeDb, openDualScopeDbAtPath } = await import('../dual-scope-db.js');
  const handle = await openDualScopeDbAtPath('project', liveStorePath, undefined, {
    dedicated: true,
  });
  try {
    return rollbackExodusReceipts(getDualScopeNativeDb(handle), stagingDir);
  } finally {
    handle.close();
  }
}

/**
 * Legacy tasks tables whose rows are history, wherever the runtime reads them:
 * a missing legacy row was, as a rule, never written live, so an additive run
 * may fill it in, even after the runtime re-points the table at its prefixed
 * twin (`token_usage` → `tasks_token_usage`, T13111). Named, not inferred from
 * the rename.
 *
 * Not strictly append-only: `pipeline.manifest.compact` deletes duplicate
 * `pipeline_manifest` rows (same content hash, the newest kept), and
 * `cleo token delete` / `clear` delete token rows. An additive reconcile can
 * bring such a deleted row back from the legacy store; for a compacted
 * duplicate that is one extra copy of an entry the live table still holds.
 */
const APPEND_ONLY_HISTORY: ReadonlySet<string> = new Set([
  'audit_log',
  'pipeline_manifest',
  'token_usage',
]);

/**
 * Whether a legacy table's runtime home belongs to the task graph the project
 * edits live — derived, like every target, from the runtime bindings: a tasks
 * table the runtime re-points at a prefixed twin (`tasks`, `task_dependencies`,
 * `task_acceptance_criteria`, `lifecycle_*`, …). A missing legacy row there may
 * have been deleted or rewritten since the cutover, so an additive run never
 * writes it. History tables ({@link APPEND_ONLY_HISTORY}, read under their own
 * name or not) and brain/conduit rows are append-only and may be filled in.
 */
function isLiveAuthoritative(sourceName: string, legacyTable: string, target: string): boolean {
  return (
    sourceName.toLowerCase().startsWith('tasks') &&
    target !== legacyTable &&
    !APPEND_ONLY_HISTORY.has(legacyTable)
  );
}

/** Every legacy row set an assessment shows as still missing, as conflicts. */
function conflictsOf(counts: readonly SupersededStoreTableCount[]): SupersededStoreConflict[] {
  return counts
    .map((c) => ({
      c,
      rows: c.missingInLive ?? Math.max(0, c.sourceRows - c.liveRows),
    }))
    .filter(({ rows }) => rows > 0)
    .map(({ c, rows }) => ({
      sourceDb: c.sourceDb,
      sourceTable: c.sourceTable,
      targetTable: c.targetTable,
      rows,
      reason: isLiveAuthoritative(c.sourceDb, c.sourceTable, c.targetTable)
        ? ('live-authoritative' as const)
        : ('collides-with-live' as const),
    }));
}

/** One line naming every conflict. */
function describeConflicts(conflicts: readonly SupersededStoreConflict[]): string {
  if (conflicts.length === 0) return 'no conflicts';
  return `left ${conflicts.reduce((n, c) => n + c.rows, 0)} row(s) uncopied: ${conflicts
    .map((c) => `${c.targetTable} ${c.rows} (${c.reason})`)
    .join(', ')}`;
}

/** Full-fidelity snapshot of the live store (reads through WAL). */
function snapshotLive(liveStorePath: string, to: string): void {
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  try {
    live.db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    live.close();
  }
}

/**
 * Tables among the copy targets in which a row that existed before the copy is
 * no longer present unchanged — compared over the columns both shapes share,
 * so a column a migration ADDS during the run is not an alteration, while a
 * dropped column that held data is. The tasks-domain default `task_id_sequence` is
 * not data (the sequence module treats it as "no state") and is expected to
 * yield to a legacy counter, so `sequenceSeed` rows are exempt.
 */
function alteredLiveTables(
  liveStorePath: string,
  beforePath: string,
  counts: readonly SupersededStoreTableCount[],
  sequenceSeed: string,
): string[] {
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  try {
    live.db.exec(`ATTACH DATABASE '${beforePath.replace(/'/g, "''")}' AS before`);
    const altered: string[] = [];
    for (const table of new Set(counts.map((c) => c.targetTable))) {
      if (!hasTable(live.db, 'before', table) || !hasTable(live.db, 'main', table)) continue;
      const seed =
        table === 'tasks_schema_meta'
          ? ` WHERE NOT (key = 'task_id_sequence' AND value = '${sequenceSeed.replace(/'/g, "''")}')`
          : '';
      // The table's SHAPE may legitimately change during the run: the
      // tasks-domain lineage step can rebuild a bare table with new columns
      // (T12346; claude-todo). Decided deliberately:
      // - a column ADDED by a migration is not an alteration of any
      //   pre-existing row — it did not exist before, so it is not compared;
      // - a column DROPPED is an alteration if it held any value — that data is
      //   no longer in the row — and harmless if it was NULL throughout;
      // - every column both shapes share must still hold every prior row,
      //   except the row-identity columns (T12341): a NULL uid on a row an
      //   older build wrote is filled by the open pass, which is not a change
      //   to that row.
      const colsOf = (schema: string): string[] =>
        (
          live.db.prepare(`PRAGMA ${ident(schema)}.table_info(${ident(table)})`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name);
      const after = new Set(colsOf('main'));
      const beforeCols = colsOf('before');
      const dropped = beforeCols.filter((c) => !after.has(c));
      const droppedWithData = dropped.filter(
        (c) =>
          Number(
            (
              live.db
                .prepare(
                  `SELECT COUNT(*) AS n FROM before.${ident(table)} WHERE ${ident(c)} IS NOT NULL`,
                )
                .get() as { n: number } | undefined
            )?.n ?? 0,
          ) > 0,
      );
      if (droppedWithData.length > 0) {
        altered.push(`${table} (dropped populated column(s): ${droppedWithData.join(', ')})`);
        continue;
      }
      const identity = new Set(rowIdentityColumns('project', table));
      const shared = beforeCols.filter((c) => after.has(c) && !identity.has(c));
      if (shared.length === 0) {
        altered.push(table);
        continue;
      }
      const list = shared.map(ident).join(', ');
      const row = live.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT ${list} FROM before.${ident(table)}${seed} EXCEPT SELECT ${list} FROM main.${ident(table)})`,
        )
        .get() as { n: number } | undefined;
      if (Number(row?.n ?? 0) > 0) altered.push(table);
    }
    return altered;
  } finally {
    live.close();
  }
}

/**
 * The unmigrated `cleo.db`'s own dead bare task-core family as exodus sources,
 * for exodus-on-open (T12355): the same source the reconcile reads, so the two
 * converge whichever runs first — without it, on-open left e.g. llmtxt's 1,972
 * bare-only `task_labels` behind while a reconcile recovered them.
 *
 * @param liveStorePath - The project `cleo.db` being migrated.
 * @param resolveTarget - The runtime target resolver.
 * @param legacyTasksPath - The legacy `tasks.db`, if present (its fresher-row comparison).
 * @param outDir - Scratch directory the materialised sources are written to.
 * @returns Sources to copy BEFORE the legacy files (bare rows newer than their
 *   legacy copy) and AFTER them (the rest of the bare family); both empty when
 *   the bare family is not a source.
 * @task T12355
 */
export async function unmigratedBareSources(
  liveStorePath: string,
  resolveTarget: TargetResolver,
  legacyTasksPath: string | undefined,
  outDir: string,
): Promise<{ first: LegacyDbDescriptor[]; last: LegacyDbDescriptor[] }> {
  const { bareTaskCoreSource } = await import('./bare-family.js');
  const bare = await bareTaskCoreSource(liveStorePath, resolveTarget, outDir);
  if (bare === null) return { first: [], last: [] };
  const fresher = snapshotFresherBareRows(bare.path, legacyTasksPath, outDir);
  return {
    first:
      fresher === null
        ? []
        : [{ name: `${BARE_SOURCE_NAME} (fresher)`, path: fresher, targetScope: 'project' }],
    last: [bare],
  };
}

/** The receipt name a rolled-back run's receipt is renamed to (T13309). */
const ROLLED_BACK_RECEIPT_FILENAME = 'reconcile-receipt.rolled-back.json' as const;

/** Result of {@link rollbackSupersededReconcile}. */
export interface SupersededReconcileRollback {
  /** The run directory whose rows were reverted. */
  readonly runDir: string;
  /** Rows reverted. */
  readonly rowsReverted: number;
  /** Where the receipt now lives (renamed so later runs and checks ignore it). */
  readonly receiptPath: string;
}

/**
 * Revert a reconciled run from its receipt (T13309): every row it inserted is
 * removed, but only when each is still exactly as the run wrote it (the
 * exodus receipts guard refuses the whole revert otherwise). Holds the store's
 * exodus lock, so no reconcile or exodus-on-open runs alongside. The receipt
 * is renamed, so neither a later run's earlier-recoveries scan nor the sync
 * check for stranded bare rows trusts it again.
 *
 * @param projectRoot - Absolute project root.
 * @param runDir - The run directory (`.cleo/exodus-reconcile-<iso>`), absolute
 *   or relative to the project's `.cleo`.
 * @throws When `runDir` is not a reconciled run of this project, or a row the
 *   run inserted has changed since.
 * @example
 * ```ts
 * await rollbackSupersededReconcile('/p', 'exodus-reconcile-20261007T020000Z');
 * ```
 */
export async function rollbackSupersededReconcile(
  projectRoot: string,
  runDir: string,
): Promise<SupersededReconcileRollback> {
  const cleoDir = resolveCleoDir(projectRoot);
  const dir = isAbsolute(runDir) ? runDir : join(cleoDir, runDir);
  const receiptPath = join(dir, RECEIPT_FILENAME);
  if (dirname(dir) !== cleoDir || !basename(dir).startsWith(RECONCILE_DIR_PREFIX)) {
    // @sync-invariant none:local-only rolling back a local reconcile run is refused before any write; never replicated
    throw new Error(`${runDir} is not a reconcile run directory under ${cleoDir}`);
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    // @sync-invariant none:local-only rolling back a local reconcile run is refused before any write; never replicated
    throw new Error(`no reconcile receipt at ${receiptPath}`);
  }
  const outcome =
    typeof receipt === 'object' && receipt !== null && 'outcome' in receipt
      ? receipt.outcome
      : undefined;
  if (outcome !== 'reconciled') {
    // @sync-invariant none:local-only rolling back a local reconcile run is refused before any write; never replicated
    throw new Error(
      `${receiptPath} records outcome ${String(outcome)}; only a reconciled run can be rolled back`,
    );
  }
  const liveStorePath = resolveDualScopeDbPath('project', projectRoot);
  const lock = lockCompromiseTracker();
  const lockPath = exodusRunLockPath(liveStorePath);
  const rowsReverted = await withLock(
    lockPath,
    whileExodusRunHeld(lockPath, async () => revertReconcile(liveStorePath, dir)),
    { stale: EXODUS_LOCK_STALE_MS, retries: 30, onCompromised: lock.onCompromised },
  );
  const rolledBack = join(dir, ROLLED_BACK_RECEIPT_FILENAME);
  renameSync(receiptPath, rolledBack);
  log.info({ runDir: dir, rowsReverted }, 'exodus-reconcile: rolled back');
  return { runDir: dir, rowsReverted, receiptPath: rolledBack };
}

/** Options of {@link reconcileSupersededStores}. */
export interface ReconcileOptions {
  /** Assess and report without writing anything. */
  readonly dryRun?: boolean;
  /** Copy only history rows whose keys live lacks; never write the task graph. */
  readonly additive?: boolean;
  /**
   * Copy the live store's stranded bare rows into its populated prefixed
   * tables (T13309); see {@link bareStrandSource}. Wins over `additive`.
   */
  readonly bareStrands?: boolean;
}

/** Create a fresh run directory under `.cleo/` for a reconcile apply. */
function newRunDir(cleoDir: string): string {
  const iso = new Date()
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\..+Z$/, 'Z');
  const dir = join(cleoDir, `${RECONCILE_DIR_PREFIX}${iso}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write `result`'s receipt into its run directory and return it with the path. */
function writeReceipt(
  result: SupersededStoreReconcileResult,
  stagingDir: string,
): SupersededStoreReconcileResult {
  const receiptPath = join(stagingDir, RECEIPT_FILENAME);
  const receipt = { ...result, receiptPath };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  log.info(
    { outcome: receipt.outcome, rowsCopied: receipt.rowsCopied, receiptPath },
    `exodus-reconcile: ${receipt.reason}`,
  );
  return receipt;
}

/**
 * A bare-strands run with nothing to copy but rows it deliberately skipped:
 * record a `reconciled` receipt that names them and accounts for every bare
 * table, so the sync refusal for stranded rows stands down (T13309). A dry
 * run only reports.
 */
function settleStrands(
  none: SupersededStoreReconcileResult,
  strands: BareStrandSource,
  cleoDir: string,
): SupersededStoreReconcileResult {
  if (none.dryRun) return none;
  const stagingDir = newRunDir(cleoDir);
  return writeReceipt(
    {
      ...none,
      outcome: 'reconciled',
      stagingDir,
      accounted: strands.accounted,
      snapshotPath: null,
      reason: `nothing copied; ${none.reason}`,
    },
    stagingDir,
  );
}

/** A renumbering of the stranded bare rows, under their own source name. */
function asStrandRemap(remap: TaskIdRemapResult): TaskIdRemapResult {
  return {
    ...remap,
    sources: remap.sources.map((s) => ({ ...s, name: BARE_STRANDS_SOURCE_NAME })),
    remaps: remap.remaps.map((r) => ({ ...r, sourceDb: BARE_STRANDS_SOURCE_NAME })),
    undecided: remap.undecided && { ...remap.undecided, sourceDb: BARE_STRANDS_SOURCE_NAME },
  };
}

/**
 * Reconcile a project's stranded legacy stores into its live `cleo.db`.
 *
 * @param projectRoot - Absolute project root.
 * @param options - `dryRun` assesses and reports without writing anything;
 *   `bareStrands` copies the live store's stranded bare rows (T13309).
 * @returns The receipt; `outcome: 'refused'` means the copy did not verify and
 *   every row it inserted was reverted.
 * @example
 * ```ts
 * const plan = await reconcileSupersededStores('/mnt/projects/llmtxt', { dryRun: true });
 * for (const t of plan.before) console.log(t.targetTable, t.missingInLive);
 * ```
 * @task T12319
 */
export async function reconcileSupersededStores(
  projectRoot: string,
  options: ReconcileOptions = {},
): Promise<SupersededStoreReconcileResult> {
  const liveStorePath = resolveDualScopeDbPath('project', projectRoot);
  // Never let exodus-on-open fire for this store while it is being reconciled
  // (it would archive the legacy files mid-run). Everything — including the
  // plan's source discovery — happens inside the suppression.
  const { withExodusOnOpenSuppressed } = await import('./on-open.js');
  return withExodusOnOpenSuppressed(liveStorePath, () =>
    reconcileSuppressed(projectRoot, options, liveStorePath),
  );
}

/** {@link reconcileSupersededStores} with exodus-on-open suppressed for the store. */
async function reconcileSuppressed(
  projectRoot: string,
  options: ReconcileOptions,
  liveStorePath: string,
): Promise<SupersededStoreReconcileResult> {
  const dryRun = options.dryRun === true;
  const mode: SupersededStoreReconcileResult['mode'] =
    options.bareStrands === true ? 'bare-strands' : options.additive === true ? 'additive' : 'full';
  const plan = buildExodusPlan(projectRoot);
  // Rows land where the RUNTIME reads them (T12346), derived from its bindings.
  const resolveTarget = await buildRuntimeTargetResolver();
  // Scratch space for the materialised bare-family source; outside the project
  // so a dry-run writes nothing there (an apply copies it into its staging dir).
  const scratch = mkdtempSync(join(tmpdir(), 'cleo-reconcile-'));
  try {
    return await reconcileWithScratch(
      projectRoot,
      dryRun,
      mode,
      liveStorePath,
      plan,
      resolveTarget,
      scratch,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The body of {@link reconcileSupersededStores}, with a scratch dir it owns. */
async function reconcileWithScratch(
  projectRoot: string,
  dryRun: boolean,
  mode: SupersededStoreReconcileResult['mode'],
  liveStorePath: string,
  plan: ReturnType<typeof buildExodusPlan>,
  resolveTarget: TargetResolver,
  scratch: string,
): Promise<SupersededStoreReconcileResult> {
  const additive = mode === 'additive';
  const strandsMode = mode === 'bare-strands';
  const cleoDir = resolveCleoDir(projectRoot);
  const legacyFiles = plan.sources.filter((s) => s.targetScope === 'project' && existsSync(s.path));
  // Bare-strands mode (T13309) reads only the live store's stranded bare rows,
  // and only once the legacy files are carried: a full run recovers a legacy
  // task whose id was reused, and this run then finds that recovery in the
  // full run's receipt instead of recovering the same task a second time.
  if (strandsMode && legacyFiles.length > 0 && existsSync(liveStorePath)) {
    const pending = assessSupersededProjectStores(liveStorePath, legacyFiles, resolveTarget);
    if (!isComplete(pending)) {
      return {
        outcome: 'nothing-to-reconcile',
        mode,
        conflicts: [],
        remaps: [],
        dryRun,
        projectRoot,
        liveStorePath,
        sourcePaths: legacyFiles.map((s) => s.path),
        before: pending,
        after: [],
        rowsCopied: 0,
        rolledBack: 0,
        stagingDir: null,
        receiptPath: null,
        reason:
          `legacy files still hold rows missing from cleo.db (${describeGaps(pending)}); run ` +
          '`cleo doctor superseded-store --reconcile` first, then the bare-strands reconcile',
      };
    }
  }
  const strands =
    strandsMode && existsSync(liveStorePath)
      ? await (await import('./bare-family.js')).bareStrandSource(
          liveStorePath,
          resolveTarget,
          scratch,
          cleoDir,
        )
      : null;
  // Rows bare-strands mode deliberately leaves uncopied, named in the receipt.
  const skipped = strands?.skipped ?? [];
  // What the renumbering reads: the legacy files, or the stranded bare rows
  // under the name the renumbering looks for.
  const originals = strandsMode ? (strands?.source ? [strands.source] : []) : legacyFiles;
  // T13172: a legacy task whose id a DIFFERENT live task holds is renumbered in
  // a scratch copy (references re-pointed) and the run reads that copy, so it
  // is recovered, never skipped by INSERT OR IGNORE and counted as present.
  // Additive runs never write the task graph, so they never renumber.
  const remap =
    !additive && existsSync(liveStorePath)
      ? strandsMode
        ? asStrandRemap(
            remapCollidingTaskIds(
              liveStorePath,
              originals.map((s) => ({ ...s, name: 'tasks' })),
              scratch,
              cleoDir,
            ),
          )
        : remapCollidingTaskIds(liveStorePath, legacyFiles, scratch, cleoDir)
      : { sources: legacyFiles, remaps: [], undecided: null, remappedPath: null };
  // An undecided collision withholds the WHOLE task graph (review MED-2): its
  // children, dependencies and criteria would otherwise attach to the live
  // task that holds its id. History tables still copy, and from the ORIGINAL
  // legacy files: the renumbered copy would point history rows at fresh ids
  // no live task holds, which the next `cleo add` could then mint (review LOW).
  const graphWithheld = !additive && remap.undecided !== null;
  const fileSources = graphWithheld ? originals : remap.sources;
  // The receipt records each remap with the legacy creation time and type,
  // which later runs check before trusting it (T13183).
  const remaps = remap.remaps;
  // A collision the run cannot decide is left uncopied and named, so the
  // receipt never claims every legacy row is present (review MED-2).
  const undecided = remap.undecided;
  const remapNote =
    (remaps.length > 0 ? `; ${describeRemaps(remaps)}` : '') +
    (undecided ? `; ${describeUndecided(undecided)}` : '');
  // An additive run is for a project already live on the consolidated store;
  // its bare family is not a source (and bareTaskCoreSource agrees).
  const bare =
    !additive && !strandsMode && existsSync(liveStorePath)
      ? await (await import('./bare-family.js')).bareTaskCoreSource(
          liveStorePath,
          resolveTarget,
          scratch,
        )
      : null;
  // Additive (and a full run with an undecided collision): the live task
  // graph is never written — only history tables.
  const copyResolver: TargetResolver =
    additive || graphWithheld
      ? (sourceName, legacyTable) => {
          const r = resolveTarget(sourceName, legacyTable);
          return r.kind !== 'skip' && isLiveAuthoritative(sourceName, legacyTable, r.targetName)
            ? {
                kind: 'skip',
                reason: additive
                  ? 'additive: live-authoritative task graph'
                  : 'task graph withheld: an id collision is undecided',
              }
            : r;
        }
      : resolveTarget;
  // Legacy FILES first so they win any key both hold; the bare family fills gaps.
  const sources = bare ? [...fileSources, bare] : fileSources;
  const base = {
    mode,
    conflicts: [...(undecided ? [undecided] : []), ...skipped] as SupersededStoreConflict[],
    // A withheld graph copies no task, so no remap is applied.
    remaps: graphWithheld ? [] : remaps,
    dryRun,
    projectRoot,
    liveStorePath,
    // The files read: the legacy originals, never the renumbered scratch copy.
    sourcePaths: strandsMode
      ? [liveStorePath]
      : [...legacyFiles, ...(bare ? [bare] : [])].map((s) => s.path),
    after: [] as SupersededStoreTableCount[],
    rowsCopied: 0,
    rolledBack: 0,
    stagingDir: null,
    receiptPath: null,
  };

  if (sources.length === 0 || !existsSync(liveStorePath)) {
    const none: SupersededStoreReconcileResult = {
      ...base,
      outcome: 'nothing-to-reconcile',
      before: [],
      reason: !existsSync(liveStorePath)
        ? `no live store at ${liveStorePath}; the legacy files are still the live data`
        : strandsMode
          ? strands?.populated === false
            ? 'tasks_tasks is empty: the bare family is copied whole by `cleo doctor superseded-store --reconcile`'
            : `no stranded bare row is left to copy${skipped.length > 0 ? `; ${describeConflicts(skipped)}` : ''}`
          : 'no legacy project store (tasks.db / brain.db / conduit.db, or bare task tables in an unmigrated cleo.db) is present',
    };
    return strands && skipped.length > 0 ? settleStrands(none, strands, cleoDir) : none;
  }

  const before = assessSupersededProjectStores(liveStorePath, sources, resolveTarget);
  const plannedConflicts = additive ? conflictsOf(before) : [];
  // Every task-graph row a withheld run leaves uncopied, named in the receipt.
  const withheldOf = (counts: readonly SupersededStoreTableCount[]): SupersededStoreConflict[] =>
    conflictsOf(counts)
      .filter((c) => c.reason === 'live-authoritative')
      .map((c) => ({ ...c, reason: 'withheld-undecided' as const }));
  const withheldConflicts = (counts: readonly SupersededStoreTableCount[]) =>
    undecided ? [undecided, ...withheldOf(counts), ...skipped] : skipped;
  const withheldNote = (counts: readonly SupersededStoreTableCount[]) =>
    `; the task graph was NOT copied: ${undecided ? describeUndecided(undecided) : ''}. ` +
    `Withheld: ${describeConflicts(withheldOf(counts))}. Correct the legacy created_at of ` +
    `${(undecided?.ids ?? []).join(', ')} to an ISO-8601 time, then run the reconcile again`;
  // Additive: gaps that are ALL live-authoritative leave nothing to copy.
  const onlyConflicts =
    additive &&
    plannedConflicts.length > 0 &&
    plannedConflicts.every((c) => c.reason === 'live-authoritative');
  if (onlyConflicts) {
    return {
      ...base,
      conflicts: plannedConflicts,
      outcome: 'nothing-to-reconcile',
      before,
      reason: `every history row is already present; ${describeConflicts(plannedConflicts)}`,
    };
  }
  if (
    graphWithheld &&
    withheldOf(before).length > 0 &&
    withheldOf(before).length === conflictsOf(before).length
  ) {
    return {
      ...base,
      conflicts: withheldConflicts(before),
      outcome: 'nothing-to-reconcile',
      before,
      reason: `every history row is already present${withheldNote(before)}`,
    };
  }
  if (isComplete(before)) {
    const none: SupersededStoreReconcileResult = {
      ...base,
      outcome: 'nothing-to-reconcile',
      before,
      reason: `${undecided ? 'every other legacy row' : 'every legacy row'} is already present in cleo.db — nothing to copy${graphWithheld ? (undecided ? `; ${describeUndecided(undecided)}` : '') : remapNote}${skipped.length > 0 ? `; ${describeConflicts(skipped)}` : ''}`,
    };
    return strands && skipped.length > 0 && !graphWithheld
      ? settleStrands(none, strands, cleoDir)
      : none;
  }
  if (dryRun) {
    return {
      ...base,
      conflicts: additive
        ? plannedConflicts.filter((c) => c.reason === 'live-authoritative')
        : graphWithheld
          ? withheldConflicts(before)
          : base.conflicts,
      outcome: 'planned',
      before,
      reason: additive
        ? `would copy the missing rows of the history tables; ${describeConflicts(
            plannedConflicts.filter((c) => c.reason === 'live-authoritative'),
          )} (key collisions are counted after the copy)`
        : graphWithheld
          ? `would copy the missing history rows only${withheldNote(before)}`
          : `would copy the missing rows of: ${describeGaps(before)}${remapNote}${skipped.length > 0 ? `; would leave uncopied: ${describeConflicts(skipped)}` : ''}`,
    };
  }

  const stagingDir = newRunDir(cleoDir);
  // Keep the materialised bare source and the renumbered tasks copy with the
  // run's other evidence.
  const copySources = sources.map((s) => {
    if (s !== bare && s.path !== remap.remappedPath && s.name !== BARE_STRANDS_SOURCE_NAME)
      return s;
    const kept = join(stagingDir, basename(s.path));
    copyFileSync(s.path, kept);
    return { ...s, path: kept };
  });
  const bareCopy = copySources.find((s) => s.name === BARE_SOURCE_NAME);
  const fresherPath = bareCopy
    ? snapshotFresherBareRows(
        bareCopy.path,
        fileSources.find((s) => s.name === 'tasks')?.path,
        stagingDir,
      )
    : null;
  if (fresherPath !== null)
    copySources.unshift({
      name: `${BARE_SOURCE_NAME} (fresher)`,
      path: fresherPath,
      targetScope: 'project',
    });
  const reconcilePlan = { ...plan, sources: copySources, stagingDir, resumeFromStaging: false };

  // Serialise with exodus-on-open, which takes the same lock on this target.
  // A lock lost to a long stage stops the run and reverts it (T12785).
  const lock = lockCompromiseTracker();
  const lockPath = exodusRunLockPath(liveStorePath);
  const result = await withLock(
    lockPath,
    whileExodusRunHeld(lockPath, async (): Promise<SupersededStoreReconcileResult> => {
      // Prove "never overwrites": every live row that existed before the copy
      // must still exist, byte for byte, afterwards.
      // Bare-strands mode keeps this snapshot with the receipt (T13309).
      const liveBefore = join(strandsMode ? stagingDir : scratch, 'live-before.db');
      snapshotLive(liveStorePath, liveBefore);
      const copied = await runExodusMigrate(reconcilePlan, false, (msg) => log.debug(msg), {
        projectOnly: true,
        resolveTarget: copyResolver,
        ensureRuntimeTables: true,
        abortReason: lock.reason,
      });
      const lockLost = lock.reason();
      const migrated =
        copied.ok && lockLost !== null
          ? { ...copied, ok: false, error: `E_EXODUS_LOCK_LOST: ${lockLost}` }
          : copied;
      const rowsCopied = migrated.tables.reduce((n, t) => n + t.rowsCopied, 0);
      const after = migrated.ok
        ? assessSupersededProjectStores(liveStorePath, sources, resolveTarget)
        : [];
      const lost = shrunk(before, after);
      const { TASK_ID_SEQUENCE_SEED } = await import('../sqlite.js');
      let altered: string[] = [];
      if (migrated.ok) {
        try {
          altered = alteredLiveTables(liveStorePath, liveBefore, before, TASK_ID_SEQUENCE_SEED);
        } catch (error) {
          // An unverifiable run is refused and reverted, never reported as done.
          altered = [
            `(verification failed: ${error instanceof Error ? error.message : String(error)})`,
          ];
        }
      }
      const conflicts = additive
        ? conflictsOf(after)
        : graphWithheld
          ? withheldConflicts(after)
          : base.conflicts;
      const settled = additive || graphWithheld ? true : isComplete(after);
      // A recovered task's new id taken by a concurrent write between the
      // allocation and the copy: the copy skipped it, and verification by key
      // would call it present (review LOW-1).
      const unlanded =
        migrated.ok && !graphWithheld ? unlandedRemaps(liveStorePath, remap.remaps) : [];
      if (
        migrated.ok &&
        settled &&
        lost.length === 0 &&
        altered.length === 0 &&
        unlanded.length === 0
      ) {
        return {
          ...base,
          conflicts,
          outcome: 'reconciled',
          before,
          after,
          rowsCopied,
          stagingDir,
          // A settled bare-strands run accounts for each bare table, so the
          // sync refusal for stranded rows stands down (T13309).
          ...(strands && !graphWithheld ? { accounted: strands.accounted } : {}),
          ...(strandsMode ? { snapshotPath: liveBefore } : {}),
          reason: additive
            ? `copied ${rowsCopied} row(s) with keys absent from live; live rows unchanged; ${describeConflicts(conflicts)}`
            : graphWithheld
              ? `copied ${rowsCopied} history row(s)${withheldNote(after)}`
              : strandsMode
                ? `copied ${rowsCopied} stranded bare row(s); every other stranded row is accounted for${remapNote}${skipped.length > 0 ? `; ${describeConflicts(skipped)}` : ''}; live snapshot before the copy: ${liveBefore}`
                : `copied ${rowsCopied} row(s); every legacy row is now present in cleo.db${remapNote}`,
        };
      }
      const rolledBack = await revertReconcile(liveStorePath, stagingDir);
      const cause = !migrated.ok
        ? `copy failed: ${migrated.error ?? `the copy engine gave no message — inspect the journal in ${stagingDir}`}`
        : lost.length > 0
          ? `live tables shrank: ${lost.join(', ')}`
          : altered.length > 0
            ? `pre-existing live rows changed in: ${altered.join(', ')}`
            : unlanded.length > 0
              ? `a concurrent write took the id of a recovered task (${unlanded.join(', ')}); run the reconcile again`
              : `rows still missing after copy: ${describeGaps(after)}`;
      return {
        ...base,
        outcome: 'refused',
        before,
        after,
        rowsCopied,
        rolledBack,
        stagingDir,
        reason: `${cause} — reverted the ${rolledBack} row(s) this run inserted; legacy files untouched`,
      };
    }),
    { stale: EXODUS_LOCK_STALE_MS, retries: 30, onCompromised: lock.onCompromised },
  );

  return writeReceipt(result, stagingDir);
}
