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

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  SupersededStoreReconcileResult,
  SupersededStoreTableCount,
} from '@cleocode/contracts';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { getLogger } from '../../logger.js';
import { resolveCleoDir } from '../../paths.js';
import { resolveDualScopeDbPath } from '../dual-scope-db.js';
import { withLock } from '../lock.js';
import { sanitizeMigrationStatements } from '../migration-manager.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { resolveCorePackageMigrationsFolder } from '../resolve-migrations-folder.js';
import { legacyRowProjection } from './column-transforms.js';
import { orderTablesForCopy, runExodusMigrate } from './migrate.js';
import { buildExodusPlan } from './plan.js';
import { rollbackExodusReceipts } from './recovery.js';
import { buildRuntimeTargetResolver, type TargetResolver } from './runtime-targets.js';
import { resolveConsolidatedTableName, resolveTableTargetScope } from './table-name-map.js';
import type { LegacyDbDescriptor } from './types.js';

const log = getLogger('exodus-reconcile');

/** Prefix of a reconcile staging dir — deliberately NOT `exodus-staging-`, which on-open resumes. */
const RECONCILE_DIR_PREFIX = 'exodus-reconcile-' as const;

/** Receipt filename written inside the reconcile staging dir. */
const RECEIPT_FILENAME = 'reconcile-receipt.json' as const;

/** Quote an SQLite identifier. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Whether `schema.table` exists on `db`. */
function hasTable(db: DatabaseSync, schema: string, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 AS ok FROM ${ident(schema)}.sqlite_master WHERE type='table' AND name=?`)
      .get(table) !== undefined
  );
}

/** Row count of `schema.table`. */
function countRows(db: DatabaseSync, schema: string, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${ident(schema)}.${ident(table)}`).get() as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

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
 * Whether a bare legacy table in the live `cleo.db` is one the runtime NO LONGER
 * reads — i.e. its runtime target is a different (prefixed) table. Derived from
 * the runtime's own table bindings via `resolveTarget`, never a hand-kept list:
 * `tasks` → `tasks_tasks` is dead-bare; `audit_log` → `audit_log` is live.
 *
 * @task T12346
 */
function isRuntimeDeadBare(resolveTarget: TargetResolver, table: string): boolean {
  const target = resolveTarget('tasks', table);
  return target.kind !== 'skip' && target.targetName !== table;
}

/** Logical source name for the live store's bare task-core family. */
const BARE_SOURCE_NAME = 'tasks (cleo.db bare task-core)';

/**
 * The live store's own dead bare task-core family as a reconcile source — item
 * 2 of T12319, found real by the T12346 sweep: a stranded `cleo.db` can hold
 * rows in bare tables the runtime no longer reads that exist in NO legacy file
 * (llmtxt: 1,972 `task_labels`; versionguard: 20 `task_dependencies`).
 *
 * Offered ONLY while the prefixed `tasks_tasks` is still empty — i.e. the
 * project never ran on the consolidated store. Once it has, a bare row missing
 * from the prefixed family may be one the runtime deliberately removed, and
 * re-copying it would resurrect it.
 *
 * Materialised as a standalone file in `outDir` holding exactly the qualifying
 * rows, built table by table from the live file's own DDL (a whole-file copy
 * cannot be pruned: sqlite-vec `vec0` tables cannot be dropped without their
 * module). Rows the drizzle-tasks lineage SEEDS into every fresh store (e.g. its
 * 18 backfilled `commits`) are not project data and are excluded — a fresh
 * project has them bare and not in the prefixed twin, and so must this one.
 * The table set is fixed when the file is built, so the post-copy verification
 * judges exactly what was copied.
 *
 * @returns The descriptor (path = the materialised file), or `null`.
 */
