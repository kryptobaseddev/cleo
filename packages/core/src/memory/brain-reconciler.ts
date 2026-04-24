/**
 * @module memory/brain-reconciler
 *
 * T1147 Wave 7: Reconciler core module.
 *
 * Extends `runConsolidation` from brain-lifecycle with a supersession pass that
 * automatically invalidates older BRAIN entries when a newer entry contradicts
 * them with high confidence (edge weight > 0.8 on the `contradicts` graph edge).
 *
 * This module absorbs the T1139 scope (decision/learning/pattern supersession)
 * and adds a scheduled `reconciler` trigger type to `brain_consolidation_events`.
 *
 * @task T1147
 * @epic T1075
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  brainConsolidationEvents,
  brainDecisions,
  brainLearnings,
  brainObservations,
  brainPageEdges,
  brainPatterns,
} from '../store/memory-schema.js';
import { getBrainDb } from '../store/memory-sqlite.js';
import { runConsolidation } from './brain-lifecycle.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the reconciler pass. */
export interface ReconcilerOptions {
  /** Edge weight threshold above which a `contradicts` relationship triggers supersession. Default: 0.8 */
  contradictionThreshold?: number;
  /** Session ID to associate with consolidation events. */
  sessionId?: string | null;
  /** Dry-run mode: detect supersession candidates without writing `invalid_at`. */
  dryRun?: boolean;
}

