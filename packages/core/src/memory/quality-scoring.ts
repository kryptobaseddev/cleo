/**
 * Quality scoring for CLEO BRAIN memory entries.
 *
 * Computes a 0.0–1.0 quality score at insert time for each typed brain table entry.
 * Entries with a score below the minimum threshold are excluded from search results.
 *
 * Score formula per CA1 spec Section 3: source reliability * content richness * recency signals.
 * Each helper clamps the result to [0.0, 1.0].
 *
 * T549 Wave 1-B: source confidence multipliers and memory tier bonuses are applied
 * on top of the existing base formulas. The base formulas are unchanged; the
 * multiplier and tier bonus are additive final transforms.
 *
 * Exported for use in backfill (T530) and future scoring hooks.
 *
 * @task T531 T549
 * @epic T523
 */

import type { BrainMemoryTier, BrainSourceConfidence } from '../store/brain-schema.js';

/** Minimum quality score for inclusion in search results. */
export const QUALITY_SCORE_THRESHOLD = 0.3;

// ============================================================================
// T549: Source Confidence Multipliers
// ============================================================================

/**
 * Quality multiplier per source confidence level (T549 §3.1.5 and §5.3).
 *
 * Applied as a final multiplicative transform on top of the existing base score.
 * Separate from content richness — captures trustworthiness of the source.
 *
 * | Level         | Meaning                                 | Multiplier |
 * |---------------|-----------------------------------------|------------|
 * | owner         | Owner explicitly stated this fact       | 1.0        |
 * | task-outcome  | Verified by completed task with result  | 0.90       |
 * | agent         | Agent-inferred during work (default)    | 0.70       |
 * | speculative   | Agent hypothesis, not yet corroborated  | 0.40       |
 */
const SOURCE_MULTIPLIERS: Record<BrainSourceConfidence, number> = {
  owner: 1.0,
  'task-outcome': 0.9,
  agent: 0.7,
  speculative: 0.4,
};

/**
 * Tier bonus applied after the source multiplier (T549 Wave 1-B).
 *
 * Short-term entries get no bonus (they are new and unproven).
 * Medium-term entries get a small bonus (survived session consolidation).
 * Long-term entries get a larger bonus (architecturally proven).
 */
const TIER_BONUS: Record<BrainMemoryTier, number> = {
  short: 0.0,
  medium: 0.05,
  long: 0.1,
};

/**
 * Apply the source confidence multiplier and optional memory tier bonus.
 *
 * This is the final transform in every compute function. It multiplies the
 * raw content-richness score by the source multiplier, then adds the tier
 * bonus, then clamps to [0.0, 1.0].
 *
 * @param rawScore - Score from the base content-richness formula
 * @param sourceConfidence - Source reliability level (defaults to 'agent')
 * @param memoryTier - Memory retention tier (defaults to 'short' = no bonus)
 */
export function applySourceMultiplier(
  rawScore: number,
  sourceConfidence: BrainSourceConfidence = 'agent',
  memoryTier: BrainMemoryTier = 'short',
): number {
  const multiplied = rawScore * SOURCE_MULTIPLIERS[sourceConfidence];
  const withTierBonus = multiplied + TIER_BONUS[memoryTier];
  return clamp(withTierBonus);
}

// ============================================================================
// Pattern quality
// ============================================================================

/** Input shape for pattern quality computation — mirrors StorePatternParams. */
export interface PatternQualityInput {
  type: string;
  pattern: string;
  context?: string | null;
  examples_json?: string | null;
  /** T549: source reliability level — applies multiplier on top of base score. */
  sourceConfidence?: BrainSourceConfidence;
  /** T549: memory retention tier — applies tier bonus on top of multiplied score. */
  memoryTier?: BrainMemoryTier;
}

/**
 * Compute quality score for a brain_patterns row.
 *
 * Base: 0.4 (auto-generated patterns start lower).
 * Bonuses:
 *   +0.10 for 'workflow' type (structured operational knowledge)
 *   +0.05 for 'success' type (validated positive pattern)
 *   +0.10 if pattern text exceeds 100 chars (richer description)
 *   +0.10 if context exceeds 50 chars (contextual detail present)
 *   +0.10 if examples_json contains more than 3 items (empirically validated)
 *
 * T549 Wave 1-B: raw score is then multiplied by the source confidence multiplier
 * and the memory tier bonus is added. Result clamped to [0.0, 1.0].
 */
