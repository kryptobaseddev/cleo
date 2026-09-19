/**
 * Current-memory lifecycle eligibility shared by retrieval strategies.
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeAuthorityStatus, SearchBrainCompactParams } from '@cleocode/contracts';
import type {
  BrainDecisionRow,
  BrainLearningRow,
  BrainObservationRow,
  BrainPatternRow,
} from '../store/schema/memory-schema.js';

/**
 * SQL eligibility shared by current-memory retrieval strategies.
 * Historical retrieval explicitly opts out; no source records are modified.
 *
 * @param table - Memory table whose lifecycle fields must be checked.
 * @param alias - Trusted SQL alias used by the caller, never user input.
 * @param includeHistory - Include invalidated and superseded historical records.
 * @returns A conjunctive SQL fragment with no bind parameters.
 */
export function memoryEligibilityClause(
  table: NonNullable<SearchBrainCompactParams['tables']>[number],
  alias = `brain_${table}`,
  includeHistory = false,
): string {
  if (includeHistory) return '';
  const current = ` AND ${alias}.invalid_at IS NULL`;
  return table === 'decisions'
    ? `${current} AND ${alias}.superseded_by IS NULL AND ${alias}.confirmation_state != 'superseded'`
    : current;
}

/**
 * Whether a resolved source row can participate in current guidance.
 * Direct ID fetch and timeline remain available for historical inspection.
 *
 * @param entry - Canonical source record returned by a memory accessor.
 * @returns False when invalidation or explicit decision supersession retires the record.
 */
export function isCurrentMemoryEntry(
  entry: BrainDecisionRow | BrainLearningRow | BrainObservationRow | BrainPatternRow,
): boolean {
  if (entry.invalidAt != null) return false;
  if ('supersededBy' in entry && entry.supersededBy != null) return false;
  return !('confirmationState' in entry && entry.confirmationState === 'superseded');
}

/**
 * Assess the canonical source behind a graph memory projection.
 * @param db - Canonical project memory handle.
 * @param nodeId - Graph node identifier, optionally prefixed by its memory type.
 * @param nodeType - Graph projection type.
 * @returns Current, historical, or unverified source authority.
 * @remarks A missing canonical source is unverified, never silently current.
 * @example
 * const authority = graphMemoryAuthority(db, 'decision:D001', 'decision');
 */
export function graphMemoryAuthority(
  db: DatabaseSync,
  nodeId: string,
  nodeType: string,
): KnowledgeAuthorityStatus {
  const table =
    nodeType === 'decision'
      ? 'decisions'
      : nodeType === 'observation'
        ? 'observations'
        : nodeType === 'learning'
          ? 'learnings'
          : nodeType === 'pattern'
            ? 'patterns'
            : null;
  if (!table) return 'unverified';
  const id = nodeId.startsWith(`${nodeType}:`) ? nodeId.slice(nodeType.length + 1) : nodeId;
  const source = db.prepare(`SELECT id FROM main.brain_${table} WHERE id = ?`).get(id);
  if (!source) return 'unverified';
  const current = db
    .prepare(
      `SELECT id FROM main.brain_${table} AS source WHERE id = ?${memoryEligibilityClause(table, 'source')}`,
    )
    .get(id);
  return current ? 'current' : 'historical';
}
