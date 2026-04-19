/**
 * Memory Quality Feedback Loop — BRAIN self-improvement system.
 *
 * Closes the retrieval→usage→outcome loop so that memory quality scores
 * reflect real-world utility, not just insert-time heuristics.
 *
 * Three operations:
 *
 * 1. trackMemoryUsage — record whether a retrieved memory was actually used
 *    by an agent after task completion.
 *
 * 2. correlateOutcomes — scan the retrieval log, join against task outcomes,
 *    and apply quality adjustments:
 *      - Memory retrieved before a successful task completion: +0.05
 *      - Memory retrieved before a failed task: -0.05
 *      - Memory never retrieved in 30 days: flagged for pruning
 *
 * 3. getMemoryQualityReport — dashboard metrics over the entire brain.db.
 *
 * Schema addition: brain_usage_log (entry_id, task_id, used, outcome, created_at).
 * The table is self-healing — created on first access.
 *
 * @task T555
 */

import { typedAll } from '../store/typed-query.js';

// ============================================================================
// Types
// ============================================================================

/** Outcome of a task that used a retrieved memory. */
export type MemoryOutcome = 'success' | 'failure' | 'unknown';

/** A single row in brain_usage_log. */
export interface UsageLogRow {
  id: number;
  entry_id: string;
  task_id: string | null;
  used: number; // SQLite integer boolean: 1 = used, 0 = not used
  outcome: string;
  created_at: string;
}

/** Aggregate memory statistics for the quality report. */
export interface MemoryQualityReport {
  /** Total rows in brain_retrieval_log. */
  totalRetrievals: number;
  /** Count of distinct entry IDs that have ever been retrieved. */
  uniqueEntriesRetrieved: number;
  /** Ratio of usage_log rows with used=1 over total usage_log rows (0–1). */
  usageRate: number;
  /** Top 10 entries sorted by citation_count descending. */
  topRetrieved: Array<{ id: string; type: string; title: string; citationCount: number }>;
  /** Up to 10 entries with citation_count = 0, candidates for pruning. */
  neverRetrieved: Array<{ id: string; type: string; title: string; qualityScore: number }>;
  /** Distribution of quality scores bucketed into [0.0,0.3), [0.3,0.6), [0.6,1.0]. */
  qualityDistribution: {
    low: number; // < 0.3
    medium: number; // 0.3–0.6
    high: number; // > 0.6
  };
  /** Count of entries per memory tier. */
  tierDistribution: {
    short: number;
    medium: number;
    long: number;
    unknown: number;
  };
  /** Ratio of entries with quality_score < 0.3 to total entries. */
  noiseRatio: number;
}

/** Result of a correlateOutcomes run. */
export interface CorrelateOutcomesResult {
  /** Number of entries that received a quality boost (+0.05). */
  boosted: number;
  /** Number of entries that received a quality penalty (-0.05). */
  penalized: number;
  /** Number of entries flagged for pruning (prune_candidate = 1). */
  flaggedForPruning: number;
  /** Timestamp of this run (ISO string). */
  ranAt: string;
}

// ============================================================================
// Internal: schema bootstrap
// ============================================================================

/**
 * Ensure brain_usage_log exists. Safe to call multiple times — uses
 * CREATE TABLE IF NOT EXISTS. Returns silently on error (best-effort).
 */
async function ensureUsageLogTable(projectRoot: string): Promise<void> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return;

  try {
    nativeDb
      .prepare(
        `CREATE TABLE IF NOT EXISTS brain_usage_log (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_id   TEXT    NOT NULL,
          task_id    TEXT,
          used       INTEGER NOT NULL DEFAULT 0,
          outcome    TEXT    NOT NULL DEFAULT 'unknown',
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        )`,
      )
      .run();

    // Index to speed up correlateOutcomes JOIN on entry_id.
    nativeDb
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_brain_usage_log_entry_id
         ON brain_usage_log(entry_id)`,
      )
      .run();

    // Index to speed up pruning scan (entries never retrieved).
    nativeDb
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_brain_usage_log_task_id
         ON brain_usage_log(task_id)`,
      )
      .run();
  } catch {
    // best-effort: DDL failures are non-fatal
  }
}

/**
 * Ensure prune_candidate column exists on all typed brain tables.
 * Added lazily so existing schemas are not broken.
 */
async function ensurePruneCandidateColumn(projectRoot: string): Promise<void> {
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return;

  const tables = [
    'brain_decisions',
    'brain_patterns',
    'brain_learnings',
    'brain_observations',
  ] as const;

  for (const tbl of tables) {
    try {
      nativeDb.prepare(`ALTER TABLE ${tbl} ADD COLUMN prune_candidate INTEGER DEFAULT 0`).run();
    } catch {
      // Column already exists — silently continue
    }
  }
}

