/**
 * Exodus verification engine.
 *
 * `runExodusVerify()` checks equivalence between source legacy DBs and the
 * consolidated dual-scope `cleo.db` after a migration.
 *
 * ## DRY — built on the reusable CORE primitive (T11551 AC2)
 *
 * The row-count parity, name-mapping, rowid-safe ordering, and
 * column-intersection content-checksum logic that the exodus campaign hardened
 * (T11531/32/33) now lives in the generic {@link verifyMigration} primitive
 * (`./verify-migration.ts`). `runExodusVerify` DELEGATES to that primitive and
 * adapts the {@link VerifyMigrationResult} into the exodus-specific
 * {@link ExodusVerifyResult} shape (which keys tables by `tableName`).
 *
 * `verifyMigration` additionally surfaces a `PRAGMA foreign_key_check` result
 * and an enum/type-drift report — both of which fold into the exodus `ok`
 * verdict and `error` string here, so a referential orphan or an un-normalised
 * enum value now FAILS `cleo exodus verify` rather than passing silently.
 *
 * ## FALSE-PASS guard (T11531, preserved by the primitive)
 *
 * The primitive always populates `error` when `ok === false`, so any caller
 * checking only `result.error` still sees the failure.
 *
 * @task T11248 (E5 · AC7 · SG-DB-SUBSTRATE-V2)
 * @task T11531 (verify hardening — parity gate)
 * @task T11532 (P0 rowid crash + name-mapping + explicit skip for virtual tables)
 * @task T11533 (P0 nexus_nodes hash-drift fix — column-intersection digest)
 * @task T11551 (DHQ-045 — delegate parity to reusable CORE verifyMigration())
 * @saga T11242
 */

import type { VerifyMigrationResult } from '@cleocode/contracts';
import type { ExodusScope, ExodusVerifyResult, LegacyDbDescriptor } from './types.js';
import { verifyMigration } from './verify-migration.js';

/**
 * Run equivalence verification after an exodus migration.
 *
 * Thin adapter over {@link verifyMigration}: it forwards the source descriptors
 * and consolidated target paths to the generic primitive, then re-shapes the
 * per-table parity entries into the exodus {@link ExodusVerifyResult} contract
 * (keyed by `tableName`). The primitive's foreign-key and enum-drift checks are
 * already reflected in `result.ok` and `result.error`.
 *
 * @param sources        - Legacy source descriptors (from `buildExodusPlan()`).
 * @param projectDbPath  - Absolute path to the consolidated project `cleo.db`.
 * @param globalDbPath   - Absolute path to the consolidated global `cleo.db`.
 * @param onProgress     - Optional progress callback.
 *
 * @returns {@link ExodusVerifyResult} — `ok: false` with `error` populated when
 *   any data-bearing table has mismatched counts/content, any FK orphan exists,
 *   or any enum/type drift is detected.
 *
 * @task T11248 (AC7)
 * @task T11531 (parity gate hardening)
 * @task T11532 (name-mapping + rowid fix)
 * @task T11551 (delegates to reusable CORE verifyMigration())
 */
export function runExodusVerify(
  sources: LegacyDbDescriptor[],
  projectDbPath: string,
  globalDbPath: string,
  onProgress?: (msg: string) => void,
): ExodusVerifyResult {
  const result: VerifyMigrationResult = verifyMigration(
    sources,
    projectDbPath,
    globalDbPath,
    onProgress,
  );

  return {
    ok: result.ok,
    tables: result.tables.map((t) => ({
      tableName: t.targetTable,
      scope: t.scope as ExodusScope,
      sourceCount: t.sourceCount,
      targetCount: t.targetCount,
      sourceHash: t.sourceHash,
      targetHash: t.targetHash,
      hashMatch: t.hashMatch,
      countMatch: t.countMatch,
    })),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}
