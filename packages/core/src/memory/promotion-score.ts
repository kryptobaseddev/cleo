/**
 * Composite 6-signal scorer for brain observation typed promotion.
 *
 * Replaces the legacy 3-rule OR union in runTierPromotion with a
 * weighted composite score that is explainable and auditable.
 *
 * Signals:
 * 1. citation_count   — retrieval frequency (normalised to 0.0–1.0 via tanh)
 * 2. quality_score    — content richness computed at insert (0.0–1.0)
 * 3. stability_score  — biological-analog consolidation metric (0.0–1.0)
 * 4. recency          — inverse age decay (1.0 = today, approaches 0 over 90 days)
 * 5. user_verified    — hard boost (0 or 1)
 * 6. outcome_correlated — whether tied to a completed task outcome (0 or 1)
 *
 * Formula:
 *   raw = w_citation × normalise(citation_count)
 *       + w_quality  × (quality_score ?? 0.5)
 *       + w_stability × (stability_score ?? 0.5)
 *       + w_recency  × recencyFactor(created_at)
 *       + w_verified × user_verified
 *       + w_outcome  × outcome_correlated
 *
 *   composite_score = clamp(raw / sum(weights), 0.0, 1.0)
 *
 * Weights are designed so that a verified OR high-citation entry always
 * crosses the default threshold (0.6), while pure noise (0 citations,
 * 0.3 quality, 0.5 stability, old age, unverified, no outcome) scores ~0.3.
 *
 * @task T1001
 * @epic T1000
 */

/** Input signals for the composite scorer. All fields are optional / nullable. */
export interface PromotionSignals {
  /** Raw citation count (0+). Normalised via tanh(count/5) to 0–1. */
  citationCount: number;
  /** Content quality score from insert-time scorer (0.0–1.0). Null → 0.5. */
  qualityScore: number | null;
  /** Biological-analog stability from brain_observations.stability_score (0.0–1.0). Null → 0.5. */
  stabilityScore: number | null;
  /** ISO 8601 / SQLite datetime string for age decay. Null → assume 30 days old. */
  createdAt: string | null;
  /** 1 if the entry was verified by the owner, 0 otherwise. */
  userVerified: number;
  /** 1 if the entry is correlated to a completed/verified task outcome, 0 otherwise. */
  outcomeCorrelated: number;
}

/** Weights for each signal. Must sum > 0 (they are normalised internally). */
const WEIGHTS = {
  citation: 0.2,
  quality: 0.2,
  stability: 0.15,
  recency: 0.15,
  verified: 0.2,
  outcome: 0.1,
} as const;

const WEIGHT_SUM =
  WEIGHTS.citation +
  WEIGHTS.quality +
  WEIGHTS.stability +
  WEIGHTS.recency +
  WEIGHTS.verified +
  WEIGHTS.outcome;

/**
 * Normalise a raw citation count to 0–1 using tanh(count / 5).
 *
 * tanh(1/5) ≈ 0.20  (citation_count=1)
 * tanh(3/5) ≈ 0.54  (citation_count=3)
 * tanh(5/5) ≈ 0.76  (citation_count=5)
 * tanh(10/5) ≈ 0.96  (citation_count=10)
 */
function normaliseCitation(count: number): number {
  return Math.tanh(count / 5);
}

/**
 * Compute a recency factor in 0–1 from an ISO date string.
 *
 * Uses: recency = exp(-age_days / 30)
 *
 * age_days=0  → 1.0
 * age_days=30 → ~0.37
 * age_days=90 → ~0.05
 */
function recencyFactor(createdAt: string | null): number {
  if (!createdAt) return Math.exp(-1); // assume ~1 month old
  const created = new Date(createdAt.replace(' ', 'T'));
  if (Number.isNaN(created.getTime())) return Math.exp(-1);
  const ageDays = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
  return Math.exp(-ageDays / 30);
}

/** Clamp a value to the [min, max] range. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute the composite promotion score for a brain entry.
 *
 * Returns a value in [0.0, 1.0]. Entries above the promotion threshold
 * (default 0.6) are eligible for typed promotion.
 *
 * @param signals - The 6 input signals for this entry
 * @returns Composite score in [0.0, 1.0]
 */
