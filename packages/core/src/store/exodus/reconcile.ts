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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  SupersededStoreReconcileResult,
  SupersededStoreTableCount,
} from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import { resolveCleoDir } from '../../paths.js';
import { resolveDualScopeDbPath } from '../dual-scope-db.js';
import { withLock } from '../lock.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { legacyRowProjection } from './column-transforms.js';
import { orderTablesForCopy, runExodusMigrate } from './migrate.js';
import { buildExodusPlan } from './plan.js';
import { rollbackExodusReceipts } from './recovery.js';
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
  const projection = legacyRowProjection(targetTable, sourceTable);
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
 * @returns One entry per legacy table holding rows, in copy order.
 * @task T12319
 */
export function assessSupersededProjectStores(
  liveStorePath: string,
  sources: readonly LegacyDbDescriptor[],
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
          const resolution = resolveConsolidatedTableName(src.name, sourceTable);
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
              ? countMissing(live.db, alias, sourceTable, targetTable)
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
  const sources = plan.sources.filter((s) => s.targetScope === 'project' && existsSync(s.path));
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
          ? 'no legacy project store (tasks.db / brain.db / conduit.db) is present'
          : `no live store at ${liveStorePath}; the legacy files are still the live data`,
    };
  }

  const before = assessSupersededProjectStores(liveStorePath, sources);
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
  const reconcilePlan = { ...plan, sources, stagingDir, resumeFromStaging: false };

  // Serialise with exodus-on-open, which takes the same lock on this target.
  const result = await withLock(
    `${liveStorePath}.exodus-on-open.lock`,
    async (): Promise<SupersededStoreReconcileResult> => {
      const migrated = await runExodusMigrate(reconcilePlan, false, (msg) => log.debug(msg), {
        projectOnly: true,
      });
      const rowsCopied = migrated.tables.reduce((n, t) => n + t.rowsCopied, 0);
      const after = migrated.ok ? assessSupersededProjectStores(liveStorePath, sources) : [];
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