export function computePatternQuality(params: PatternQualityInput): number {
  let score = 0.4;

  if (params.type === 'workflow') score += 0.1;
  if (params.type === 'success') score += 0.05;

  if (params.pattern.length > 100) score += 0.1;
  if (params.context && params.context.length > 50) score += 0.1;

  if (params.examples_json) {
    try {
      const examples = JSON.parse(params.examples_json) as unknown[];
      if (Array.isArray(examples) && examples.length > 3) score += 0.1;
    } catch {
      // Malformed JSON — no bonus
    }
  }

  return applySourceMultiplier(score, params.sourceConfidence, params.memoryTier);
}

// ============================================================================
// Learning quality
// ============================================================================

/** Input shape for learning quality computation — mirrors StoreLearningParams. */
export interface LearningQualityInput {
  confidence: number;
  actionable?: boolean | null;
  insight: string;
  application?: string | null;
  /** T549: source reliability level — applies multiplier on top of base score. */
  sourceConfidence?: BrainSourceConfidence;
  /** T549: memory retention tier — applies tier bonus on top of multiplied score. */
  memoryTier?: BrainMemoryTier;
}

/**
 * Compute quality score for a brain_learnings row.
 *
 * Base: confidence value (already 0.0–1.0, caller-provided).
 * Bonuses:
 *   +0.10 if actionable (directly applicable guidance)
 *   +0.10 if insight text exceeds 100 chars (detailed insight)
 *   +0.10 if application exceeds 20 chars (concrete application context)
 *
 * T549 Wave 1-B: raw score is then multiplied by the source confidence multiplier
 * and the memory tier bonus is added. Result clamped to [0.0, 1.0].
 */
export function computeLearningQuality(params: LearningQualityInput): number {
  let score = params.confidence ?? 0.5;

  if (params.actionable) score += 0.1;
  if (params.insight.length > 100) score += 0.1;
  if (params.application && params.application.length > 20) score += 0.1;

  return applySourceMultiplier(score, params.sourceConfidence, params.memoryTier);
}

// ============================================================================
// Decision quality
// ============================================================================

/** Input shape for decision quality computation — mirrors StoreDecisionParams. */
export interface DecisionQualityInput {
  confidence: 'low' | 'medium' | 'high';
  rationale?: string | null;
  contextTaskId?: string | null;
  /** T549: source reliability level — applies multiplier on top of base score. */
  sourceConfidence?: BrainSourceConfidence;
  /** T549: memory retention tier — applies tier bonus on top of multiplied score. */
  memoryTier?: BrainMemoryTier;
}

/** Numeric value map from confidence level. */
const CONFIDENCE_SCORE_MAP: Record<'low' | 'medium' | 'high', number> = {
  high: 0.9,
  medium: 0.7,
  low: 0.5,
};

/**
 * Compute quality score for a brain_decisions row.
 *
 * Base: mapped from confidence level (high=0.9, medium=0.7, low=0.5).
 * Bonuses:
 *   +0.10 if rationale exceeds 50 chars (substantiated reasoning)
 *   +0.05 if linked to a specific task (anchored in real work)
 *
 * T549 Wave 1-B: raw score is then multiplied by the source confidence multiplier
 * and the memory tier bonus is added. Result clamped to [0.0, 1.0].
 */
export function computeDecisionQuality(params: DecisionQualityInput): number {
  let score = CONFIDENCE_SCORE_MAP[params.confidence] ?? 0.5;

  if (params.rationale && params.rationale.length > 50) score += 0.1;
  if (params.contextTaskId) score += 0.05;

  return applySourceMultiplier(score, params.sourceConfidence, params.memoryTier);
}

// ============================================================================
// Observation quality
// ============================================================================

/** Input shape for observation quality computation — mirrors ObserveBrainParams. */
export interface ObservationQualityInput {
  text: string;
  title?: string | null;
  /** T549: source reliability level — applies multiplier on top of base score. */
  sourceConfidence?: BrainSourceConfidence;
  /** T549: memory retention tier — applies tier bonus on top of multiplied score. */
  memoryTier?: BrainMemoryTier;
}

/**
 * Compute quality score for a brain_observations row.
 *
 * Base: 0.6 (manual observations start higher than auto-extracted entries).
 * Bonuses:
 *   +0.10 if text exceeds 200 chars (rich narrative)
 *   +0.05 if title exceeds 10 chars (meaningful label)
 *
 * T549 Wave 1-B: raw score is then multiplied by the source confidence multiplier
 * and the memory tier bonus is added. Result clamped to [0.0, 1.0].
 */
export function computeObservationQuality(params: ObservationQualityInput): number {
  let score = 0.6;

  if (params.text && params.text.length > 200) score += 0.1;
  if (params.title && params.title.length > 10) score += 0.05;

  return applySourceMultiplier(score, params.sourceConfidence, params.memoryTier);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Clamp a score to the valid [0.0, 1.0] range.
 */
function clamp(score: number): number {
  return Math.min(1.0, Math.max(0.0, score));
}
