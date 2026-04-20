/**
 * BRAIN Ingester — Tier-2 proposal candidate source.
 *
 * Queries brain.db for recurring-pain observations (citation_count >= 3,
 * last 7 days, quality_score >= 0.5) and returns ranked ProposalCandidate[].
 *
 * Design principles:
 * - NO LLM calls. All data comes from structured SQL queries.
 * - Title is template-generated: `[T2-BRAIN] Recurring issue: {title}`.
 *   This is the prompt-injection defence from T1008 §3.6.
 * - Failures are swallowed: returns empty array + logs warning.
 *   Brain.db absence must never crash the propose tick.
 *
 * @task T1008
 * @see ADR-054 — Sentient Loop Tier-2
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ProposalCandidate } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Brain observation row (raw SQL result)
// ---------------------------------------------------------------------------

interface BrainObservationRow {
  id: string;
  title: string | null;
  text: string;
  citation_count: number;
  quality_score: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum candidates returned from a single brain ingester pass. */
export const BRAIN_INGESTER_LIMIT = 10;

/** Minimum citation count for a brain entry to be considered. */
export const BRAIN_MIN_CITATION_COUNT = 3;

/** Minimum quality score for a brain entry to be considered. */
export const BRAIN_MIN_QUALITY_SCORE = 0.5;

/** Lookback window in days for brain observations. */
export const BRAIN_LOOKBACK_DAYS = 7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute candidate weight from citation_count and quality_score.
 * Formula: `(citation_count / 10) * quality_score` capped at 1.0.
 */
export function computeBrainWeight(citationCount: number, qualityScore: number): number {
  return Math.min((citationCount / 10) * qualityScore, 1.0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the BRAIN ingester against the provided DatabaseSync handle.
 *
 * Returns at most {@link BRAIN_INGESTER_LIMIT} candidates, sorted by weight
 * descending. Returns an empty array if the database has no matching entries
 * or if any error occurs (errors are swallowed to never crash the tick).
 *
 * @param nativeDb - Open DatabaseSync handle to brain.db. May be null if
 *   brain.db has not been initialised; this is treated as zero candidates.
 * @returns Ranked ProposalCandidate array (may be empty).
 */
export function runBrainIngester(nativeDb: DatabaseSync | null): ProposalCandidate[] {
  if (!nativeDb) {
    return [];
  }

  try {
    const stmt = nativeDb.prepare(`
      SELECT id, title, text, citation_count, quality_score
      FROM brain_observations
      WHERE type IN ('bugfix', 'decision')
        AND citation_count >= :minCitations
        AND created_at >= datetime('now', :lookback)
        AND quality_score >= :minQuality
      ORDER BY citation_count DESC, quality_score DESC
      LIMIT :limit
    `);

    const rows = stmt.all({
      minCitations: BRAIN_MIN_CITATION_COUNT,
      lookback: `-${BRAIN_LOOKBACK_DAYS} days`,
      minQuality: BRAIN_MIN_QUALITY_SCORE,
      limit: BRAIN_INGESTER_LIMIT,
    }) as unknown as BrainObservationRow[];

    const candidates: ProposalCandidate[] = rows.map((row) => {
      const label = row.title ?? row.text.slice(0, 80);
      return {
        source: 'brain' as const,
        sourceId: row.id,
        title: `[T2-BRAIN] Recurring issue: ${label}`,
        rationale: `Brain entry ${row.id} cited ${row.citation_count} times (quality ${row.quality_score.toFixed(2)}) in the last ${BRAIN_LOOKBACK_DAYS} days`,
        weight: computeBrainWeight(row.citation_count, row.quality_score),
      };
    });

    // Sort descending by weight (DB ORDER BY handles primary sort, but
    // weight formula may produce different ordering than raw column order).
    candidates.sort((a, b) => b.weight - a.weight);

    return candidates;
  } catch (err) {
    // Best-effort: log warning but never throw from an ingester.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sentient/brain-ingester] WARNING: ${message}\n`);
    return [];
  }
}
