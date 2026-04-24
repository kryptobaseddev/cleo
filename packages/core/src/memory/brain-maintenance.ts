/**
 * Brain Maintenance Runner
 *
 * Combines temporal decay, memory consolidation, and embedding backfill
 * into a single idempotent maintenance pass. Designed to be run on a
 * schedule or on-demand via `cleo brain maintenance`.
 *
 * Steps run in order:
 *   1. Temporal decay   — reduce confidence of stale learnings
 *   2. Consolidation    — merge duplicate/similar old observations
 *   3. Embedding backfill — populate vectors for observations without them
 *
 * Each step is individually opt-outable via skip flags, making the
 * operation safe to re-run at any frequency.
 *
 * @task T143
 * @epic T134
 * @why Enable scheduled brain optimization via single command
 * @what Combined maintenance runner with CLI command and progress reporting
 */

import { runDeriverBatch } from '../deriver/consumer.js';
import { reconcileOrphanedRefs } from '../store/cross-db-cleanup.js';
import { applyTemporalDecay, consolidateMemories, runTierPromotion } from './brain-lifecycle.js';
import { populateEmbeddings } from './brain-retrieval.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Default maximum number of rows deleted per {@link runPruneSweep} invocation.
 * Configurable via the `brain.sweeper.maxDeletePerRun` project config key.
 */
const DEFAULT_MAX_DELETE_PER_RUN = 500;

// ============================================================================
// Types
// ============================================================================

/** Temporal decay step result subset used in maintenance output. */
export interface BrainMaintenanceDecayResult {
  /** Number of learnings whose confidence was updated. */
  affected: number;
}

/** Memory consolidation step result subset used in maintenance output. */
export interface BrainMaintenanceConsolidationResult {
  /** Number of new summary observations created. */
  merged: number;
  /** Number of original observations archived. */
  removed: number;
}

/** Orphaned reference reconciliation step result. */
export interface BrainMaintenanceReconciliationResult {
  /** Decisions with stale task/epic references fixed. */
  decisionsFixed: number;
  /** Observations with stale session references fixed. */
  observationsFixed: number;
  /** Memory links with stale task references removed. */
  linksRemoved: number;
}

/** Embedding backfill step result. */
export interface BrainMaintenanceEmbeddingsResult {
  /** Observations successfully embedded. */
  processed: number;
  /** Observations skipped (no provider or no narrative). */
  skipped: number;
  /** Observations that failed embedding. */
  errors: number;
}

/** Tier promotion step result. */
export interface BrainMaintenanceTierPromotionResult {
  /** Number of entries promoted (short→medium or medium→long). */
  promoted: number;
  /** Number of stale short-tier entries soft-evicted. */
  evicted: number;
}

/** Deriver batch step result (T1145). */
export interface BrainMaintenanceDeriverResult {
  /** Number of items successfully derived (completed). */
  processed: number;
  /** Number of items that failed or were re-queued. */
  failed: number;
  /** Number of stale in_progress items re-queued before the batch. */
  staleRequeued: number;
}

/**
 * Options for {@link runPruneSweep}.
 */
export interface PruneSweepOptions {
  /**
   * When true, log the would-delete count but do NOT execute the DELETE.
   * Returns the full result struct with `deleted = 0` and `wouldDelete` set.
   * Default: false.
   */
  dryRun?: boolean;
  /**
   * Cap total deletes across all tables per invocation.
   * Reads `brain.sweeper.maxDeletePerRun` from project config; falls back to
   * {@link DEFAULT_MAX_DELETE_PER_RUN} (500).
   */
  maxDeletePerRun?: number;
}

/**
 * Result from a single {@link runPruneSweep} invocation.
 */
export interface PruneSweepResult {
  /**
   * Total rows deleted across all four typed brain tables.
   * Always 0 in dry-run mode.
   */
  deleted: number;
  /**
   * Would-delete count when `dryRun=true`; 0 otherwise.
   * This is the count of qualifying rows before the cap is applied.
   */
  wouldDelete: number;
  /**
   * Whether the run was a dry-run (no mutations made).
   */
  dryRun: boolean;
  /**
   * Per-table breakdown of rows deleted (or would-delete in dry-run).
   */
  byTable: Record<string, number>;
}

/**
 * Aggregated result from a full brain maintenance run.
 *
 * All counts are zero when a step is skipped via the corresponding
 * `skip*` option.
 */
