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
import { resolveDualScopeDbPath } from '../store/dual-scope-db.js';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import {
  BIRTH_FP_COLUMN,
  missingRowIdentitySchema,
  ROW_IDENTITY,
  type RowIdentityFindings,
  type RowIdentityHealReceipt,
  readRowIdentityHealReceipt,
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
  const dbPath = resolveDualScopeDbPath('project', projectRoot);
  if (!existsSync(dbPath)) {
    return { check: 'row_identity', status: 'ok', message: 'no project store yet' };
  }
  // T12878: the identity SCHEMA is checked whatever the fill flag; every open
  // heals it and leaves a receipt, shown here.
  let missing: string[] = [];
  let receipt: RowIdentityHealReceipt | undefined;
  try {
    const snap = openCleoDbSnapshot(dbPath, { readOnly: true });
    try {
      missing = missingRowIdentitySchema(snap.db);
      receipt = readRowIdentityHealReceipt(snap.db);
    } finally {
      snap.close();
    }
  } catch {
    // Unreadable here: the fill branch below reports it when the flag is on.
  }
  const schemaNote =
    missing.length > 0
      ? `identity schema incomplete (${missing.join(', ')}); the next open by a released build heals it`
      : receipt
        ? `identity schema healed on ${receipt.at} (${receipt.objects.join(', ')})`
        : '';
  const schemaDetails = { missingSchema: missing, healReceipt: receipt ?? null };
  if (!rowUidFillEnabled()) {
    const off = `row uids are off (set ${ROW_UID_FILL_FLAG}=1 to enable them)`;
    return {
      check: 'row_identity',
      status: missing.length > 0 ? 'warning' : 'ok',
      message: schemaNote ? `${off}; ${schemaNote}` : off,
      details: schemaDetails,
    };
  }
  let unfilled: Record<string, number>;
  let findings: RowIdentityFindings;
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
  const parts = [
    missing.length > 0 ? schemaNote : '',
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
  const details = { dbPath, unfilled, findings, ...schemaDetails };
  const ok = receipt ? `every row has a uid; ${schemaNote}` : 'every row has a uid';
  return parts.length > 0
    ? { check: 'row_identity', status: 'warning', message: parts.join('; '), details }
    : { check: 'row_identity', status: 'ok', message: ok, details };
}
