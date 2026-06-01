/**
 * Reusable CORE migration-parity primitive — `verifyMigration()`.
 *
 * This is the durable guard (T11551 · DHQ-045) that prevents the exodus
 * dual-DB consolidation from silently losing rows. It is intentionally generic:
 * given a set of legacy source DBs and the consolidated target DB paths, it
 * returns a typed {@link VerifyMigrationResult} covering FOUR failure classes:
 *
 *   1. **Per-table row-count parity** — every data-bearing source table's
 *      consolidated counterpart MUST have the same row count.
 *   2. **`PRAGMA foreign_key_check`** — genuine referential orphans on the
 *      consolidated target surface as failures (not copy-order artifacts).
 *   3. **Content checksum** — an ordered canonical-JSON SHA-256 digest over the
 *      sorted intersection of source/target columns catches content drift even
 *      when counts match.
 *   4. **Enum/type-drift report** — source values outside the target column's
 *      CHECK enum. This is the EXACT class that `INSERT OR IGNORE` used to drop
 *      silently (the root cause of the ~805K-row exodus loss).
 *
 * ## Relationship to `runExodusVerify`
 *
 * `runExodusVerify` ({@link ./verify.ts}) is the exodus-specific entry point.
 * It now DELEGATES the row-count + checksum parity to this primitive (DRY —
 * T11551 AC2) and additionally surfaces the FK + enum-drift checks this module
 * adds. The digest, name-mapping, and rowid-safe ordering logic that the exodus
 * campaign hardened (T11531/32/33) live here as the single implementation.
 *
 * ## False-pass guard (T11531, preserved)
 *
 * When `ok === false`, `error` is ALWAYS populated with a human-readable
 * failure summary so a caller that only checks `result.error` cannot mistake a
 * silent loss for success.
 *
 * @task T11551 (DHQ-045 — exodus zero-loss durable guard)
 * @epic T10878
 * @saga T11242
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type {
  MigrationEnumDrift,
  MigrationForeignKeyViolation,
  MigrationTableParity,
  VerifyMigrationResult,
} from '@cleocode/contracts';
import { MIGRATION_ENUM_DRIFT_SAMPLE_LIMIT } from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import { resolveConsolidatedTableName, resolveTableTargetScope } from './table-name-map.js';
import type { ExodusScope, LegacyDbDescriptor } from './types.js';

const log = getLogger('verify-migration');

const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Digest helpers (rowid-safe ORDER BY + column-intersection digest)
// ---------------------------------------------------------------------------

/**
 * Determine a deterministic ORDER BY clause for a table.
 *
 * Uses the table's declared primary-key columns (from `PRAGMA table_info`
 * where `pk > 0`) so ordering is stable for both WITH ROWID and WITHOUT ROWID
 * tables. Falls back to `rowid` only for ordinary tables that declare no
 * explicit primary key. Avoids the `no such column: rowid` crash on virtual /
 * WITHOUT ROWID tables (T11532 ROOT CAUSE 3).
 *
 * @param db        - Database handle to introspect.
 * @param tableName - Physical table name.
 * @returns A SQL ORDER BY column list.
 */
function orderByClause(db: DatabaseSync, tableName: string): string {
  try {
    const pragma = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
      name: string;
      pk: number;
    }>;
    const pkCols = pragma
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => `"${r.name}"`);
    if (pkCols.length > 0) {
      return pkCols.join(', ');
    }
  } catch {
    // Ignore — fall through to rowid
  }
  return 'rowid';
}

/**
 * Compute an ordered canonical-JSON SHA-256 digest (32 hex chars) for all rows
 * in a table, restricted to the given column list.
 *
 * When the caller passes the SORTED INTERSECTION of source and target columns,
 * both sides produce identically-structured JSON rows, eliminating spurious
 * hash mismatches from schema-definition column reordering (T11533 ROOT CAUSE
 * 4). Returns `{ count: 0, hash: '' }` for virtual tables that cannot be
 * selected from, rather than throwing.
 *
 * @param db         - Database handle to query.
 * @param tableName  - Physical table name.
 * @param columns    - Explicit column list in canonical order, or `null` for
 *   `SELECT *` (used when there is no counterpart table to intersect with).
 * @returns `{ count, hash }` for the table.
 */
