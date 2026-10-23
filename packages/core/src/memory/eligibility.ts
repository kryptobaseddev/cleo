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
import { stubObservationClause } from './brain-stub-prune.js';
import { DISPATCH_TRACE_TEXT_PREFIX } from './dispatch-trace-format.js';

/**
 * SQL eligibility shared by current-memory retrieval strategies.
 * Historical retrieval explicitly opts out; no source records are modified.
 *
 * @param table - Memory table whose lifecycle fields must be checked.
 * @param alias - Trusted SQL alias used by the caller, never user input.
 * @param includeHistory - Include invalidated and superseded historical records.
 * @returns A conjunctive SQL fragment with no bind parameters.
 * @remarks Append this clause to an existing WHERE condition. Explicit history
 * retrieval returns an empty clause and preserves the original records.
 * @example
 * ```ts
 * const clause = memoryEligibilityClause('decisions', 'decision');
 * ```
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
 * SQL that keeps auto-generated rows out of recall (T13946).
 *
 * Excluded, without being deleted or quarantined:
 * - patterns: stored dispatch traces (99.5 % of `brain_patterns` on 2026-10-23);
 * - observations: `Doc attached:` records carrying the doc-attachment JSON
 *   payload (the attachment row already holds the link) and the content-free
 *   task-start/complete stubs of
 *   {@link stubObservationClause}.
 *
 * Decisions and learnings have no auto-row shape and get an empty clause.
 * Direct fetch by id still returns these rows.
 *
 * @param table - Memory table being queried.
 * @param alias - Trusted SQL alias for that table in the caller's query.
 * @returns A conjunctive SQL fragment with no bind parameters (may be empty).
 * @example
 * ```ts
 * const sql = `SELECT * FROM brain_patterns p WHERE 1=1${autoRowExclusionClause('patterns', 'p')}`;
 * ```
 */
export function autoRowExclusionClause(
  table: NonNullable<SearchBrainCompactParams['tables']>[number],
  alias = `brain_${table}`,
): string {
  if (table === 'patterns') {
    return ` AND ${alias}.pattern NOT LIKE '${DISPATCH_TRACE_TEXT_PREFIX}%'`;
  }
  if (table === 'observations') {
    // Both doc writers (docs projection, memory backfill-docs) store the
    // DocAttachmentObservationPayload JSON as the narrative. Requiring it keeps
    // a human note titled "Doc attached: …" in recall; GLOB is case-sensitive,
    // and COALESCE keeps a NULL narrative from making the NOT(…) NULL.
    return ` AND NOT (${alias}.title GLOB 'Doc attached:*' AND COALESCE(${alias}.narrative, '') LIKE '%"kind":"doc-attachment"%') AND ${alias}.id NOT IN (SELECT id FROM main.brain_observations WHERE ${stubObservationClause()})`;
  }
  return '';
}

/**
 * Whether a resolved source row can participate in current guidance.
 * Direct ID fetch and timeline remain available for historical inspection.
 *
 * @param entry - Canonical source record returned by a memory accessor.
 * @returns False when invalidation or explicit decision supersession retires the record.
 * @remarks Eligibility follows recorded lifecycle state. It does not establish
 * factual correctness or independently authorize a supersession.
 * @example
 * ```ts
 * const eligible = isCurrentMemoryEntry(sourceRow);
 * ```
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
 * ```ts
 * const authority = graphMemoryAuthority(db, 'decision:D001', 'decision');
 * ```
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
