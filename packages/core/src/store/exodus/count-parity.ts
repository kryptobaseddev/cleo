/**
 * Memory-safe COUNT(*)-only exodus parity — the deficit gate WITHOUT the content
 * digest (T11837).
 *
 * `verifyMigration` is the full parity guard (row counts + content digest + FK +
 * enum drift), but its content digest streams every row of every table. For the
 * fleet-flow surface — `cleo exodus seal` (certify an already-migrated install)
 * and `cleo doctor exodus` (health report) — we only need the DEFICIT gate that
 * `isDataContinuityOk` actually enforces: per-table `target COUNT(*) >= source
 * COUNT(*)`. That is a set-based query SQLite answers without materialising a
 * single row, so it is safe to run against a 1.7 GB-class legacy `brain.db`
 * (where the digest would be expensive). A SURPLUS (target > source — the live
 * consolidated DB has moved ahead of the frozen legacy snapshot) is NOT loss and
 * is tolerated, exactly as in `isDataContinuityOk`.
 *
 * This is intentionally a SEPARATE primitive from `verifyMigration` — sealing an
 * already-migrated install must never re-run the heavy digest that this whole
 * fleet-hardening epic (T11833) exists to avoid.
 *
 * @task T11837 (fleet-flow surface — count-only parity for seal + health)
 * @epic T11833 (EP-EXODUS-FLEET-HARDENING)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { getLogger } from '../../logger.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { resolveConsolidatedTableName, resolveTableTargetScope } from './table-name-map.js';
import type { ExodusScope, LegacyDbDescriptor } from './types.js';

const log = getLogger('exodus-count-parity');

/** Per-table COUNT(*) comparison between a legacy source table and its target. */
export interface CountParityEntry {
  /** Logical source DB name (`LegacyDbDescriptor.name`). */
  readonly sourceDb: string;
  /** Physical legacy source table name. */
  readonly sourceTable: string;
  /** Consolidated target table name. */
  readonly targetTable: string;
  /** Effective target scope (per-table override included — ADR-090 nexus graph). */
  readonly scope: ExodusScope;
  /** Source row count. */
  readonly sourceCount: number;
  /** Consolidated target row count (0 when the target table is absent). */
  readonly targetCount: number;
  /** `sourceCount - targetCount` when positive (rows MISSING in target); else 0. */
  readonly deficit: number;
}

/** Result of a COUNT(*)-only parity sweep across all source tables. */
export interface CountParityResult {
  /** `true` when NO data-bearing table has a deficit. */
  readonly ok: boolean;
  /** Every compared table (parity, surplus, and deficit). */
  readonly entries: readonly CountParityEntry[];
  /** The subset with a genuine deficit (`targetCount < sourceCount`). */
  readonly deficits: readonly CountParityEntry[];
  /** Count of tables compared. */
  readonly checked: number;
  /** Count of skipped tables (derived/FTS/internal or virtual that cannot be counted). */
  readonly skipped: number;
}

/** List user tables (excluding SQLite internals + Drizzle journal). */
function listTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/** `true` if `tableName` exists in `db`. */
function tableExists(db: DatabaseSync, tableName: string): boolean {
  const escaped = tableName.replace(/'/g, "''");
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${escaped}'`).get() !==
    undefined
  );
}

/** Memory-safe `COUNT(*)`. Returns `null` for a virtual/FTS table that cannot be counted. */
function rowCount(db: DatabaseSync, tableName: string): number | null {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${tableName}"`).get() as
      | { c: number | bigint }
      | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return null;
  }
}

/**
 * Compute COUNT(*)-only parity for every legacy source table against the
 * consolidated dual-scope target — the deficit gate, never the heavy digest.
 *
 * Opens all DBs read-only. A table whose consolidated counterpart is ABSENT with
 * source rows is a deficit (`targetCount: 0`). Derived/FTS/internal tables that
 * map to `skip`, and virtual tables that cannot be counted, are skipped.
 *
 * @param sources       - Legacy source descriptors (from `buildExodusPlan()`).
 * @param projectDbPath - Absolute path to the consolidated project `cleo.db`.
 * @param globalDbPath  - Absolute path to the consolidated global `cleo.db`.
 * @returns A {@link CountParityResult}; `ok === false` when any table has a deficit.
 *
 * @task T11837
 */
export function computeCountParity(
  sources: readonly LegacyDbDescriptor[],
  projectDbPath: string,
  globalDbPath: string,
): CountParityResult {
  const entries: CountParityEntry[] = [];
  let skipped = 0;

  if (!existsSync(projectDbPath) || !existsSync(globalDbPath)) {
    return { ok: false, entries: [], deficits: [], checked: 0, skipped: 0 };
  }

  const projectSnap = openCleoDbSnapshot(projectDbPath, { readOnly: true });
  const globalSnap = openCleoDbSnapshot(globalDbPath, { readOnly: true });

  try {
    for (const src of sources) {
      if (!existsSync(src.path)) continue;
      const srcSnap = openCleoDbSnapshot(src.path, { readOnly: true });
      try {
        for (const legacyTable of listTables(srcSnap.db)) {
          const resolution = resolveConsolidatedTableName(src.name, legacyTable);
          if (resolution.kind === 'skip') {
            skipped++;
            continue;
          }
          const targetTable = resolution.targetName;
          const scope = resolveTableTargetScope(src.name, legacyTable, src.targetScope);
          const targetSnap = scope === 'project' ? projectSnap : globalSnap;

          const sourceCount = rowCount(srcSnap.db, legacyTable);
          if (sourceCount === null) {
            skipped++;
            continue;
          }
          const targetCount = tableExists(targetSnap.db, targetTable)
            ? (rowCount(targetSnap.db, targetTable) ?? 0)
            : 0;
          const deficit = targetCount < sourceCount ? sourceCount - targetCount : 0;
          entries.push({
            sourceDb: src.name,
            sourceTable: legacyTable,
            targetTable,
            scope,
            sourceCount,
            targetCount,
            deficit,
          });
        }
      } finally {
        srcSnap.close();
      }
    }
  } finally {
    projectSnap.close();
    globalSnap.close();
  }

  const deficits = entries.filter((e) => e.deficit > 0);
  if (deficits.length > 0) {
    log.warn(
      { deficitCount: deficits.length, sample: deficits.slice(0, 5) },
      `exodus count-parity: ${deficits.length} table(s) have FEWER rows in the consolidated target than the legacy source`,
    );
  }
  return { ok: deficits.length === 0, entries, deficits, checked: entries.length, skipped };
}