function computeTableDigest(
  db: DatabaseSync,
  tableName: string,
  columns: readonly string[] | null,
): { count: number; hash: string } {
  const { createHash } = _require('node:crypto') as typeof import('node:crypto');
  const hasher = createHash('sha256');

  const orderBy = orderByClause(db, tableName);
  const selectClause =
    columns !== null && columns.length > 0 ? columns.map((c) => `"${c}"`).join(', ') : '*';

  let rows: unknown[];
  try {
    rows = db
      .prepare(`SELECT ${selectClause} FROM "${tableName}" ORDER BY ${orderBy}`)
      .all() as unknown[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      { tableName, err: msg },
      'computeTableDigest: SELECT failed (possibly a virtual/FTS table) — treating as 0 rows',
    );
    return { count: 0, hash: '' };
  }

  for (const row of rows) {
    hasher.update(JSON.stringify(row));
  }

  return {
    count: rows.length,
    hash: hasher.digest('hex').slice(0, 32),
  };
}

/**
 * Return the sorted intersection of column names present in both the source and
 * target tables, for use as the canonical column ordering in
 * {@link computeTableDigest}. Returns `null` when either side has no columns
 * (virtual/FTS-table fallback).
 *
 * @param srcDb    - Source database handle.
 * @param srcTable - Physical table name in the source DB.
 * @param tgtDb    - Target database handle.
 * @param tgtTable - Physical table name in the target DB.
 */
function sharedColumnsSorted(
  srcDb: DatabaseSync,
  srcTable: string,
  tgtDb: DatabaseSync,
  tgtTable: string,
): readonly string[] | null {
  try {
    const srcCols = (
      srcDb.prepare(`PRAGMA table_info("${srcTable}")`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    const tgtColSet = new Set(
      (tgtDb.prepare(`PRAGMA table_info("${tgtTable}")`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    if (srcCols.length === 0 || tgtColSet.size === 0) return null;
    return srcCols.filter((c) => tgtColSet.has(c)).sort();
  } catch {
    return null;
  }
}

/**
 * List user tables in a DB (excluding SQLite internals + Drizzle journal).
 */
function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Enum/type-drift detection
// ---------------------------------------------------------------------------

/**
 * Regex that extracts a single-column `IN (...)` CHECK enum from a table's DDL.
 *
 * Matches the canonical Drizzle-generated form:
 *   `CHECK ("col" IN ('a', 'b', 'c'))`
 * and the NULL-tolerant variant:
 *   `CHECK ("col" IS NULL OR "col" IN ('a', 'b'))`
 *
 * Capture group 1 is the column name; group 2 is the raw `'a', 'b', …` list.
 * The regex is intentionally conservative — it only recognises the
 * string-literal `IN` enum shape (the one that drops rows on drift), not GLOB
 * or arithmetic CHECKs.
 */
const CHECK_ENUM_REGEX =
  /CHECK\s*\(\s*"([^"]+)"\s+(?:IS\s+NULL\s+OR\s+"[^"]+"\s+)?IN\s*\(([^)]*)\)\s*\)/gi;

/**
 * Parse the `'a', 'b', 'c'` body of an `IN (...)` clause into the set of
 * canonical enum members (single-quoted SQL string literals, `''` un-escaped).
 */
function parseEnumMembers(body: string): string[] {
  const members: string[] = [];
  // Match single-quoted literals, handling the SQL `''` escape for a quote.
  for (const m of body.matchAll(/'((?:[^']|'')*)'/g)) {
    members.push(m[1].replace(/''/g, "'"));
  }
  return members;
}

