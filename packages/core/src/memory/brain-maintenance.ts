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

import { reconcileOrphanedRefs } from '../store/cross-db-cleanup.js';
import { applyTemporalDecay, consolidateMemories, runTierPromotion } from './brain-lifecycle.js';
import { populateEmbeddings } from './brain-retrieval.js';

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

  return {
    decay: decayResult,
    consolidation: consolidationResult,
    reconciliation: reconciliationResult,
    tierPromotion: tierPromotionResult,
    embeddings: embeddingsResult,
    duration: Date.now() - startTime,
  };
}
