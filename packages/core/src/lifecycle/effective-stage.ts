/**
 * Effective Stage Computation — derives the expected pipeline stage for an
 * epic from the progress of its non-archived children.
 *
 * This is the canonical logic used by the sentient stage-drift detector
 * (T1635) to decide whether a stored `pipelineStage` is stale and should
 * trigger a Tier-2 proposal.
 *
 * ## Stage Derivation Rule
 *
 * | Child progress                                   | Effective stage     |
 * |--------------------------------------------------|---------------------|
 * | 0 children done (0%)                            | `research`          |
 * | 1 – N-1 children done (1–99%)                   | `implementation`    |
 * | All children done, ≥1 gate still failing/pending | `testing`           |
 * | All children done AND all tracked gates passed   | `release`           |
 * | Epic has zero non-archived children              | `research` (default)|
 *
 * "Tracked gates" means rows present in `lifecycle_gate_results` linked to
 * a pipeline owned by the epic.  Epics with NO gate rows are treated as
 * having all gates passed (avoids false drift when the lifecycle subsystem
 * hasn't been used for older epics).
 *
 * ## Stage gap model
 *
 * The sentient drift detector maps these four coarse stages onto the
 * 9-stage PIPELINE_STAGES order for numeric gap computation:
 *
 * | Effective stage  | Numeric index (1-based, matching STAGE_ORDER) |
 * |------------------|-----------------------------------------------|
 * | `research`       | 1                                             |
 * | `implementation` | 6                                             |
 * | `testing`        | 8                                             |
 * | `release`        | 9                                             |
 *
 * A gap of `|effective_index - stored_index| > 1` triggers a Tier-2 proposal.
 *
 * @task T1635
 * @see T1232 — original stage-drift bug class
 */

import type { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The four coarse effective-stage values produced by
 * {@link computeEffectiveStage}.  These map to canonical PIPELINE_STAGES
 * names; the drift detector uses their STAGE_ORDER indices.
 */
export type EffectiveStage = 'research' | 'implementation' | 'testing' | 'release';

/**
 * Input data required to compute the effective stage for a single epic.
 */
export interface EpicProgressInput {
  /** ID of the epic (e.g. `T123`). */
  epicId: string;
  /** Count of non-archived direct children. */
  childrenTotal: number;
  /** Count of non-archived direct children whose `status = 'done'`. */
  childrenDone: number;
  /**
   * Whether all tracked lifecycle gates have passed for this epic.
   *
   * Callers that do not use the lifecycle gate subsystem MUST pass `true`
   * here — absence of gate data should not create false drift signals.
   */
  allGatesPassed: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the expected pipeline stage for an epic from its child progress.
 *
 * Pure function — no I/O.  All inputs are pre-fetched by the caller.
 *
 * @param input - Pre-fetched epic progress metrics.
 * @returns The coarse {@link EffectiveStage} that this epic should be in.
 *
 * @task T1635
 */
export function computeEffectiveStage(input: EpicProgressInput): EffectiveStage {
  const { childrenTotal, childrenDone, allGatesPassed } = input;

  if (childrenTotal === 0 || childrenDone === 0) {
    return 'research';
  }

  if (childrenDone < childrenTotal) {
    return 'implementation';
  }

  // All children done.
  if (!allGatesPassed) {
    return 'testing';
  }

  return 'release';
}

/**
 * Numeric index used when comparing effective vs stored stage gap.
 *
 * Maps the four coarse effective stages to their positions in
 * PIPELINE_STAGES (1-based, matching STAGE_ORDER).
 */
export const EFFECTIVE_STAGE_INDEX: Record<EffectiveStage, number> = {
  research: 1,
  implementation: 6,
  testing: 8,
  release: 9,
};

// ---------------------------------------------------------------------------
// DB-backed batch helper
// ---------------------------------------------------------------------------

// Raw SQL output rows are consumed with inline `as Array<{...}>` casts below,
// matching the idiom used in packages/core/src/lifecycle/rollup.ts (see comment
// on line 90 there). Named interfaces trip TS's stricter
// `Record<string, SQLOutputValue>` → interface conversion check.

/**
 * Batch-fetch {@link EpicProgressInput} for a set of epic IDs from a
 * live tasks.db handle.
 *
 * Executes two SQL queries:
 *   1. Child aggregates (total + done per parent).
 *   2. Pending/failing gate count per epic (0 = all passed).
 *
 * Returns a Map keyed by epicId.  Epic IDs with no rows in the DB are
 * omitted — callers filter the returned map against their input list.
 *
 * @param db       - Live SQLite handle (tasks.db).
 * @param epicIds  - IDs to query.
 * @returns Map of epicId → {@link EpicProgressInput}.
 *
 * @task T1635
 */
export function fetchEpicProgressBatch(
  db: DatabaseSync,
  epicIds: string[],
): Map<string, EpicProgressInput> {
  const result = new Map<string, EpicProgressInput>();
  if (epicIds.length === 0) return result;

  const placeholders = epicIds.map(() => '?').join(', ');

  // Query 1: child aggregates.
  const childSql = `
    SELECT
      parent_id                                             AS parent_id,
      COUNT(*)                                              AS children_total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)    AS children_done
    FROM tasks
    WHERE parent_id IN (${placeholders})
      AND status != 'archived'
    GROUP BY parent_id
  `;

  const childRows = db.prepare(childSql).all(...epicIds) as Array<{
    parent_id: string | null;
    children_total: number | bigint | null;
    children_done: number | bigint | null;
  }>;

  const childMap = new Map<string, { total: number; done: number }>();
  for (const row of childRows) {
    if (row.parent_id === null) continue;
    childMap.set(row.parent_id, {
      total: Number(row.children_total ?? 0),
      done: Number(row.children_done ?? 0),
    });
  }

  // Query 2: pending/failing gate count per epic.
  // We count gate rows that are NOT result='pass'. If count=0 for an epic,
  // all gates (or no gates) have passed — treated as allGatesPassed=true.
  let gateMap: Map<string, boolean>;
  try {
    const gateSql = `
      SELECT
        p.task_id                                                             AS task_id,
        SUM(CASE WHEN g.result != 'pass' THEN 1 ELSE 0 END)                 AS pending_count
      FROM lifecycle_pipelines p
      LEFT JOIN lifecycle_stages s   ON s.pipeline_id = p.id
      LEFT JOIN lifecycle_gate_results g ON g.stage_id = s.id
      WHERE p.task_id IN (${placeholders})
      GROUP BY p.task_id
    `;
    const gateRows = db.prepare(gateSql).all(...epicIds) as Array<{
      task_id: string | null;
      pending_count: number | bigint | null;
    }>;
    gateMap = new Map<string, boolean>();
    for (const row of gateRows) {
      if (row.task_id === null) continue;
      gateMap.set(row.task_id, Number(row.pending_count ?? 0) === 0);
    }
  } catch {
    // lifecycle_gate_results may not exist on older DBs — degrade gracefully.
    gateMap = new Map<string, boolean>();
  }

  // Assemble result.
  for (const epicId of epicIds) {
    const agg = childMap.get(epicId);
    if (agg === undefined) {
      // Epic exists in our list but has no non-archived children — default.
      result.set(epicId, {
        epicId,
        childrenTotal: 0,
        childrenDone: 0,
        allGatesPassed: true,
      });
    } else {
      result.set(epicId, {
        epicId,
        childrenTotal: agg.total,
        childrenDone: agg.done,
        allGatesPassed: gateMap.get(epicId) ?? true,
      });
    }
  }

  return result;
}