/** Result returned by `runReconciler`. */
export interface ReconcilerResult {
  /** Number of entries superseded (invalid_at set) during the reconciler pass. */
  superseded: number;
  /** IDs of entries that were superseded, keyed by source table. */
  supersededIds: {
    observations: string[];
    learnings: string[];
    decisions: string[];
    patterns: string[];
  };
  /** Number of dedup/quality/promotion steps from the base consolidation pass. */
  consolidationResult: Awaited<ReturnType<typeof runConsolidation>>;
  /** Whether this was a dry run (no writes performed on supersession pass). */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Contradiction-edge supersession
// ---------------------------------------------------------------------------

/**
 * Queries `brain_page_edges` for `contradicts` edges with weight above the
 * threshold and marks the *source* entry (older) as superseded by setting
 * `invalid_at = now()` on the relevant brain table.
 *
 * The edge convention is: `source → contradicts → target`, where `target` is
 * the newer/stronger entry and `source` is the one to invalidate.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param threshold   - Edge weight threshold (default 0.8).
 * @param dryRun      - When true, returns candidates without writing.
 */
async function applySupersessionPass(
  projectRoot: string,
  threshold: number,
  dryRun: boolean,
): Promise<ReconcilerResult['supersededIds']> {
  const db = await getBrainDb(projectRoot);

  const supersededIds: ReconcilerResult['supersededIds'] = {
    observations: [],
    learnings: [],
    decisions: [],
    patterns: [],
  };

  // Find all `contradicts` edges whose weight is above the threshold.
  // Only consider edges where source entry has NOT already been superseded.
  const contradictEdges = await db
    .select({
      sourceId: brainPageEdges.fromId,
      targetId: brainPageEdges.toId,
      weight: brainPageEdges.weight,
    })
    .from(brainPageEdges)
    .where(and(eq(brainPageEdges.edgeType, 'contradicts'), gt(brainPageEdges.weight, threshold)))
    .all();

  if (contradictEdges.length === 0) {
    return supersededIds;
  }

  const nowIso = new Date().toISOString();

  // For each contradicts edge, attempt to supersede the source in each brain table.
  // We check each table in order; break once the source is found.
  for (const edge of contradictEdges) {
    const sourceId = edge.sourceId;

    // Check brain_observations
    const obs = await db
      .select({ id: brainObservations.id, invalidAt: brainObservations.invalidAt })
      .from(brainObservations)
      .where(and(eq(brainObservations.id, sourceId), isNull(brainObservations.invalidAt)))
      .get();

    if (obs) {
      supersededIds.observations.push(sourceId);
      if (!dryRun) {
        await db
          .update(brainObservations)
          .set({ invalidAt: nowIso })
          .where(eq(brainObservations.id, sourceId))
          .run();
      }
      continue;
    }

    // Check brain_learnings
    const lrn = await db
      .select({ id: brainLearnings.id, invalidAt: brainLearnings.invalidAt })
      .from(brainLearnings)
      .where(and(eq(brainLearnings.id, sourceId), isNull(brainLearnings.invalidAt)))
      .get();

    if (lrn) {
      supersededIds.learnings.push(sourceId);
      if (!dryRun) {
        await db
          .update(brainLearnings)
          .set({ invalidAt: nowIso })
          .where(eq(brainLearnings.id, sourceId))
          .run();
      }
      continue;
    }

    // Check brain_decisions
    const dec = await db
      .select({ id: brainDecisions.id, invalidAt: brainDecisions.invalidAt })
      .from(brainDecisions)
      .where(and(eq(brainDecisions.id, sourceId), isNull(brainDecisions.invalidAt)))
      .get();

    if (dec) {
      supersededIds.decisions.push(sourceId);
      if (!dryRun) {
        await db
          .update(brainDecisions)
          .set({ invalidAt: nowIso })
          .where(eq(brainDecisions.id, sourceId))
          .run();
      }
      continue;
    }

    // Check brain_patterns
    const pat = await db
      .select({ id: brainPatterns.id, invalidAt: brainPatterns.invalidAt })
      .from(brainPatterns)
      .where(and(eq(brainPatterns.id, sourceId), isNull(brainPatterns.invalidAt)))
      .get();

    if (pat) {
      supersededIds.patterns.push(sourceId);
      if (!dryRun) {
        await db
          .update(brainPatterns)
          .set({ invalidAt: nowIso })
          .where(eq(brainPatterns.id, sourceId))
          .run();
      }
    }
  }

  return supersededIds;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs the full reconciler pass for the given project.
 *
 * This is an extension of `runConsolidation` that adds a T1139 supersession
 * pass: entries whose `contradicts` edge weight exceeds `contradictionThreshold`
 * are marked `invalid_at = now()` in their respective brain tables.
 *
 * After the supersession pass, the result is logged to `brain_consolidation_events`
 * with `trigger = 'reconciler'`.
 *
 * @param projectRoot - Absolute path to the project root (used for DB location).
 * @param options     - Optional configuration overrides.
 * @returns Combined result from consolidation + supersession passes.
 *
 * @example
 * ```typescript
 * const result = await runReconciler('/mnt/projects/myapp');
 * console.log(`Superseded: ${result.superseded}, DryRun: ${result.dryRun}`);
 * ```
 */
export async function runReconciler(
  projectRoot: string,
  options: ReconcilerOptions = {},
): Promise<ReconcilerResult> {
  const { contradictionThreshold = 0.8, sessionId = null, dryRun = false } = options;

  // Step 1: Run the base consolidation pass (dedup, quality recompute, tier promotion,
  // contradiction detection, soft eviction, edge strengthening, summaries).
  const consolidationResult = await runConsolidation(projectRoot, sessionId, 'scheduled');

  // Step 2: Supersession pass — find contradicts edges and invalidate older entries.
  const supersededIds = await applySupersessionPass(projectRoot, contradictionThreshold, dryRun);

  const superseded =
    supersededIds.observations.length +
    supersededIds.learnings.length +
    supersededIds.decisions.length +
    supersededIds.patterns.length;

  // Step 3: Log reconciler event to brain_consolidation_events.
  // Use best-effort (no throw) so a logging failure does not abort the reconciler.
  try {
    const db = await getBrainDb(projectRoot);
    const stepResultsJson = JSON.stringify({
      consolidation: {
        deduplicated: consolidationResult.deduplicated,
        qualityRecomputed: consolidationResult.qualityRecomputed,
        contradictions: consolidationResult.contradictions,
        softEvicted: consolidationResult.softEvicted,
        promoted: consolidationResult.tierPromotions.promoted.length,
        summaries: consolidationResult.summariesGenerated,
      },
      supersession: {
        threshold: contradictionThreshold,
        superseded,
        supersededIds,
        dryRun,
        note: dryRun
          ? `dry-run: ${superseded} supersession candidates detected`
          : `superseded ${superseded} entries (threshold=${contradictionThreshold})`,
      },
    });
    await db
      .insert(brainConsolidationEvents)
      .values({
        trigger: 'reconciler',
        sessionId: sessionId ?? null,
        stepResultsJson,
        succeeded: true,
      })
      .run();
  } catch (err) {
    console.warn('[reconciler] Failed to log reconciler event:', err);
  }

  return {
    superseded,
    supersededIds,
    consolidationResult,
    dryRun,
  };
}

/**
 * Counts supersession candidates without applying any changes.
 *
 * Equivalent to `runReconciler(projectRoot, { dryRun: true })` but does NOT
 * run the full consolidation pass — faster for pre-flight checks.
 *
 * @param projectRoot          - Absolute path to the project root.
 * @param contradictionThreshold - Edge weight threshold (default 0.8).
 */
export async function countSupersessionCandidates(
  projectRoot: string,
  contradictionThreshold = 0.8,
): Promise<number> {
  const ids = await applySupersessionPass(projectRoot, contradictionThreshold, true);
  return (
    ids.observations.length + ids.learnings.length + ids.decisions.length + ids.patterns.length
  );
}

/**
 * Fire-and-forget wrapper that triggers a reconciler sweep asynchronously.
 *
 * Used by the dispatch-time brain health reflex (T1148 W8-8 / T1151) to
 * schedule a sweep when the corpus is detected as unhealthy during a Tier-2
 * propose tick.  Returns immediately without waiting for completion.
 *
 * Errors are swallowed silently — the proposer must not be disrupted by
 * maintenance tasks.
 *
 * @param projectRoot - Absolute path to the project root.
 */
export async function triggerReconcilerSweep(projectRoot: string): Promise<void> {
  await runReconciler(projectRoot, { dryRun: false });
}