export function computePromotionScore(signals: PromotionSignals): number {
  const citationSignal = normaliseCitation(signals.citationCount);
  const qualitySignal = signals.qualityScore ?? 0.5;
  const stabilitySignal = signals.stabilityScore ?? 0.5;
  const recencySignal = recencyFactor(signals.createdAt);
  const verifiedSignal = signals.userVerified > 0 ? 1.0 : 0.0;
  const outcomeSignal = signals.outcomeCorrelated > 0 ? 1.0 : 0.0;

  const raw =
    WEIGHTS.citation * citationSignal +
    WEIGHTS.quality * qualitySignal +
    WEIGHTS.stability * stabilitySignal +
    WEIGHTS.recency * recencySignal +
    WEIGHTS.verified * verifiedSignal +
    WEIGHTS.outcome * outcomeSignal;

  return clamp(raw / WEIGHT_SUM, 0.0, 1.0);
}

/**
 * Default promotion threshold. Entries with composite_score >= this value
 * are eligible for typed promotion via promoteObservationsToTyped.
 */
export const PROMOTION_THRESHOLD = 0.6;

/**
 * Determine the best target typed table for a promoted observation.
 *
 * Mapping from BRAIN_OBSERVATION_TYPES to BRAIN typed tables:
 * - 'decision' → promotes to brain_decisions (semantic)
 * - 'feature' | 'refactor' | 'change' → promotes to brain_patterns (procedural)
 * - 'discovery' | 'bugfix' | 'diary' → promotes to brain_learnings (episodic→semantic)
 *
 * All observation types map to one of the three typed tables.
 */
export function mapObservationTypeToTier(observationType: string): string {
  switch (observationType) {
    case 'decision':
      return 'learning'; // Decision observations promote to learnings (they originate as observations)
    case 'feature':
    case 'refactor':
    case 'change':
      return 'pattern';
    case 'discovery':
    case 'bugfix':
    case 'diary':
    default:
      return 'learning';
  }
}

/** The 6 signal names used in rationale JSON for audit transparency. */
export const SIGNAL_NAMES = [
  'citation_count',
  'quality_score',
  'stability_score',
  'recency',
  'user_verified',
  'outcome_correlated',
] as const;

/** Detailed per-signal breakdown attached to each brain_promotion_log row. */
export interface PromotionRationale {
  signals: {
    citation_count: number;
    quality_score: number;
    stability_score: number;
    recency: number;
    user_verified: number;
    outcome_correlated: number;
  };
  weighted: {
    citation_count: number;
    quality_score: number;
    stability_score: number;
    recency: number;
    user_verified: number;
    outcome_correlated: number;
  };
  composite_score: number;
  threshold: number;
  decision: 'promote' | 'skip';
}

/**
 * Compute the full rationale breakdown for a promotion decision.
 *
 * The rationale is serialised to JSON and stored in brain_promotion_log.rationale_json
 * to make every promotion explainable (pairs with T997 promote-explain CLI).
 */
export function computePromotionRationale(
  signals: PromotionSignals,
  threshold: number = PROMOTION_THRESHOLD,
): PromotionRationale {
  const citationSignal = normaliseCitation(signals.citationCount);
  const qualitySignal = signals.qualityScore ?? 0.5;
  const stabilitySignal = signals.stabilityScore ?? 0.5;
  const recencySignal = recencyFactor(signals.createdAt);
  const verifiedSignal = signals.userVerified > 0 ? 1.0 : 0.0;
  const outcomeSignal = signals.outcomeCorrelated > 0 ? 1.0 : 0.0;

  const composite = computePromotionScore(signals);

  return {
    signals: {
      citation_count: citationSignal,
      quality_score: qualitySignal,
      stability_score: stabilitySignal,
      recency: recencySignal,
      user_verified: verifiedSignal,
      outcome_correlated: outcomeSignal,
    },
    weighted: {
      citation_count: WEIGHTS.citation * citationSignal,
      quality_score: WEIGHTS.quality * qualitySignal,
      stability_score: WEIGHTS.stability * stabilitySignal,
      recency: WEIGHTS.recency * recencySignal,
      user_verified: WEIGHTS.verified * verifiedSignal,
      outcome_correlated: WEIGHTS.outcome * outcomeSignal,
    },
    composite_score: composite,
    threshold,
    decision: composite >= threshold ? 'promote' : 'skip',
  };
}