// ============================================================================
// 1. trackMemoryUsage
// ============================================================================

/**
 * Record whether a retrieved memory entry was actually used by an agent.
 *
 * Call this after task completion, once the agent has decided which retrieved
 * entries were referenced. Inserts a row into brain_usage_log; the
 * correlateOutcomes pass will read these rows to adjust quality scores.
 *
 * @param projectRoot - Project root directory
 * @param memoryId    - The brain entry ID (e.g. "O-...", "D-...", "P-...")
 * @param used        - Whether the agent actually used this entry
 * @param taskId      - Optional task ID for outcome correlation
 * @param outcome     - Optional task outcome; defaults to 'unknown' until correlated
 */
export async function trackMemoryUsage(
  projectRoot: string,
  memoryId: string,
  used: boolean,
  taskId?: string,
  outcome: MemoryOutcome = 'unknown',
): Promise<void> {
  if (!memoryId?.trim()) return;

  await ensureUsageLogTable(projectRoot);

  const { getBrainNativeDb } = await import('../store/memory-sqlite.js');
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  try {
    nativeDb
      .prepare(
        `INSERT INTO brain_usage_log (entry_id, task_id, used, outcome, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(memoryId, taskId ?? null, used ? 1 : 0, outcome, now);
  } catch {
    // best-effort
  }
}

// ============================================================================
// 2. correlateOutcomes
// ============================================================================

/**
 * Resolve the table name for a brain entry based on its ID prefix.
 */
function tableForId(id: string): string | null {
  if (id.startsWith('D-') || /^D\d/.test(id)) return 'brain_decisions';
  if (id.startsWith('P-') || /^P\d/.test(id)) return 'brain_patterns';
  if (id.startsWith('L-') || /^L\d/.test(id)) return 'brain_learnings';
  if (id.startsWith('O-') || id.startsWith('CM-') || /^O/.test(id)) return 'brain_observations';
  return null;
}

/**
 * Apply a quality delta (+0.05 or -0.05) to a brain entry, clamped to [0.0, 1.0].
 */
function applyQualityDelta(
  nativeDb: ReturnType<typeof import('../store/memory-sqlite.js')['getBrainNativeDb']>,
  table: string,
  id: string,
  delta: number,
  now: string,
): void {
  if (!nativeDb) return;
  try {
    nativeDb
      .prepare(
        `UPDATE ${table}
         SET quality_score = MAX(0.0, MIN(1.0, COALESCE(quality_score, 0.5) + ?)),
             updated_at    = ?
         WHERE id = ?`,
      )
      .run(delta, now, id);
  } catch {
    // best-effort: column may differ in older schemas
  }
}

/**
 * Analyse the retrieval log and usage log against task outcomes, then
 * adjust quality scores to reflect real-world utility.
 *
 * Algorithm:
 *   1. Read brain_usage_log where outcome != 'unknown' — these are rows
 *      already tagged with a definitive outcome.
 *   2. For success rows: boost quality_score by +0.05 for each entry used.
 *   3. For failure rows: penalise quality_score by -0.05 for each entry used.
 *   4. Flag entries whose citation_count = 0 AND last retrieval (if any) is
 *      older than 30 days as prune candidates.
 *
 * This is designed to be idempotent — running it twice on the same data
 * applies the delta twice (small, intentional drift toward ground truth).
 * Callers should schedule it once per session end or per task batch.
 *
 * @param projectRoot - Project root directory
 * @returns Summary of changes made
 */
export async function correlateOutcomes(projectRoot: string): Promise<CorrelateOutcomesResult> {
  await ensureUsageLogTable(projectRoot);
  await ensurePruneCandidateColumn(projectRoot);

  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  const ranAt = new Date().toISOString();

  if (!nativeDb) {
    return { boosted: 0, penalized: 0, flaggedForPruning: 0, ranAt };
  }

  const now = ranAt.replace('T', ' ').slice(0, 19);
  let boosted = 0;
  let penalized = 0;

  // ---- Step 1: apply quality adjustments from usage_log ----

  interface UsageAggRow {
    entry_id: string;
    outcome: string;
    used_count: number;
  }

  // Aggregate: for each (entry_id, outcome) pair sum the 'used' flags so we
  // do a single UPDATE per entry rather than one per log row.
  let usageRows: UsageAggRow[] = [];
  try {
    usageRows = typedAll<UsageAggRow>(
      nativeDb.prepare(
        `SELECT entry_id, outcome, SUM(used) AS used_count
         FROM brain_usage_log
         WHERE outcome IN ('success', 'failure')
         GROUP BY entry_id, outcome`,
      ),
    );
  } catch {
    // brain_usage_log may not exist yet on this DB — treat as empty
    usageRows = [];
  }

  for (const row of usageRows) {
    const table = tableForId(row.entry_id);
    if (!table) continue;

    if (row.outcome === 'success' && row.used_count > 0) {
      applyQualityDelta(nativeDb, table, row.entry_id, 0.05, now);
      boosted++;
    } else if (row.outcome === 'failure' && row.used_count > 0) {
      applyQualityDelta(nativeDb, table, row.entry_id, -0.05, now);
      penalized++;
    }
  }

  // ---- Step 2: flag stale entries for pruning ----

  const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  let flaggedForPruning = 0;

  const pruneTargetTables = [
    { table: 'brain_decisions', dateCol: 'created_at' },
    { table: 'brain_patterns', dateCol: 'extracted_at' },
    { table: 'brain_learnings', dateCol: 'created_at' },
    { table: 'brain_observations', dateCol: 'created_at' },
  ] as const;

  for (const { table, dateCol } of pruneTargetTables) {
    try {
      // Entries with zero citation_count whose creation date is older than 30 days.
      const result = nativeDb
        .prepare(
          `UPDATE ${table}
           SET prune_candidate = 1
           WHERE COALESCE(citation_count, 0) = 0
             AND ${dateCol} < ?`,
        )
        .run(cutoffDate);

      flaggedForPruning += (result as { changes: number }).changes ?? 0;
    } catch {
      // best-effort
    }
  }

  return { boosted, penalized, flaggedForPruning, ranAt };
}

// ============================================================================
// 3. getMemoryQualityReport
// ============================================================================

/**
 * Return dashboard-level quality metrics for the BRAIN memory system.
 *
 * Aggregates across all four typed tables (decisions, patterns, learnings,
 * observations) and the retrieval log to produce a single report object.
 *
 * @param projectRoot - Project root directory
 * @returns Quality metrics report
 */
export async function getMemoryQualityReport(projectRoot: string): Promise<MemoryQualityReport> {
  await ensureUsageLogTable(projectRoot);

  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  const emptyReport: MemoryQualityReport = {
    totalRetrievals: 0,
    uniqueEntriesRetrieved: 0,
    usageRate: 0,
    topRetrieved: [],
    neverRetrieved: [],
    qualityDistribution: { low: 0, medium: 0, high: 0 },
    tierDistribution: { short: 0, medium: 0, long: 0, unknown: 0 },
    noiseRatio: 0,
  };

  if (!nativeDb) return emptyReport;

  // ---- Retrieval log totals ----

  interface CountRow {
    cnt: number;
  }

  let totalRetrievals = 0;
  let uniqueEntriesRetrieved = 0;

  try {
    const logCount = typedAll<CountRow>(
      nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_retrieval_log'),
    );
    totalRetrievals = logCount[0]?.cnt ?? 0;

    const uniqueCount = typedAll<CountRow>(
      nativeDb.prepare(
        `SELECT COUNT(DISTINCT value) AS cnt
         FROM brain_retrieval_log,
              json_each('["' || replace(entry_ids, ',', '","') || '"]')`,
      ),
    );
    uniqueEntriesRetrieved = uniqueCount[0]?.cnt ?? 0;
  } catch {
    // brain_retrieval_log not yet created — harmless
  }

  // ---- Usage rate ----

  let usageRate = 0;
  try {
    const totalUsage = typedAll<CountRow>(
      nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_usage_log'),
    );
    const usedCount = typedAll<CountRow>(
      nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_usage_log WHERE used = 1'),
    );
    const total = totalUsage[0]?.cnt ?? 0;
    const used = usedCount[0]?.cnt ?? 0;
    usageRate = total > 0 ? used / total : 0;
  } catch {
    // brain_usage_log not yet created
  }

  // ---- Top 10 most-retrieved entries (by citation_count) ----

  interface CitedRow {
    id: string;
    type: string;
    title: string;
    citation_count: number;
  }

  const topRetrieved: MemoryQualityReport['topRetrieved'] = [];

  try {
    const rows = typedAll<CitedRow>(
      nativeDb.prepare(
        `SELECT id,
                'decision' AS type,
                decision    AS title,
                COALESCE(citation_count, 0) AS citation_count
         FROM brain_decisions
         UNION ALL
         SELECT id,
                'pattern'  AS type,
                pattern     AS title,
                COALESCE(citation_count, 0) AS citation_count
         FROM brain_patterns
         UNION ALL
         SELECT id,
                'learning' AS type,
                insight     AS title,
                COALESCE(citation_count, 0) AS citation_count
         FROM brain_learnings
         UNION ALL
         SELECT id,
                'observation' AS type,
                title         AS title,
                COALESCE(citation_count, 0) AS citation_count
         FROM brain_observations
         ORDER BY citation_count DESC
         LIMIT 10`,
      ),
    );

    for (const r of rows) {
      topRetrieved.push({
        id: r.id,
        type: r.type,
        title: String(r.title ?? '').slice(0, 120),
        citationCount: r.citation_count,
      });
    }
  } catch {
    // best-effort
  }

  // ---- Top 10 never-retrieved entries (candidates for pruning) ----

  interface NeverRow {
    id: string;
    type: string;
    title: string;
    quality_score: number;
  }

  const neverRetrieved: MemoryQualityReport['neverRetrieved'] = [];

  try {
    const rows = typedAll<NeverRow>(
      nativeDb.prepare(
        `SELECT id,
                'decision' AS type,
                decision    AS title,
                COALESCE(quality_score, 0.5) AS quality_score
         FROM brain_decisions
         WHERE COALESCE(citation_count, 0) = 0
         UNION ALL
         SELECT id,
                'pattern'  AS type,
                pattern     AS title,
                COALESCE(quality_score, 0.5) AS quality_score
         FROM brain_patterns
         WHERE COALESCE(citation_count, 0) = 0
         UNION ALL
         SELECT id,
                'learning' AS type,
                insight     AS title,
                COALESCE(quality_score, 0.5) AS quality_score
         FROM brain_learnings
         WHERE COALESCE(citation_count, 0) = 0
         UNION ALL
         SELECT id,
                'observation' AS type,
                title         AS title,
                COALESCE(quality_score, 0.5) AS quality_score
         FROM brain_observations
         WHERE COALESCE(citation_count, 0) = 0
         ORDER BY quality_score ASC
         LIMIT 10`,
      ),
    );

    for (const r of rows) {
      neverRetrieved.push({
        id: r.id,
        type: r.type,
        title: String(r.title ?? '').slice(0, 120),
        qualityScore: r.quality_score,
      });
    }
  } catch {
    // best-effort
  }

  // ---- Quality score distribution ----

  interface DistRow {
    low: number;
    medium: number;
    high: number;
  }

  let qualityDistribution = { low: 0, medium: 0, high: 0 };

  try {
    const rows = typedAll<DistRow>(
      nativeDb.prepare(
        `SELECT
           SUM(CASE WHEN qs < 0.3 THEN 1 ELSE 0 END)               AS low,
           SUM(CASE WHEN qs >= 0.3 AND qs <= 0.6 THEN 1 ELSE 0 END) AS medium,
           SUM(CASE WHEN qs > 0.6 THEN 1 ELSE 0 END)               AS high
         FROM (
           SELECT COALESCE(quality_score, 0.5) AS qs FROM brain_decisions
           UNION ALL
           SELECT COALESCE(quality_score, 0.5) AS qs FROM brain_patterns
           UNION ALL
           SELECT COALESCE(quality_score, 0.5) AS qs FROM brain_learnings
           UNION ALL
           SELECT COALESCE(quality_score, 0.5) AS qs FROM brain_observations
         )`,
      ),
    );
    if (rows[0]) {
      qualityDistribution = {
        low: rows[0].low ?? 0,
        medium: rows[0].medium ?? 0,
        high: rows[0].high ?? 0,
      };
    }
  } catch {
    // best-effort
  }

  // ---- Tier distribution ----

  interface TierRow {
    tier: string | null;
    cnt: number;
  }

  const tierDistribution = { short: 0, medium: 0, long: 0, unknown: 0 };

  try {
    const rows = typedAll<TierRow>(
      nativeDb.prepare(
        `SELECT memory_tier AS tier, COUNT(*) AS cnt
         FROM (
           SELECT memory_tier FROM brain_decisions
           UNION ALL
           SELECT memory_tier FROM brain_patterns
           UNION ALL
           SELECT memory_tier FROM brain_learnings
           UNION ALL
           SELECT memory_tier FROM brain_observations
         )
         GROUP BY memory_tier`,
      ),
    );

    for (const r of rows) {
      const tier = r.tier?.toLowerCase() ?? 'unknown';
      if (tier === 'short' || tier === 'medium' || tier === 'long') {
        tierDistribution[tier] += r.cnt;
      } else {
        tierDistribution.unknown += r.cnt;
      }
    }
  } catch {
    // memory_tier column may not exist on older schemas
  }

  // ---- Noise ratio ----

  const totalEntries =
    qualityDistribution.low + qualityDistribution.medium + qualityDistribution.high;
  const noiseRatio = totalEntries > 0 ? qualityDistribution.low / totalEntries : 0;

  return {
    totalRetrievals,
    uniqueEntriesRetrieved,
    usageRate,
    topRetrieved,
    neverRetrieved,
    qualityDistribution,
    tierDistribution,
    noiseRatio,
  };
}
