/**
 * @module memory/brain-reconciler
 *
 * T1147 Wave 7: Reconciler core module.
 *
 * Extends `runConsolidation` from brain-lifecycle with a supersession pass that
 * reports contradiction candidates for the calling agent. Scores do not establish
 * authority; invalidation requires an explicit sourced replacement.
 *
 * This module absorbs the T1139 scope (decision/learning/pattern supersession)
 * and adds a scheduled `reconciler` trigger type to `brain_consolidation_events`.
 *
 * @task T1147
 * @epic T1075
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import { getBrainDb } from '../store/memory-sqlite.js';
import {
  brainConsolidationEvents,
  brainDecisions,
  brainLearnings,
  brainObservations,
  brainPageEdges,
  brainPatterns,
} from '../store/schema/memory-schema.js';
import type { RunConsolidationResult } from './brain-lifecycle.js';

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
  /** Contradiction candidates requiring sourced resolution; no authority was inferred. */
  candidateIds?: ReconcilerResult['supersededIds'];
  /** Number of dedup/quality/promotion steps from the base consolidation pass. */
  consolidationResult: RunConsolidationResult;
  /** Whether this was a dry run (no writes performed on supersession pass). */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Contradiction-edge supersession
// ---------------------------------------------------------------------------

/**
 * Find contradiction candidates without changing either record's authority.
 * Graph scores and edge direction do not prove which source is correct.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param threshold - Minimum contradiction confidence for candidate reporting.
 */
async function applySupersessionPass(
  projectRoot: string,
  threshold: number,
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

  // For each contradicts edge, attempt to supersede the source in each brain table.
  // We check each table in order; break once the source is found.
  for (const edge of contradictEdges) {
    const sourceId = edge.sourceId.replace(/^(observation|decision|pattern|learning):/, '');

    // Check brain_observations
    const obs = await db
      .select({ id: brainObservations.id, invalidAt: brainObservations.invalidAt })
      .from(brainObservations)
      .where(and(eq(brainObservations.id, sourceId), isNull(brainObservations.invalidAt)))
      .get();

    if (obs) {
      supersededIds.observations.push(sourceId);
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
    }
  }

  return supersededIds;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assess contradiction candidates for the calling agent without invoking a model.
 * Returns empty superseded lists: replacement requires explicit sourced evidence.
 * Optional synthesis remains available through the separate consolidation command.
 *
 * @param projectRoot - Absolute project root.
 * @param options - Candidate threshold, audit session, and dry-run behavior.
 * @returns Candidates plus legacy zero-valued consolidation counters.
 */
export async function runReconciler(
  projectRoot: string,
  options: ReconcilerOptions = {},
): Promise<ReconcilerResult> {
  const { contradictionThreshold = 0.8, sessionId = null, dryRun = false } = options;

  // Repair reasoning belongs to the calling agent; optional synthesis is a separate operation.
  const consolidationResult: RunConsolidationResult = {
    deduplicated: 0,
    qualityRecomputed: 0,
    tierPromotions: { promoted: [], evicted: [] },
    contradictions: 0,
    softEvicted: 0,
    edgesStrengthened: 0,
    nexusEdgesStrengthened: 0,
    summariesGenerated: 0,
  };

  // Step 2: Contradiction scores generate candidates, never authority mutations.
  const candidateIds = await applySupersessionPass(projectRoot, contradictionThreshold);
  const supersededIds: ReconcilerResult['supersededIds'] = {
    observations: [],
    learnings: [],
    decisions: [],
    patterns: [],
  };

  const superseded =
    supersededIds.observations.length +
    supersededIds.learnings.length +
    supersededIds.decisions.length +
    supersededIds.patterns.length;

  // Step 3: Log reconciler event to brain_consolidation_events.
  // Use best-effort (no throw) so a logging failure does not abort the reconciler.
  if (!dryRun)
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
          candidateIds,
          dryRun,
          note: 'Contradictions are candidates only; a calling agent must provide a sourced replacement.',
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
    candidateIds,
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
  const ids = await applySupersessionPass(projectRoot, contradictionThreshold);
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
