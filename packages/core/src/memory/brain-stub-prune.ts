/**
 * Targeted prune of content-free BRAIN observations (T12073).
 *
 * ## Why (measured, 2026-08-06)
 *
 * Of 6,985 observations in this project's BRAIN:
 *
 * | count | share | shape                                          |
 * |-------|-------|------------------------------------------------|
 * | 2,012 | 29%   | narrative contains the literal `status: undefined` |
 * | 2,035 | 29%   | auto-hook `Task start:` / `Task complete:` stubs |
 * | 2,064 | 30%   | narrative under 60 characters                   |
 * |   481 | 6.9%  | narrative over 800 characters — i.e. substantive |
 *
 * The `status: undefined` rows are pure artefact: `PostToolUse` was dispatched
 * with a field name the payload does not declare, so `handleToolComplete`
 * interpolated `undefined` into every completion record. That defect is fixed
 * (T12071) and can no longer produce new rows — but the existing ones remain,
 * and they are not merely inert. FTS5's BM25 normalises for document length,
 * so a 44-character record OUTRANKS a 4,000-character one for any term they
 * share. The junk actively buries the knowledge.
 *
 * ## Safety
 *
 * This module is deliberately NOT the older `purgeBrainNoise`, which is a
 * one-shot script hardcoded to a historical state: it deletes every learning,
 * every decision but one specific id, and logs to stdout. Running it today
 * would destroy 127 learnings and 127 decisions.
 *
 * Here, instead:
 *
 *   - **Dry-run is the default.** Quarantine requires an explicit `apply`.
 *   - Only OBSERVATIONS are considered. Decisions, patterns and learnings are
 *     never touched.
 *   - A row is a candidate only if it matches a named, narrow rule AND its
 *     narrative is under {@link MAX_STUB_NARRATIVE} characters, so a long
 *     record that merely happens to quote one of these strings survives.
 *   - Rows carrying `verified = 1` are always preserved.
 *   - The result reports per-rule counts and a sample, so the caller can see
 *     what would go before anything does.
 *
 * @task T12073
 */

import type { DatabaseSync } from 'node:sqlite';

/**
 * Longest narrative still eligible for pruning.
 *
 * A genuine write-up that happens to contain "status: undefined" (this
 * module's own documentation, for instance, or a post-mortem describing the
 * bug) is far longer than this and is therefore never a candidate.
 */
export const MAX_STUB_NARRATIVE = 200;

/** A named prune rule with its SQL predicate. */
export interface StubPruneRule {
  /** Stable identifier, reported in {@link StubPruneResult.byRule}. */
  readonly id: string;
  /** One-line explanation of what this rule removes and why it is safe. */
  readonly reason: string;
  /** SQL predicate over `brain_observations`, ANDed with the global guards. */
  readonly predicate: string;
}

/**
 * The prune rules, each narrow and independently justified.
 *
 * Every predicate is ANDed with `length(narrative) <= MAX_STUB_NARRATIVE` and
 * `verified IS NOT 1`. Exact empty-hook shapes establish candidacy; short
 * narratives with additional content are retained for agent review.
 */
export const STUB_PRUNE_RULES: readonly StubPruneRule[] = [
  {
    id: 'status-undefined',
    reason:
      'Artefact of T12071: PostToolUse was dispatched with `newStatus` while the payload declares `status`, so every completion interpolated the literal string "undefined". Carries no information beyond the task id, which the tasks table already holds.',
    predicate:
      "title LIKE 'Task complete: T%' AND narrative = 'Task ' || substr(title, 16) || ' completed with status: undefined'",
  },
  {
    id: 'task-start-stub',
    reason:
      'Exact empty-title auto-hook record. Nonempty task-start narratives can contain substantive incident evidence and must remain available, regardless of length.',
    predicate:
      "title LIKE 'Task start: T%' AND narrative IN ('Started work on ' || substr(title, 13) || ': ', 'Started work on ' || substr(title, 13) || ': undefined')",
  },
  {
    id: 'task-complete-stub',
    reason:
      'Auto-hook record of the form "Task T#### completed with status: <status>". Duplicates the task row; retained only when it carries a real status AND some other content, which the length guard enforces.',
    predicate:
      "title LIKE 'Task complete: T%' AND narrative IN ('Task ' || substr(title, 16) || ' completed with status: undefined', 'Task ' || substr(title, 16) || ' completed with status: done', 'Task ' || substr(title, 16) || ' completed with status: completed', 'Task ' || substr(title, 16) || ' completed with status: cancelled')",
  },
];

/** One candidate row, for reporting. */
export interface StubPruneCandidate {
  readonly id: string;
  readonly title: string;
  readonly narrative: string;
  readonly rule: string;
}

/** Outcome of a prune run. */
export interface StubPruneResult {
  /** Whether rows were actually quarantined (`false` = dry run). */
  readonly applied: boolean;
  /** IDs retained in reversible quarantine by this run. */
  readonly quarantinedIds?: readonly string[];
  /** Invalidation timestamp needed for safe conditional restoration. */
  readonly quarantinedAt?: string;
  /** Active observation count before the run. */
  readonly before: number;
  /** Active observation count after (equals `before` on a dry run). */
  readonly after: number;
  /** Number of rows matched (and quarantined, when `applied`). */
  readonly matched: number;
  /** All affected IDs for inspectable repair scope; sample remains limited to five. */
  readonly candidateIds?: readonly string[];
  /** Per-rule match counts, keyed by {@link StubPruneRule.id}. */
  readonly byRule: Record<string, number>;
  /** Up to 5 example rows, so a dry run shows what would go. */
  readonly sample: readonly StubPruneCandidate[];
}