function bareTaskCoreSource(
  liveStorePath: string,
  resolveTarget: TargetResolver,
  outDir: string,
): LegacyDbDescriptor | null {
  const live = openCleoDbSnapshot(liveStorePath, { readOnly: true });
  let tables: Array<{ name: string; sql: string }>;
  try {
    if (hasTable(live.db, 'main', 'tasks_tasks') && countRows(live.db, 'main', 'tasks_tasks') > 0)
      return null;
    tables = (
      live.db
        .prepare("SELECT name, sql FROM main.sqlite_master WHERE type='table' AND sql IS NOT NULL")
        .all() as Array<{ name: string; sql: string }>
    ).filter(
      (t) => isRuntimeDeadBare(resolveTarget, t.name) && countRows(live.db, 'main', t.name) > 0,
    );
  } finally {
    live.close();
  }
  if (tables.length === 0) return null;

  const seedPath = join(outDir, 'drizzle-tasks-seed.db');
  buildLineageSeedDb(seedPath);
  const path = join(outDir, 'cleo-bare-task-core.db');
  const snap = openCleoDbSnapshot(path, { readOnly: false });
  let kept = 0;
  try {
    snap.db.exec('PRAGMA foreign_keys=OFF');
    snap.db.exec(`ATTACH DATABASE '${liveStorePath.replace(/'/g, "''")}' AS live`);
    snap.db.exec(`ATTACH DATABASE '${seedPath.replace(/'/g, "''")}' AS seed`);
    for (const t of tables) {
      snap.db.exec(t.sql);
      snap.db.exec(`INSERT INTO main.${ident(t.name)} SELECT * FROM live.${ident(t.name)}`);
      if (hasTable(snap.db, 'seed', t.name)) {
        const seedCols = new Set(
          (
            snap.db.prepare(`PRAGMA seed.table_info(${ident(t.name)})`).all() as Array<{
              name: string;
            }>
          ).map((c) => c.name),
        );
        const shared = (
          snap.db.prepare(`PRAGMA main.table_info(${ident(t.name)})`).all() as Array<{
            name: string;
          }>
        )
          .map((c) => c.name)
          .filter((c) => seedCols.has(c));
        if (shared.length > 0) {
          const same = shared.map((c) => `s.${ident(c)} IS m.${ident(c)}`).join(' AND ');
          snap.db.exec(
            `DELETE FROM main.${ident(t.name)} AS m WHERE EXISTS (SELECT 1 FROM seed.${ident(t.name)} s WHERE ${same})`,
          );
        }
      }
      const n = countRows(snap.db, 'main', t.name);
      if (n === 0) snap.db.exec(`DROP TABLE main.${ident(t.name)}`);
      kept += n;
    }
    snap.db.exec('DETACH DATABASE live');
    snap.db.exec('DETACH DATABASE seed');
  } finally {
    snap.close();
  }
  return kept > 0 ? { name: BARE_SOURCE_NAME, path, targetScope: 'project' } : null;
}

/**
 * Write a database holding only what the drizzle-tasks lineage itself seeds,
 * by running the lineage on an empty file. Statements that need the rest of a
 * real store (consolidated tables) are skipped — only their seeds would be
 * missed, never project data.
 */
