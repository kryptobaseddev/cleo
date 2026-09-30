/**
 * `cleo doctor` view of row uids (T12341; spec `t12341-uid-scheme` §5, §6).
 *
 * Reads the project store read-only, WITHOUT binding a domain, and reports:
 *
 * - rows still without a uid or birth fingerprint (an older build wrote them;
 *   the next open by this build fills them);
 * - rows the uid recipes flag: an unknown birth (uid timestamp 0), a natural
 *   row whose key references a missing row (`dangling:` uid), and the reversed
 *   twin of a symmetric relation stored both ways (a duplicate to drop).
 *
 * @module
 * @task T12341
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { resolveDualScopeDbPath } from '../store/dual-scope-db.js';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import {
  BIRTH_FP_COLUMN,
  ROW_IDENTITY,
  type RowIdentityFindings,
  rowIdentityFindings,
  UID_COLUMN,
} from '../store/row-identity.js';
import { ROW_UID_FILL_FLAG, rowUidFillEnabled } from '../store/row-identity-flag.js';

/** One row of the default `cleo doctor` report (the `DoctorCheck` shape). */
export interface RowIdentityDoctorCheck {
  readonly check: 'row_identity';
  readonly status: 'ok' | 'warning';
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/**
 * The `row_identity` check of the default `cleo doctor` report: `warning` when
 * rows lack a uid or fingerprint, or when the recipes flag rows.
 *
 * @param projectRoot - Project directory.
 * @returns The check row.
 * @task T12341
 */
export function rowIdentityDoctorCheck(projectRoot: string): RowIdentityDoctorCheck {
  if (!rowUidFillEnabled()) {
    return {
      check: 'row_identity',
      status: 'ok',
      message: `row uids are off (set ${ROW_UID_FILL_FLAG}=1 to enable them)`,
    };
  }
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  if (!existsSync(dbPath)) {
    return { check: 'row_identity', status: 'ok', message: 'no project store yet' };
  }
  let unfilled: Record<string, number>;
  let findings: RowIdentityFindings;
  let held: Record<string, number> = {};
  try {
    const snap = openCleoDbSnapshot(dbPath, { readOnly: true });
    try {
      const has = (column: string, table: string) =>
        (snap.db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column) ??
          null) !== null;
      unfilled = {};
      for (const spec of ROW_IDENTITY.project) {
        if (!has(UID_COLUMN, spec.table)) continue;
        const fp = spec.kind === 'minted' && has(BIRTH_FP_COLUMN, spec.table);
        const row = snap.db
          .prepare(
            `SELECT count(*) AS n FROM "${spec.table}" WHERE ${UID_COLUMN} IS NULL${fp ? ` OR ${BIRTH_FP_COLUMN} IS NULL` : ''}`,
          )
          .get() as { n: number };
        if (row.n > 0) unfilled[spec.table] = row.n;
      }
      findings = rowIdentityFindings(snap.db, 'project');
      held = heldRowCounts(snap.db);
    } finally {
      snap.close();
    }
  } catch (error) {
    return {
      check: 'row_identity',
      status: 'warning',
      message: `row uid state unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const list = (counts: Readonly<Record<string, number>>) =>
    Object.entries(counts)
      .map(([table, n]) => `${table} (${n})`)
      .join(', ');
  const heldTotal = Object.values(held).reduce((a, n) => a + n, 0);
  const parts = [
    // A row the store refused (invalid) needs a person; the rest wait for sync.
    (held.invalid ?? 0) > 0 ? `received rows refused as invalid: ${held.invalid}` : '',
    Object.keys(unfilled).length > 0
      ? `rows without a uid or birth fingerprint, filled at the next open: ${list(unfilled)}`
      : '',
    Object.keys(findings.unknownBirth).length > 0
      ? `rows with an unknown birth (uid timestamp 0): ${list(findings.unknownBirth)}`
      : '',
    Object.keys(findings.danglingRefs).length > 0
      ? `rows referencing a missing row (dangling uid): ${list(findings.danglingRefs)}`
      : '',
    Object.keys(findings.mirrorEdges).length > 0
      ? `symmetric relations stored in both directions (duplicates to drop): ${list(findings.mirrorEdges)}`
      : '',
  ].filter(Boolean);
  const details = { dbPath, unfilled, findings, held };
  return parts.length > 0
    ? { check: 'row_identity', status: 'warning', message: parts.join('; '), details }
    : {
        check: 'row_identity',
        status: 'ok',
        message:
          heldTotal > 0
            ? `every row has a uid; rows held for sync: ${list(held)}`
            : 'every row has a uid',
        details,
      };
}

/**
 * Received rows held in the identity quarantine, per reason (`invalid`,
 * `ref-pending`, `uid-collision`, ...). Read-only; empty when the table is
 * absent (T12801 review).
 *
 * @param db - Connection on the project store (read-only is fine).
 * @returns Count per reason.
 * @task T12801
 */
export function heldRowCounts(db: DatabaseSync): Record<string, number> {
  const has = db
    .prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'tasks_identity_quarantine'",
    )
    .get();
  if (!has) return {};
  const out: Record<string, number> = {};
  for (const r of db
    .prepare(
      'SELECT reason, count(*) AS n FROM tasks_identity_quarantine GROUP BY reason ORDER BY reason',
    )
    .all() as { reason: string; n: number }[]) {
    out[r.reason] = r.n;
  }
  return out;
}