/** Build the WHERE clause shared by counting, sampling and deleting. */
function ruleClause(rule: StubPruneRule): string {
  return `(${rule.predicate}) AND length(COALESCE(narrative, '')) <= ${MAX_STUB_NARRATIVE} AND COALESCE(verified, 0) != 1 AND invalid_at IS NULL`;
}

/** Combined predicate across every rule. */
function allRulesClause(): string {
  return STUB_PRUNE_RULES.map(ruleClause).join(' OR ');
}

/**
 * Count, sample and reversibly quarantine confirmed content-free observation stubs.
 *
 * @param nativeDb - open handle to the database holding `brain_observations`.
 * @param apply - when `true`, invalidate matched rows while retaining their content.
 * @returns counts, per-rule breakdown and a sample of matched rows.
 *
 * @example
 * ```ts
 * const preview = pruneObservationStubs(db, false);
 * console.log(`${preview.matched} of ${preview.before} observations are stubs`);
 * if (preview.matched > 0) pruneObservationStubs(db, true);
 * ```
 *
 * @task T12073
 */
export function pruneObservationStubs(nativeDb: DatabaseSync, apply: boolean): StubPruneResult {
  const countAll = (): number =>
    (
      nativeDb
        .prepare('SELECT COUNT(*) AS c FROM main.brain_observations WHERE invalid_at IS NULL')
        .get() as { c: number }
    ).c;

  const before = countAll();

  const byRule: Record<string, number> = {};
  for (const rule of STUB_PRUNE_RULES) {
    const row = nativeDb
      .prepare(`SELECT COUNT(*) AS c FROM main.brain_observations WHERE ${ruleClause(rule)}`)
      .get() as { c: number };
    byRule[rule.id] = row.c;
  }

  const combined = allRulesClause();
  const matched = (
    nativeDb
      .prepare(`SELECT COUNT(*) AS c FROM main.brain_observations WHERE ${combined}`)
      .get() as {
      c: number;
    }
  ).c;

  const candidateIds = nativeDb
    .prepare(`SELECT id FROM main.brain_observations WHERE ${combined} ORDER BY id`)
    .all()
    .flatMap((row) => (typeof row.id === 'string' ? [row.id] : []));

  const sample = nativeDb
    .prepare(
      `SELECT id, title, COALESCE(narrative, '') AS narrative FROM main.brain_observations WHERE ${combined} LIMIT 5`,
    )
    .all() as Array<{ id: string; title: string; narrative: string }>;

  if (!apply || matched === 0) {
    return {
      applied: false,
      before,
      after: before,
      matched,
      candidateIds,
      byRule,
      sample: sample.map((r) => ({ ...r, rule: matchingRule(r.narrative, r.title) })),
    };
  }

  const quarantinedAt = new Date().toISOString();
  const retained = nativeDb
    .prepare(`UPDATE main.brain_observations SET invalid_at = ? WHERE ${combined} RETURNING id`)
    .all(quarantinedAt);
  const quarantinedIds = retained.flatMap((row) => (typeof row.id === 'string' ? [row.id] : []));

  return {
    applied: true,
    quarantinedIds,
    quarantinedAt,
    before,
    after: countAll(),
    matched,
    candidateIds,
    byRule,
    sample: sample.map((r) => ({ ...r, rule: matchingRule(r.narrative, r.title) })),
  };
}

/**
 * Best-effort attribution of a sampled row to the rule that matched it.
 *
 * Reporting only — quarantine uses the combined SQL predicate.
 *
 * @param narrative - the row's narrative text.
 * @param title - the row's title.
 * @returns the matching rule id, or `'unknown'`.
 */
function matchingRule(narrative: string, title: string): string {
  if (narrative.includes('status: undefined')) return 'status-undefined';
  if (title.startsWith('Task start: T')) return 'task-start-stub';
  if (title.startsWith('Task complete: T')) return 'task-complete-stub';
  return 'unknown';
}

/**
 * Restore only rows still bearing this quarantine receipt's timestamp.
 * Later invalidations or edits to authority are preserved by the precondition.
 *
 * @param nativeDb - Canonical project database handle.
 * @param receipt - Prior quarantine receipt with retained IDs and timestamp.
 * @returns Count of rows restored; mismatched preconditions are left unchanged.
 */
export function restoreObservationStubs(nativeDb: DatabaseSync, receipt: StubPruneResult): number {
  if (!receipt.quarantinedAt || !receipt.quarantinedIds?.length) return 0;
  let restored = 0;
  const statement = nativeDb.prepare(
    'UPDATE main.brain_observations SET invalid_at = NULL WHERE id = ? AND invalid_at = ?',
  );
  nativeDb.exec('SAVEPOINT restore_observation_stubs');
  try {
    for (const id of receipt.quarantinedIds)
      restored += Number(statement.run(id, receipt.quarantinedAt).changes);
    nativeDb.exec('RELEASE restore_observation_stubs');
    return restored;
  } catch (error) {
    nativeDb.exec('ROLLBACK TO restore_observation_stubs');
    nativeDb.exec('RELEASE restore_observation_stubs');
    throw error;
  }
}