function buildLineageSeedDb(path: string): void {
  const migrations = sanitizeMigrationStatements(
    readMigrationFiles({ migrationsFolder: resolveCorePackageMigrationsFolder('drizzle-tasks') }),
  );
  const seed = openCleoDbSnapshot(path, { readOnly: false });
  try {
    seed.db.exec('PRAGMA foreign_keys=OFF');
    for (const migration of migrations) {
      for (const stmt of migration.sql) {
        try {
          seed.db.exec(stmt);
        } catch {
          // Needs objects a real store has; contributes no seed rows here.
        }
      }
    }
  } finally {
    seed.close();
  }
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
 * Reconcile a project's stranded legacy stores into its live `cleo.db`.
 *
 * @param projectRoot - Absolute project root.
 * @param options - `dryRun` assesses and reports without writing anything.
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
  options: { readonly dryRun?: boolean } = {},
): Promise<SupersededStoreReconcileResult> {
  const dryRun = options.dryRun === true;
  const liveStorePath = resolveDualScopeDbPath('project', projectRoot);
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
  liveStorePath: string,
  plan: ReturnType<typeof buildExodusPlan>,
  resolveTarget: TargetResolver,
  scratch: string,
): Promise<SupersededStoreReconcileResult> {
  const fileSources = plan.sources.filter((s) => s.targetScope === 'project' && existsSync(s.path));
  const bare = existsSync(liveStorePath)
    ? bareTaskCoreSource(liveStorePath, resolveTarget, scratch)
    : null;
  // Legacy FILES first so they win any key both hold; the bare family fills gaps.
  const sources = bare ? [...fileSources, bare] : fileSources;
  const base = {
    dryRun,
    projectRoot,
    liveStorePath,
    sourcePaths: sources.map((s) => s.path),
    after: [] as SupersededStoreTableCount[],
    rowsCopied: 0,
    rolledBack: 0,
    stagingDir: null,
    receiptPath: null,
  };

  if (sources.length === 0 || !existsSync(liveStorePath)) {
    return {
      ...base,
      outcome: 'nothing-to-reconcile',
      before: [],
      reason:
        sources.length === 0
          ? 'no legacy project store (tasks.db / brain.db / conduit.db, or bare task tables in an unmigrated cleo.db) is present'
          : `no live store at ${liveStorePath}; the legacy files are still the live data`,
    };
  }

  const before = assessSupersededProjectStores(liveStorePath, sources, resolveTarget);
  if (isComplete(before)) {
    return {
      ...base,
      outcome: 'nothing-to-reconcile',
      before,
      reason: 'every legacy row is already present in cleo.db — nothing to copy',
    };
  }
  if (dryRun) {
    return {
      ...base,
      outcome: 'planned',
      before,
      reason: `would copy the missing rows of: ${describeGaps(before)}`,
    };
  }

  const iso = new Date()
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\..+Z$/, 'Z');
  const stagingDir = join(resolveCleoDir(projectRoot), `${RECONCILE_DIR_PREFIX}${iso}`);
  mkdirSync(stagingDir, { recursive: true });
  // Keep the materialised bare source with the run's other evidence.
  const copySources = sources.map((s) => {
    if (s !== bare) return s;
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

  // The runtime-read bare tables are created by the tasks domain's own schema
  // bind; bind it first (outside the lock — it can run exodus-on-open, which
  // takes the same lock) so every runtime target exists before the copy.
  const { getDb } = await import('../sqlite.js');
  await getDb(projectRoot);

  // Serialise with exodus-on-open, which takes the same lock on this target.
  const result = await withLock(
    `${liveStorePath}.exodus-on-open.lock`,
    async (): Promise<SupersededStoreReconcileResult> => {
      const migrated = await runExodusMigrate(reconcilePlan, false, (msg) => log.debug(msg), {
        projectOnly: true,
        resolveTarget,
      });
      const rowsCopied = migrated.tables.reduce((n, t) => n + t.rowsCopied, 0);
      const after = migrated.ok
        ? assessSupersededProjectStores(liveStorePath, sources, resolveTarget)
        : [];
      const lost = shrunk(before, after);
      if (migrated.ok && isComplete(after) && lost.length === 0) {
        return {
          ...base,
          outcome: 'reconciled',
          before,
          after,
          rowsCopied,
          stagingDir,
          reason: `copied ${rowsCopied} row(s); every legacy row is now present in cleo.db`,
        };
      }
      const rolledBack = await revertReconcile(liveStorePath, stagingDir);
      const cause = !migrated.ok
        ? `copy failed: ${migrated.error ?? `the copy engine gave no message — inspect the journal in ${stagingDir}`}`
        : lost.length > 0
          ? `live tables shrank: ${lost.join(', ')}`
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
    },
    { stale: 600_000, retries: 30 },
  );

  const receiptPath = join(stagingDir, RECEIPT_FILENAME);
  const receipt = { ...result, receiptPath };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  log.info(
    { outcome: receipt.outcome, rowsCopied: receipt.rowsCopied, receiptPath },
    `exodus-reconcile: ${receipt.reason}`,
  );
  return receipt;
}
