/**
 * The recoveries earlier reconciles made, read back from their receipts
 * (T13183).
 *
 * `cleo doctor superseded-store --reconcile` recovers a legacy task whose id a
 * newer task holds under a fresh id (T13172), and its receipt
 * (`.cleo/exodus-reconcile-<iso>/reconcile-receipt.json`) records each remap.
 * Later runs match on those records before they fall back to the title, so a
 * recovered task retitled since is still known as recovered, and
 * `cleo show <legacy id>` can say where the legacy task went.
 *
 * The record lives in the receipt rather than in the synced display-id alias
 * table: an alias names a row by its uid, and row uids stay off by default
 * until their release gate passes (`CLEO_ROW_UID_FILL`, T12341).
 *
 * A leaf (filesystem and SQL text only), so the read-only survey and
 * `cleo show` use it without loading the store stack.
 *
 * @module
 * @task T13183
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PRIOR_RECOVERIES_TABLE_SQL } from './task-id-collision-sql.js';

/** Prefix of a reconcile's staging directory (and receipt home). */
const RECEIPT_DIR_PREFIX = 'exodus-reconcile-';

/** File name of a reconcile receipt. */
const RECEIPT_FILE = 'reconcile-receipt.json';

/** A legacy task an earlier reconcile recovered under a new id. */
export interface PriorRecovery {
  /** The legacy display id. */
  readonly legacyId: string;
  /** The id the legacy task was recovered as. */
  readonly newId: string;
  /** The receipt that records it. */
  readonly receiptPath: string;
  /** The legacy creation time, when the receipt records it. */
  readonly legacyCreatedAt: string | null;
  /** The legacy type, when the receipt records it. */
  readonly legacyType: string | null;
}

/** Whether `value` is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every recovery recorded by a `reconciled` full-mode receipt under `cleoDir`,
 * oldest receipt first (receipt directories sort by their ISO timestamp).
 * Unreadable or malformed receipts are skipped.
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @returns The recoveries; empty when no receipt records one.
 * @example
 * ```ts
 * priorRecoveries('/p/.cleo'); // [{ legacyId: 'T001', newId: 'T004', receiptPath }]
 * ```
 */
export function priorRecoveries(cleoDir: string): PriorRecovery[] {
  if (!existsSync(cleoDir)) return [];
  const out: PriorRecovery[] = [];
  const dirs = readdirSync(cleoDir)
    .filter((name) => name.startsWith(RECEIPT_DIR_PREFIX))
    .sort();
  for (const dir of dirs) {
    const receiptPath = join(cleoDir, dir, RECEIPT_FILE);
    let receipt: unknown;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(receipt) || receipt.outcome !== 'reconciled' || receipt.mode !== 'full') {
      continue;
    }
    const remaps = Array.isArray(receipt.remaps) ? receipt.remaps : [];
    for (const remap of remaps) {
      if (!isRecord(remap)) continue;
      const { legacyId, newId, legacyCreatedAt, legacyType } = remap;
      if (typeof legacyId === 'string' && typeof newId === 'string') {
        out.push({
          legacyId,
          newId,
          receiptPath,
          legacyCreatedAt: typeof legacyCreatedAt === 'string' ? legacyCreatedAt : null,
          legacyType: typeof legacyType === 'string' ? legacyType : null,
        });
      }
    }
  }
  return out;
}

/**
 * Load `recoveries` into `temp.cleo_prior_recoveries` on `db`, where the
 * collision query reads them (later receipts rank first).
 *
 * @param db - The connection that runs the collision query.
 * @param recoveries - From {@link priorRecoveries}.
 * @example
 * ```ts
 * loadPriorRecoveries(db, priorRecoveries(cleoDir));
 * ```
 */
export function loadPriorRecoveries(db: DatabaseSync, recoveries: readonly PriorRecovery[]): void {
  db.exec(PRIOR_RECOVERIES_TABLE_SQL);
  db.exec('DELETE FROM temp.cleo_prior_recoveries');
  const insert = db.prepare(
    'INSERT INTO temp.cleo_prior_recoveries (seq, legacy_id, new_id) VALUES (?, ?, ?)',
  );
  recoveries.forEach((r, seq) => {
    insert.run(seq, r.legacyId, r.newId);
  });
}

/**
 * Whether the live store still holds `recovery`'s task as the recovered legacy
 * task: the new id exists, and, when the receipt records them, with the legacy
 * creation instant and type (the checks the collision query applies).
 *
 * @param db - The project `cleo.db` handle.
 * @param recovery - From {@link priorRecoveries}.
 * @returns `true` when the record can be trusted.
 * @example
 * ```ts
 * priorRecoveries(cleoDir).filter((r) => recoveryStands(db, r));
 * ```
 */
export function recoveryStands(db: DatabaseSync, recovery: PriorRecovery): boolean {
  return (
    db
      .prepare(
        `SELECT 1 AS ok FROM tasks_tasks
          WHERE id = ?
            AND (? IS NULL OR julianday(created_at) = julianday(?))
            AND (? IS NULL OR type IS ?)`,
      )
      .get(
        recovery.newId,
        recovery.legacyCreatedAt,
        recovery.legacyCreatedAt,
        recovery.legacyType,
        recovery.legacyType,
      ) !== undefined
  );
}