/**
 * Read a target table's DDL and return a map of `column → allowed enum members`
 * for every single-column string-literal CHECK enum on that table.
 *
 * @param db        - Target DB with the consolidated schema.
 * @param tableName - Physical consolidated table name.
 * @returns Map from column name to its allowed enum members. Empty when the
 *   table declares no recognised CHECK enums.
 */
function detectCheckEnums(db: DatabaseSync, tableName: string): Map<string, string[]> {
  const escaped = tableName.replace(/'/g, "''");
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${escaped}'`)
    .get() as { sql: string } | null;
  const out = new Map<string, string[]>();
  if (!row?.sql) return out;

  CHECK_ENUM_REGEX.lastIndex = 0;
  for (const match of row.sql.matchAll(CHECK_ENUM_REGEX)) {
    const col = match[1];
    const members = parseEnumMembers(match[2]);
    if (members.length > 0) out.set(col, members);
  }
  return out;
}

/**
 * Detect enum/type drift for one source→target table pair: source values in an
 * enum-constrained column that are NOT members of the target CHECK enum.
 *
 * Reads the DISTINCT non-null values of each enum column from the source table
 * and compares them against the target's allowed members. Only columns present
 * in BOTH source and target are inspected. The check is purely diagnostic — it
 * reports raw source drift; the migration layer is responsible for normalising
 * known aliases before insert.
 *
 * @param srcDb        - Source DB handle.
 * @param srcTable     - Physical source table name.
 * @param tgtDb        - Target DB handle.
 * @param tgtTable     - Physical consolidated target table name.
 * @returns Drift findings for this table (empty when fully canonical).
 */
function detectTableEnumDrift(
  srcDb: DatabaseSync,
  srcTable: string,
  tgtDb: DatabaseSync,
  tgtTable: string,
): MigrationEnumDrift[] {
  const enums = detectCheckEnums(tgtDb, tgtTable);
  if (enums.size === 0) return [];

  let srcCols: Set<string>;
  try {
    srcCols = new Set(
      (srcDb.prepare(`PRAGMA table_info("${srcTable}")`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
  } catch {
    return [];
  }

  const findings: MigrationEnumDrift[] = [];
  for (const [col, allowed] of enums) {
    if (!srcCols.has(col)) continue;
    const allowedSet = new Set(allowed);
    let rows: Array<{ v: unknown; c: number }>;
    try {
      rows = srcDb
        .prepare(
          `SELECT "${col}" AS v, COUNT(*) AS c FROM "${srcTable}" WHERE "${col}" IS NOT NULL GROUP BY "${col}"`,
        )
        .all() as Array<{ v: unknown; c: number }>;
    } catch {
      continue;
    }

    const offending: string[] = [];
    let driftCount = 0;
    for (const r of rows) {
      const value = String(r.v);
      if (!allowedSet.has(value)) {
        driftCount += r.c;
        if (offending.length < MIGRATION_ENUM_DRIFT_SAMPLE_LIMIT) offending.push(value);
      }
    }
    if (driftCount > 0) {
      findings.push({
        targetTable: tgtTable,
        column: col,
        offendingValues: offending,
        allowedValues: allowed,
        driftCount,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Foreign-key integrity
// ---------------------------------------------------------------------------

/**
 * Run `PRAGMA foreign_key_check` on a target DB and return any orphan rows.
 *
 * @param db    - Target DB handle (consolidated cleo.db).
 * @param scope - Scope label, attached to log context only.
 * @returns The list of FK violations (empty when referential integrity holds).
 */
function foreignKeyCheck(db: DatabaseSync, scope: string): MigrationForeignKeyViolation[] {
  try {
    const rows = db.prepare('PRAGMA foreign_key_check').all() as Array<{
      table: string;
      rowid: number | null;
      parent: string;
      fkid: number;
    }>;
    if (rows.length > 0) {
      log.warn(
        { scope, count: rows.length, sample: rows.slice(0, 5) },
        `verifyMigration: PRAGMA foreign_key_check found ${rows.length} orphan row(s)`,
      );
    }
    return rows.map((r) => ({
      table: r.table,
      rowid: r.rowid ?? null,
      parent: r.parent,
      fkid: r.fkid,
    }));
  } catch (err) {
    log.warn({ scope, err }, 'verifyMigration: PRAGMA foreign_key_check failed (non-fatal)');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public primitive
// ---------------------------------------------------------------------------

/**
 * Verify that a source→target SQLite migration preserved every row, referential
 * integrity, content, and enum validity.
 *
 * Opens all source DBs and the consolidated target DBs **read-only**, then for
 * each legacy source table:
 *
 *   1. Resolves the consolidated target name via {@link resolveConsolidatedTableName}.
 *   2. Compares row counts (parity gate).
 *   3. Computes a column-intersection content digest on both sides.
 *   4. Records any enum/type drift (source values outside the target CHECK enum).
 *
 * After all tables, it runs `PRAGMA foreign_key_check` on each distinct target
 * DB and folds the orphan rows into the result.
 *
 * @param sources       - Legacy source descriptors (from `buildExodusPlan()`).
 * @param projectDbPath - Absolute path to the consolidated project `cleo.db`.
 * @param globalDbPath  - Absolute path to the consolidated global `cleo.db`.
 * @param onProgress    - Optional progress callback.
 *
 * @returns A {@link VerifyMigrationResult}. `ok === false` (with `error`
 *   populated) on any count mismatch, content mismatch, FK orphan, or enum
 *   drift.
 *
 * @task T11551 (DHQ-045 — exodus zero-loss durable guard · AC1)
 */
export function verifyMigration(
  sources: LegacyDbDescriptor[],
  projectDbPath: string,
  globalDbPath: string,
  onProgress?: (msg: string) => void,
): VerifyMigrationResult {
  const tables: MigrationTableParity[] = [];
  const enumDrift: MigrationEnumDrift[] = [];
  const foreignKeyViolations: MigrationForeignKeyViolation[] = [];
  const failureLines: string[] = [];

  if (!existsSync(projectDbPath)) {
    return {
      ok: false,
      tables: [],
      foreignKeyViolations: [],
      enumDrift: [],
      error: `Consolidated project cleo.db not found at ${projectDbPath}. Run 'cleo exodus migrate' first.`,
    };
  }
  if (!existsSync(globalDbPath)) {
    return {
      ok: false,
      tables: [],
      foreignKeyViolations: [],
      enumDrift: [],
      error: `Consolidated global cleo.db not found at ${globalDbPath}. Run 'cleo exodus migrate' first.`,
    };
  }

  const projectSnap = openCleoDbSnapshot(projectDbPath, { readOnly: true });
  const globalSnap = openCleoDbSnapshot(globalDbPath, { readOnly: true });

  try {
    for (const src of sources) {
      if (!existsSync(src.path)) {
        onProgress?.(`Skipping ${src.name} (not present)`);
        continue;
      }

      const srcSnap = openCleoDbSnapshot(src.path, { readOnly: true });

      try {
        const sourceTables = listTables(srcSnap.db);
        // Pre-compute the table set for each consolidated scope once; the
        // per-table scope override (ADR-090 nexus graph residency, T11539) means
        // a single source can verify against BOTH scope DBs.
        const projectTables = new Set(listTables(projectSnap.db));
        const globalTables = new Set(listTables(globalSnap.db));

        for (const legacyTableName of sourceTables) {
          onProgress?.(`Verifying ${src.name}.${legacyTableName}…`);

          const resolution = resolveConsolidatedTableName(src.name, legacyTableName);
          if (resolution.kind === 'skip') {
            onProgress?.(`  [skip] ${src.name}.${legacyTableName} — ${resolution.reason}`);
            continue;
          }
          const targetTableName = resolution.targetName;

          // Per-table scope override (ADR-090 · T11539): the four nexus graph
          // tables come from the GLOBAL `nexus.db` source but land in PROJECT
          // scope. Pick the verify target DB by the effective per-table scope.
          const scope: ExodusScope = resolveTableTargetScope(
            src.name,
            legacyTableName,
            src.targetScope,
          );
          const targetSnap = scope === 'project' ? projectSnap : globalSnap;
          const targetTables = scope === 'project' ? projectTables : globalTables;

          // --- Enum/type-drift report (diagnostic, only when target exists) ---
          if (targetTables.has(targetTableName)) {
            const drift = detectTableEnumDrift(
              srcSnap.db,
              legacyTableName,
              targetSnap.db,
              targetTableName,
            );
            if (drift.length > 0) {
              enumDrift.push(...drift);
              for (const d of drift) {
                failureLines.push(
                  `[${scope}] ${targetTableName}.${d.column}: ${d.driftCount} row(s) with value(s) ` +
                    `outside enum {${d.allowedValues.join(', ')}} — e.g. ${d.offendingValues
                      .map((v) => `'${v}'`)
                      .join(', ')}`,
                );
              }
            }
          }

          // --- Row-count + content-checksum parity ---
          if (!targetTables.has(targetTableName)) {
            const srcResult = computeTableDigest(srcSnap.db, legacyTableName, null);
            const countMatch = srcResult.count === 0;
            tables.push({
              sourceTable: legacyTableName,
              targetTable: targetTableName,
              scope,
              sourceCount: srcResult.count,
              targetCount: 0,
              sourceHash: srcResult.hash,
              targetHash: '',
              hashMatch: countMatch,
              countMatch,
            });
            if (!countMatch) {
              failureLines.push(
                `[${scope}] ${src.name}.${legacyTableName} → ${targetTableName}: ` +
                  `missing from target (source has ${srcResult.count} rows)`,
              );
            }
            continue;
          }

          const cols = sharedColumnsSorted(
            srcSnap.db,
            legacyTableName,
            targetSnap.db,
            targetTableName,
          );
          const srcDigest = computeTableDigest(srcSnap.db, legacyTableName, cols);
          const tgtDigest = computeTableDigest(targetSnap.db, targetTableName, cols);
          const countMatch = srcDigest.count === tgtDigest.count;
          const hashMatch = srcDigest.hash === tgtDigest.hash;

          if (!countMatch || !hashMatch) {
            failureLines.push(
              `[${scope}] ${src.name}.${legacyTableName} → ${targetTableName}: ` +
                `source=${srcDigest.count} rows, target=${tgtDigest.count} rows, hashMatch=${hashMatch}`,
            );
          }

          tables.push({
            sourceTable: legacyTableName,
            targetTable: targetTableName,
            scope,
            sourceCount: srcDigest.count,
            targetCount: tgtDigest.count,
            sourceHash: srcDigest.hash,
            targetHash: tgtDigest.hash,
            hashMatch,
            countMatch,
          });
        }
      } finally {
        srcSnap.close();
      }
    }

    // --- Foreign-key integrity on each distinct target DB ---
    foreignKeyViolations.push(...foreignKeyCheck(projectSnap.db, 'project'));
    foreignKeyViolations.push(...foreignKeyCheck(globalSnap.db, 'global'));
    for (const fk of foreignKeyViolations) {
      failureLines.push(
        `[fk] ${fk.table}.rowid=${fk.rowid ?? '?'} references missing ${fk.parent} (fkid=${fk.fkid})`,
      );
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'verifyMigration failed');
    return { ok: false, tables, foreignKeyViolations, enumDrift, error };
  } finally {
    projectSnap.close();
    globalSnap.close();
  }

  if (failureLines.length > 0) {
    const error = `verifyMigration FAILED: ${failureLines.length} issue(s):\n${failureLines
      .map((l) => `  • ${l}`)
      .join('\n')}`;
    log.error({ failureCount: failureLines.length }, error);
    return { ok: false, tables, foreignKeyViolations, enumDrift, error };
  }

  return { ok: true, tables, foreignKeyViolations, enumDrift };
}
