/**
 * The named auto-row rules (T13951) and the guard the memory accessors resolve
 * from rule ids, so no caller hands the store raw SQL (T14003).
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 */
import { stubObservationClause } from './brain-stub-prune.js';
import { DISPATCH_TRACE_TEXT_PREFIX } from './dispatch-trace-format.js';

/** Stable id of an auto-row rule. */
export type AutoRowRuleId = 'dispatch-trace' | 'doc-attachment' | 'task-stub';

/** One named auto-row rule with its exact SQL predicate. */
export interface AutoRowRule {
  /** Stable id, reported in counts. */
  readonly id: AutoRowRuleId;
  /** Table the rule reads. */
  readonly table: 'patterns' | 'observations';
  /** SQL predicate over unaliased columns, ANDed with the current/unverified guard. */
  readonly predicate: string;
}

/** Guard every rule shares: only current, unverified rows. */
export const CURRENT_UNVERIFIED = 'invalid_at IS NULL AND COALESCE(verified, 0) != 1';

/** The rules, each matching rows only machinery writes. */
export const AUTO_ROW_RULES: readonly AutoRowRule[] = [
  {
    id: 'dispatch-trace',
    table: 'patterns',
    predicate: `pattern LIKE '${DISPATCH_TRACE_TEXT_PREFIX}%'`,
  },
  {
    // Both the title and the writer's JSON payload: a human note titled
    // "Doc attached: ..." without the payload is never matched.
    id: 'doc-attachment',
    table: 'observations',
    predicate: `title GLOB 'Doc attached:*' AND COALESCE(narrative, '') LIKE '%"kind":"doc-attachment"%'`,
  },
  {
    id: 'task-stub',
    table: 'observations',
    predicate: `(${stubObservationClause()})`,
  },
];

/**
 * The SQL guard for a write: any of the named rules, on current unverified rows.
 *
 * @param table - Table being written.
 * @param ruleIds - Rules the row must still match.
 * @returns A predicate over unaliased columns.
 * @throws Error when no rule is named, or a rule is unknown or reads another table.
 * @example
 * ```ts
 * const guard = autoRowGuard('patterns', ['dispatch-trace']);
 * ```
 */
export function autoRowGuard(
  table: 'patterns' | 'observations',
  ruleIds: readonly AutoRowRuleId[],
): string {
  const predicates = ruleIds.map((id) => {
    const rule = AUTO_ROW_RULES.find((candidate) => candidate.id === id);
    // @sync-invariant none:input-shape an unknown or mismatched rule is refused before any write
    if (!rule || rule.table !== table) throw new Error(`No auto-row rule '${id}' for ${table}`);
    return `(${rule.predicate})`;
  });
  // @sync-invariant none:input-shape an empty guard is refused before any write
  if (predicates.length === 0) throw new Error(`An auto-row guard for ${table} names no rule`);
  return `(${predicates.join(' OR ')}) AND ${CURRENT_UNVERIFIED}`;
}
