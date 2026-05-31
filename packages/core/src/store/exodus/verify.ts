/**
 * Exodus verification engine.
 *
 * `runExodusVerify()` checks equivalence between source legacy DBs and the
 * consolidated dual-scope `cleo.db` after a migration.
 *
 * ## Equivalence checks (AC7)
 *
 * Per-table:
 *   1. `COUNT(*)` parity — source and target row counts must match.
 *   2. Ordered canonical-JSON digest — SELECT all rows ORDER BY rowid, JSON-
 *      stringify each row, SHA-256 the concatenation (truncated to 32 hex).
 *
 * @task T11248 (E5 · AC7 · SG-DB-SUBSTRATE-V2)
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
 * @param sources        - Legacy source descriptors (from `buildExodusPlan()`).
 * @param projectDbPath  - Absolute path to the consolidated project `cleo.db`.
 * @param globalDbPath   - Absolute path to the consolidated global `cleo.db`.
 * @param onProgress     - Optional progress callback.
 *
 * @returns {@link ExodusVerifyResult}
 *
 * @task T11248 (AC7)
 */
export function runExodusVerify(
  sources: LegacyDbDescriptor[],
  projectDbPath: string,
  globalDbPath: string,
  onProgress?: (msg: string) => void,
): ExodusVerifyResult {
  const tableResults: VerifyTableResult[] = [];
  let overallOk = true;

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
            // Table missing in target (E6 will populate it — treat as skipped rows = 0)
            const srcResult = computeTableDigest(srcSnap.db, tableName);
            const result: VerifyTableResult = {
              tableName,
              scope,
              sourceCount: srcResult.count,
              targetCount: 0,
              sourceHash: srcResult.hash,
              targetHash: '',
              hashMatch: srcResult.count === 0, // only ok if source was empty
              countMatch: srcResult.count === 0,
            };
            if (!result.countMatch) {
              overallOk = false;
              log.warn({ tableName, sourceDb: src.name }, 'Table missing in consolidated DB');
            }
            tableResults.push(result);
            continue;
          }

          const srcDigest = computeTableDigest(srcSnap.db, tableName);
          const tgtDigest = computeTableDigest(targetSnap.db, tableName);

          const countMatch = srcDigest.count === tgtDigest.count;
          const hashMatch = srcDigest.hash === tgtDigest.hash;

          if (!countMatch || !hashMatch) {
            overallOk = false;
            log.warn(
              {
                tableName,
                srcCount: srcDigest.count,
                tgtCount: tgtDigest.count,
                countMatch,
                hashMatch,
              },
              'Equivalence check failed',
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

  return { ok: overallOk, tables: tableResults };
}
