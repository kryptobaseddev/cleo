/**
 * /brain/overview server load (T990 Wave 1D rewrite).
 *
 * Kills the pre-Wave-1D SQL drift by consuming the API surface instead of
 * re-querying brain.db directly. Parallel-fetches the four data sources
 * it needs, falling back gracefully when the brain.db is missing.
 *
 * Sources:
 *   - /api/memory/tier-stats             — per-table tier split + upcoming promos
 *   - /api/memory/quality                — verified / prune counts, buckets
 *   - /api/memory/observations?limit=5   — recent observations
 *   - /api/memory/decisions              — recent decisions (limited client-side)
 *
 * @task T990
 * @wave 1D
 */

import type { PageServerLoad } from './$types';

interface Stat {
  value: string;
  label: string;
}

interface RecentObservation {
  id: string;
  title: string;
  type: string;
  quality_score: number | null;
  memory_tier: string | null;
  created_at: string;
}

interface RecentDecision {
  id: string;
  decision: string;
  confidence: string;
  memory_tier: string | null;
  created_at: string;
}

interface TierDistRow {
  table: string;
  short: number;
  medium: number;
  long: number;
}

interface UpcomingPromotion {
  id: string;
  table: string;
  daysUntil: number;
  track: string;
}

interface TierStatsShape {
  tables: TierDistRow[];
  upcomingLongPromotions: UpcomingPromotion[];
}

interface QualityShape {
  observations: {
    verified_count: number;
    prune_count: number;
    invalidated_count: number;
  };
  decisions: { verified_count: number };
  patterns: { verified_count: number };
  learnings: { verified_count: number };
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const load: PageServerLoad = async ({ fetch }) => {
  let stats: Stat[] | null = null;
  let tierDistribution: TierDistRow[] = [];
  let upcomingPromotions: UpcomingPromotion[] = [];
  let recentObservations: RecentObservation[] = [];
  let recentDecisions: RecentDecision[] = [];
  let quality: QualityShape | null = null;

  try {
    const [tierRes, qualityRes, obsRes, decRes] = await Promise.all([
      fetch('/api/memory/tier-stats'),
      fetch('/api/memory/quality'),
      fetch('/api/memory/observations?limit=5'),
      fetch('/api/memory/decisions'),
    ]);

    if (tierRes.ok) {
      const body = (await tierRes.json()) as TierStatsShape;
      tierDistribution = body.tables;
      upcomingPromotions = body.upcomingLongPromotions;
    }

    if (qualityRes.ok) {
      quality = (await qualityRes.json()) as QualityShape;
    }

    if (obsRes.ok) {
      const body = (await obsRes.json()) as {
        observations: Array<{
          id: string;
          title: string;
          type: string;
          quality_score: number | null;
          memory_tier: string | null;
          created_at: string;
        }>;
      };
      recentObservations = body.observations.slice(0, 5);
    }

    if (decRes.ok) {
      const body = (await decRes.json()) as {
        decisions: Array<{
          id: string;
          decision: string;
          confidence: string;
          memory_tier: string | null;
          created_at: string;
        }>;
      };
      recentDecisions = body.decisions
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5);
    }

    const tierTotals = tierDistribution.reduce(
      (acc, row) => ({
        entries: acc.entries + row.short + row.medium + row.long,
        long: acc.long + row.long,
      }),
      { entries: 0, long: 0 },
    );

    const observationRow = tierDistribution.find((r) => r.table === 'brain_observations');
    const decisionRow = tierDistribution.find((r) => r.table === 'brain_decisions');
    const patternRow = tierDistribution.find((r) => r.table === 'brain_patterns');
    const learningRow = tierDistribution.find((r) => r.table === 'brain_learnings');

    const obsTotal = observationRow
      ? observationRow.short + observationRow.medium + observationRow.long
      : 0;
    const decTotal = decisionRow ? decisionRow.short + decisionRow.medium + decisionRow.long : 0;
    const patTotal = patternRow ? patternRow.short + patternRow.medium + patternRow.long : 0;
    const learnTotal = learningRow ? learningRow.short + learningRow.medium + learningRow.long : 0;

    stats = [
      { value: formatCount(tierTotals.entries), label: 'Entries' },
      { value: formatCount(tierTotals.long), label: 'Long-tier' },
      { value: formatCount(obsTotal), label: 'Observations' },
      { value: formatCount(decTotal), label: 'Decisions' },
      { value: formatCount(patTotal), label: 'Patterns' },
      { value: formatCount(learnTotal), label: 'Learnings' },
      {
        value: formatCount(quality?.observations.verified_count ?? 0),
        label: 'Verified',
      },
      {
        value: formatCount(quality?.observations.prune_count ?? 0),
        label: 'Prune candidates',
      },
    ];
  } catch {
    // All optional — Page renders an empty state.
  }

  return {
    stats,
    tierDistribution,
    upcomingPromotions,
    recentObservations,
    recentDecisions,
    quality,
  };
};