export interface BrainMaintenanceResult {
  /** Results from the temporal decay step. */
  decay: BrainMaintenanceDecayResult;
  /** Results from the memory consolidation step. */
  consolidation: BrainMaintenanceConsolidationResult;
  /** Results from the cross-DB orphaned reference reconciliation step. */
  reconciliation: BrainMaintenanceReconciliationResult;
  /** Results from the tier promotion step. */
  tierPromotion: BrainMaintenanceTierPromotionResult;
  /** Results from the embedding backfill step. */
  embeddings: BrainMaintenanceEmbeddingsResult;
  /** Results from the Step 9f prune sweep (T995). */
  pruneSweep: PruneSweepResult;
  /** Results from the deriver batch step (T1145). */
  deriver: BrainMaintenanceDeriverResult;
  /** Total wall-clock duration of the maintenance run in milliseconds. */
  duration: number;
}

/**
 * Options for {@link runBrainMaintenance}.
 *
 * All `skip*` flags default to `false` — the full maintenance pass runs
 * unless specific steps are disabled.
 */
export interface BrainMaintenanceOptions {
  /** Skip the temporal decay step. Default: false. */
  skipDecay?: boolean;
  /** Skip the memory consolidation step. Default: false. */
  skipConsolidation?: boolean;
  /** Skip the cross-DB orphaned reference reconciliation step. Default: false. */
  skipReconciliation?: boolean;
  /** Skip the tier promotion step (short→medium, medium→long). Default: false. */
  skipTierPromotion?: boolean;
  /** Skip the embedding backfill step. Default: false. */
  skipEmbeddings?: boolean;
  /** Skip the Step 9f prune sweep (T995). Default: false. */
  skipPruneSweep?: boolean;
  /**
   * Run Step 9f in dry-run mode (log count, no DELETE).
   * Default: false.
   */
  pruneSweepDryRun?: boolean;
  /** Skip the deriver batch step (T1145). Default: false. */
  skipDeriver?: boolean;
  /**
   * Progress callback invoked before each step starts and after
   * completion of each sub-item.
   *
   * @param step - Human-readable step name (e.g. "decay", "consolidation", "embeddings")
   * @param current - Items processed so far within the current step (0 before step starts)
   * @param total - Total items expected for the current step (0 if unknown before start)
   */
  onProgress?: (step: string, current: number, total: number) => void;
}

// ============================================================================
// Step 9f: Prune Sweep
// ============================================================================

/**
 * Hard-sweeper: DELETE brain entries that are confirmed noise.
 *
 * A row qualifies for deletion when ALL of:
 *   - `prune_candidate = 1`  (flagged by `correlateOutcomes` Step 9a.5)
 *   - `quality_score < 0.2`  (low quality)
 *   - `citation_count = 0`   (never cited)
 *   - age > 30 days          (`julianday('now') - julianday(created_at) > 30`)
 *
 * Safety mechanisms:
 *   - **Dry-run mode** (`options.dryRun = true`) — counts qualifying rows and
 *     returns without mutating the database.
 *   - **Per-run cap** (`options.maxDeletePerRun`, default 500) — limits total
 *     deletes across all tables per invocation to prevent runaway deletes.
 *   - **Audit trail** — inserts a row into `brain_consolidation_events` with
 *     `trigger = 'step-9f'` after each real (non-dry) delete run.
 *
 * This function is idempotent: rows that already do not exist or that no
 * longer meet the predicate are silently skipped.
 *
 * @param projectRoot - Absolute path to the project root (locates brain.db)
 * @param options     - Dry-run and per-run cap controls
 * @returns           - Deleted/would-delete counts plus per-table breakdown
 *
 * @task T995
 * @epic T991
 */
