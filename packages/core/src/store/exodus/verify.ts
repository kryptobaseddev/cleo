/**
 * Exodus verification engine.
 *
 * `runExodusVerify()` checks equivalence between source legacy DBs and the
 * consolidated dual-scope `cleo.db` after a migration.
 *
 * ## Equivalence checks (AC7 · T11531 hardened)
 *
 * Per-table:
 *   1. `COUNT(*)` parity — source and target row counts MUST match.
 *      Any data-bearing source table (COUNT > 0) whose consolidated
 *      counterpart has fewer rows causes an immediate `ok: false` with an
 *      explicit `error` string listing every failing table.
 *   2. Ordered canonical-JSON digest — SELECT all rows ORDER BY rowid, JSON-
 *      stringify each row, SHA-256 the concatenation (truncated to 32 hex).
 *
 * ## FALSE-PASS guard (T11531)
 *
 * The previous implementation set `overallOk = false` but left `error`
 * undefined when count mismatches were detected. Some callers checked only
 * `result.error` to decide success. This version always populates `error`
 * with a human-readable failure summary when `ok === false`.
 *
 * @task T11248 (E5 · AC7 · SG-DB-SUBSTRATE-V2)
 * @task T11531 (verify hardening — parity gate)
 * @saga T11242
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { getLogger } from '../../logger.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import type {
  ExodusScope,
  ExodusVerifyResult,
  LegacyDbDescriptor,
  VerifyTableResult,
} from './types.js';

const log = getLogger('exodus-verify');

const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Digest helper (AC7)
// ---------------------------------------------------------------------------

/**
 * Compute an ordered canonical-JSON SHA-256 digest (32 hex chars) for all rows
 * in a table.
 *
 * Rows are fetched `ORDER BY rowid` so the ordering is deterministic. Each row
 * is canonicalized as `JSON.stringify(row)` and appended to the hash.
 */
function computeTableDigest(db: DatabaseSync, tableName: string): { count: number; hash: string } {
  const { createHash } = _require('node:crypto') as typeof import('node:crypto');
  const hasher = createHash('sha256');

  const rows = db.prepare(`SELECT * FROM "${tableName}" ORDER BY rowid`).all() as unknown[];

  for (const row of rows) {
    hasher.update(JSON.stringify(row));
  }

  return {
    count: rows.length,
    hash: hasher.digest('hex').slice(0, 32),
  };
}

// ---------------------------------------------------------------------------
// Table listing
// ---------------------------------------------------------------------------

function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Main verify runner
// ---------------------------------------------------------------------------

/**
 * Run equivalence verification after an exodus migration.
 *
 * Opens source DBs read-only and the consolidated target DBs read-only, then
 * compares row counts and canonical-JSON digests per table.
 *
 * **Parity gate (T11531)**: for every legacy source table with `rows > 0`,
 * the consolidated counterpart MUST have the same row count. Any shortfall
 * causes `ok: false` and populates `error` with a plain-text list of every
 * failing table. This catches the attach-leak class of data loss.
 *
 * @param sources        - Legacy source descriptors (from `buildExodusPlan()`).
 * @param projectDbPath  - Absolute path to the consolidated project `cleo.db`.
 * @param globalDbPath   - Absolute path to the consolidated global `cleo.db`.
 * @param onProgress     - Optional progress callback.
 *
 * @returns {@link ExodusVerifyResult} — `ok: false` with `error` populated
 *   when any data-bearing table has mismatched counts.
 *
 * @task T11248 (AC7)
 * @task T11531 (parity gate hardening)
 */
export function runExodusVerify(
  sources: LegacyDbDescriptor[],
  projectDbPath: string,
  globalDbPath: string,
  onProgress?: (msg: string) => void,
): ExodusVerifyResult {
  const tableResults: VerifyTableResult[] = [];
  /** Accumulates human-readable descriptions of every failing table. */
  const failureLines: string[] = [];

  // Check target DBs exist
  if (!existsSync(projectDbPath)) {
    return {
      ok: false,
      tables: [],
      error: `Consolidated project cleo.db not found at ${projectDbPath}. Run 'cleo exodus migrate' first.`,
    };
  }
  if (!existsSync(globalDbPath)) {
    return {
      ok: false,
      tables: [],
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
      const targetSnap: ReturnType<typeof openCleoDbSnapshot> =
        src.targetScope === 'project' ? projectSnap : globalSnap;
      const scope: ExodusScope = src.targetScope;

      try {
        const sourceTables = listTables(srcSnap.db);
        const targetTables = new Set(listTables(targetSnap.db));

        for (const tableName of sourceTables) {
          onProgress?.(`Verifying ${src.name}.${tableName}…`);

          if (!targetTables.has(tableName)) {
            // Table missing entirely from consolidated DB.
            const srcResult = computeTableDigest(srcSnap.db, tableName);
            const countMatch = srcResult.count === 0; // ok only if source was empty
            const result: VerifyTableResult = {
              tableName,
              scope,
              sourceCount: srcResult.count,
              targetCount: 0,
              sourceHash: srcResult.hash,
              targetHash: '',
              hashMatch: countMatch,
              countMatch,
            };
            if (!countMatch) {
              const line = `[${scope}] ${src.name}.${tableName}: missing from target (source has ${srcResult.count} rows)`;
              failureLines.push(line);
              log.warn({ tableName, sourceDb: src.name, sourceCount: srcResult.count }, line);
            }
            tableResults.push(result);
            continue;
          }

          const srcDigest = computeTableDigest(srcSnap.db, tableName);
          const tgtDigest = computeTableDigest(targetSnap.db, tableName);

          const countMatch = srcDigest.count === tgtDigest.count;
          const hashMatch = srcDigest.hash === tgtDigest.hash;

          if (!countMatch || !hashMatch) {
            const line = `[${scope}] ${src.name}.${tableName}: source=${srcDigest.count} rows, target=${tgtDigest.count} rows, hashMatch=${hashMatch}`;
            failureLines.push(line);
            log.warn(
              {
                tableName,
                sourceDb: src.name,
                srcCount: srcDigest.count,
                tgtCount: tgtDigest.count,
                countMatch,
                hashMatch,
              },
              `Equivalence check FAILED: ${line}`,
            );
          }

          tableResults.push({
            tableName,
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
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Exodus verify failed');
    return { ok: false, tables: tableResults, error };
  } finally {
    projectSnap.close();
    globalSnap.close();
  }

  if (failureLines.length > 0) {
    // Explicit error string — ensures any caller checking `result.error` sees the failure.
    const error = `Exodus verify FAILED: ${failureLines.length} table(s) with data loss:\n${failureLines.map((l) => `  • ${l}`).join('\n')}`;
    log.error({ failureCount: failureLines.length }, error);
    return { ok: false, tables: tableResults, error };
  }

  return { ok: true, tables: tableResults };
}
