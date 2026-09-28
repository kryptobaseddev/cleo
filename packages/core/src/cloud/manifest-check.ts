import type { Manifest, TableDeltas } from '@cleocode/contracts/cloud';

export type ManifestVerdict =
  | { ok: true }
  | { ok: false; code: 'E_REGRESSION'; tables: RegressionFinding[] }
  | { ok: false; code: 'E_SCHEMA_AHEAD'; schemaVersion: number; maxAccepted: number };

export interface RegressionFinding {
  table: string;
  parentRows: number;
  created: number;
  deleted: number;
  expectedRows: number;
  actualRows: number;
  reason: 'missing-table' | 'count-mismatch';
}

/** Sum the per-table deltas of every segment folded into a checkpoint. */
export function sumDeltas(deltas: readonly TableDeltas[]): TableDeltas {
  const out: TableDeltas = {};
  for (const d of deltas) {
    for (const [table, { created, deleted }] of Object.entries(d)) {
      const prev = out[table] ?? { created: 0, deleted: 0 };
      out[table] = { created: prev.created + created, deleted: prev.deleted + deleted };
    }
  }
  return out;
}

/**
 * Decide whether a new checkpoint manifest may replace its parent.
 *
 * The rule is exact, not a heuristic: for every table,
 * `next.rows === parent.rows + created - deleted`, summed over the segments between the two
 * checkpoints. Every shrink therefore needs a tombstone op to back it. A table present in the
 * parent must still be present, even with 0 rows.
 *
 * With no parent (genesis), only the schema version is checked.
 */
export function checkManifest(
  parent: Manifest | null,
  next: Manifest,
  between: TableDeltas,
  maxAcceptedSchemaVersion: number,
): ManifestVerdict {
  if (next.schemaVersion > maxAcceptedSchemaVersion) {
    return {
      ok: false,
      code: 'E_SCHEMA_AHEAD',
      schemaVersion: next.schemaVersion,
      maxAccepted: maxAcceptedSchemaVersion,
    };
  }
  if (parent === null) return { ok: true };

  const findings: RegressionFinding[] = [];
  const tables = new Set([...Object.keys(parent.tables), ...Object.keys(between)]);
  for (const table of tables) {
    const parentRows = parent.tables[table]?.rows ?? 0;
    const { created, deleted } = between[table] ?? { created: 0, deleted: 0 };
    const expectedRows = parentRows + created - deleted;
    const entry = next.tables[table];
    if (entry === undefined) {
      if (parentRows > 0 || expectedRows > 0) {
        findings.push({
          table,
          parentRows,
          created,
          deleted,
          expectedRows,
          actualRows: 0,
          reason: 'missing-table',
        });
      }
      continue;
    }
    if (entry.rows !== expectedRows) {
      findings.push({
        table,
        parentRows,
        created,
        deleted,
        expectedRows,
        actualRows: entry.rows,
        reason: 'count-mismatch',
      });
    }
  }
  return findings.length === 0
    ? { ok: true }
    : { ok: false, code: 'E_REGRESSION', tables: findings };
}