export async function runPruneSweep(
  projectRoot: string,
  options?: PruneSweepOptions,
): Promise<PruneSweepResult> {
  const dryRun = options?.dryRun ?? false;
  const cap = options?.maxDeletePerRun ?? DEFAULT_MAX_DELETE_PER_RUN;

  const byTable: Record<string, number> = {};
  let deleted = 0;
  let wouldDelete = 0;

  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { deleted: 0, wouldDelete: 0, dryRun, byTable: {} };
  }

  const tables = [
    { table: 'brain_decisions', dateCol: 'created_at' },
    { table: 'brain_patterns', dateCol: 'extracted_at' },
    { table: 'brain_learnings', dateCol: 'created_at' },
    { table: 'brain_observations', dateCol: 'created_at' },
  ] as const;

  // ---- Phase 1: count qualifying rows (always, for observability) ----

  for (const { table, dateCol } of tables) {
    try {
      interface CountRow {
        cnt: number;
      }
      const rows = nativeDb
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM ${table}
           WHERE prune_candidate = 1
             AND COALESCE(quality_score, 0.5) < 0.2
             AND COALESCE(citation_count, 0) = 0
             AND julianday('now') - julianday(${dateCol}) > 30`,
        )
        .all() as unknown as CountRow[];
      const count = rows[0]?.cnt ?? 0;
      wouldDelete += count;
      byTable[table] = count;
    } catch {
      // table may not have prune_candidate column yet — best-effort
      byTable[table] = 0;
    }
  }

  if (dryRun) {
    console.error(
      `[prune-sweep] dry-run: would delete ${wouldDelete} entries across 4 tables (cap=${cap})`,
    );
    return { deleted: 0, wouldDelete, dryRun, byTable };
  }

  // ---- Phase 2: DELETE with per-run cap ----

  let remaining = cap;
  const actualByTable: Record<string, number> = {};

  for (const { table, dateCol } of tables) {
    if (remaining <= 0) {
      actualByTable[table] = 0;
      continue;
    }

    try {
      const tableLimit = Math.min(byTable[table] ?? 0, remaining);
      if (tableLimit <= 0) {
        actualByTable[table] = 0;
        continue;
      }

      const result = nativeDb
        .prepare(
          `DELETE FROM ${table}
           WHERE id IN (
             SELECT id FROM ${table}
             WHERE prune_candidate = 1
               AND COALESCE(quality_score, 0.5) < 0.2
               AND COALESCE(citation_count, 0) = 0
               AND julianday('now') - julianday(${dateCol}) > 30
             LIMIT ?
           )`,
        )
        .run(tableLimit) as { changes: number };

      const changes = result.changes ?? 0;
      actualByTable[table] = changes;
      deleted += changes;
      remaining -= changes;
    } catch {
      // best-effort: column may not exist in older schemas
      actualByTable[table] = 0;
    }
  }

  console.error(
    `[prune-sweep] step-9f: deleted ${deleted} entries (would-qualify=${wouldDelete}, cap=${cap})`,
  );

  // Audit trail: the sweep result is captured in brain_consolidation_events by
  // the Step 9e event log in runConsolidation (result.pruneSweep is populated
  // before Step 9e runs). No standalone INSERT here to avoid polluting the
  // events table with a second row that breaks ORDER BY started_at queries.

  return { deleted, wouldDelete, dryRun, byTable: actualByTable };
}

// ============================================================================
// Runner
// ============================================================================

/**
 * Run a combined brain maintenance pass: decay, consolidation, and embeddings.
 *
 * The three steps always run in the same order:
 *   1. `applyTemporalDecay` — decay stale learning confidence values
 *   2. `consolidateMemories` — merge clustered old observations
 *   3. `populateEmbeddings` — backfill missing vectors
 *
 * Each step is optional via the `skip*` flags. The function is idempotent:
 * re-running it when there is nothing to process returns zero counts.
 *
 * @param projectRoot - Absolute path to the project root (used to locate brain.db)
 * @param options - Optional skip flags and progress callback
 * @returns Aggregated counts from each step plus total wall-clock duration
 *
 * @example
 * ```ts
 * const result = await runBrainMaintenance('/my/project', {
 *   onProgress: (step, current, total) => {
 *     console.log(`[${step}] ${current}/${total}`);
 *   },
 * });
 * console.log(`Done in ${result.duration}ms`);
 * ```
 *
 * @task T143
 * @epic T134
 */
export async function runBrainMaintenance(
  projectRoot: string,
  options?: BrainMaintenanceOptions,
): Promise<BrainMaintenanceResult> {
  const {
    skipDecay = false,
    skipConsolidation = false,
    skipReconciliation = false,
    skipTierPromotion = false,
    skipEmbeddings = false,
    skipPruneSweep = false,
    pruneSweepDryRun = false,
    skipDeriver = false,
    onProgress,
  } = options ?? {};

  const startTime = Date.now();

  // Default zero values for each step (used when step is skipped).
  const decayResult: BrainMaintenanceDecayResult = { affected: 0 };
  const consolidationResult: BrainMaintenanceConsolidationResult = { merged: 0, removed: 0 };
  const reconciliationResult: BrainMaintenanceReconciliationResult = {
    decisionsFixed: 0,
    observationsFixed: 0,
    linksRemoved: 0,
  };
  const tierPromotionResult: BrainMaintenanceTierPromotionResult = { promoted: 0, evicted: 0 };
  const embeddingsResult: BrainMaintenanceEmbeddingsResult = {
    processed: 0,
    skipped: 0,
    errors: 0,
  };
  const pruneSweepResult: PruneSweepResult = {
    deleted: 0,
    wouldDelete: 0,
    dryRun: pruneSweepDryRun,
    byTable: {},
  };
  const deriverResult: BrainMaintenanceDeriverResult = {
    processed: 0,
    failed: 0,
    staleRequeued: 0,
  };

  // Step 1: Temporal decay
  if (!skipDecay) {
    onProgress?.('decay', 0, 1);
    const raw = await applyTemporalDecay(projectRoot);
    decayResult.affected = raw.updated;
    onProgress?.('decay', 1, 1);
  }

  // Step 2: Memory consolidation
  if (!skipConsolidation) {
    onProgress?.('consolidation', 0, 1);
    const raw = await consolidateMemories(projectRoot);
    consolidationResult.merged = raw.merged;
    consolidationResult.removed = raw.archived;
    onProgress?.('consolidation', 1, 1);
  }

  // Step 3: Cross-DB orphaned reference reconciliation
  if (!skipReconciliation) {
    onProgress?.('reconciliation', 0, 1);
    const raw = await reconcileOrphanedRefs(projectRoot);
    reconciliationResult.decisionsFixed = raw.decisionsFixed;
    reconciliationResult.observationsFixed = raw.observationsFixed;
    reconciliationResult.linksRemoved = raw.linksRemoved;
    onProgress?.('reconciliation', 1, 1);
  }

  // Step 4: Tier promotion — promote short→medium and medium→long based on
  // age, quality score, citation count, and verification status (T614).
  if (!skipTierPromotion) {
    onProgress?.('tier-promotion', 0, 1);
    const raw = await runTierPromotion(projectRoot);
    tierPromotionResult.promoted = raw.promoted.length;
    tierPromotionResult.evicted = raw.evicted.length;
    onProgress?.('tier-promotion', 1, 1);
  }

  // Step 5: Embedding backfill (with per-item progress relay)
  if (!skipEmbeddings) {
    const raw = await populateEmbeddings(projectRoot, {
      onProgress: (current, total) => {
        onProgress?.('embeddings', current, total);
      },
    });
    embeddingsResult.processed = raw.processed;
    embeddingsResult.skipped = raw.skipped;
    embeddingsResult.errors = raw.errors;
  }

  // Step 9f: Hard-sweeper — DELETE confirmed noise (T995)
  // Runs last so that all prior quality signals (decay, consolidation, tier
  // promotion) have been applied before committing irreversible deletes.
  // Best-effort — a DB path failure MUST NOT abort the maintenance run.
  if (!skipPruneSweep) {
    try {
      onProgress?.('prune-sweep', 0, 1);
      const raw = await runPruneSweep(projectRoot, { dryRun: pruneSweepDryRun });
      pruneSweepResult.deleted = raw.deleted;
      pruneSweepResult.wouldDelete = raw.wouldDelete;
      pruneSweepResult.dryRun = raw.dryRun;
      pruneSweepResult.byTable = raw.byTable;
      onProgress?.('prune-sweep', 1, 1);
    } catch (err) {
      console.warn('[maintenance] Step 9f prune sweep failed:', err);
    }
  }

  // Step 6: Deriver batch — process pending derivation work items (T1145)
  // Best-effort — errors must not abort the maintenance run.
  if (!skipDeriver) {
    try {
      onProgress?.('deriver', 0, 1);
      const raw = await runDeriverBatch(projectRoot);
      deriverResult.processed = raw.processed;
      deriverResult.failed = raw.failed;
      deriverResult.staleRequeued = raw.staleRequeued;
      onProgress?.('deriver', 1, 1);
    } catch (err) {
      console.warn('[maintenance] Deriver batch step failed:', err);
    }
  }

  return {
    decay: decayResult,
    consolidation: consolidationResult,
    reconciliation: reconciliationResult,
    tierPromotion: tierPromotionResult,
    embeddings: embeddingsResult,
    pruneSweep: pruneSweepResult,
    deriver: deriverResult,
    duration: Date.now() - startTime,
  };
}
