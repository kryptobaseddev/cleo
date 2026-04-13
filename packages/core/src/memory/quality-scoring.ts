/**
 * Quality scoring for CLEO BRAIN memory entries.
 *
 * Computes a 0.0–1.0 quality score at insert time for each typed brain table entry.
 * Entries with a score below the minimum threshold are excluded from search results.
 *
 * Score formula per CA1 spec Section 3: source reliability * content richness * recency signals.
 * Each helper clamps the result to [0.0, 1.0].
 *
 * Exported for use in backfill (T530) and future scoring hooks.
 *
 * @task T531
 * @epic T523
 */

/** Minimum quality score for inclusion in search results. */
export const QUALITY_SCORE_THRESHOLD = 0.3;

// ============================================================================
// Pattern quality
// ============================================================================

/** Input shape for pattern quality computation — mirrors StorePatternParams. */
export interface PatternQualityInput {
  type: string;
  pattern: string;
  context?: string | null;
  examples_json?: string | null;
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
 * Result clamped to [0.0, 1.0].
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

  return clamp(score);
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
 * Result clamped to [0.0, 1.0].
 */
export function computeLearningQuality(params: LearningQualityInput): number {
  let score = params.confidence ?? 0.5;

  if (params.actionable) score += 0.1;
  if (params.insight.length > 100) score += 0.1;
  if (params.application && params.application.length > 20) score += 0.1;

  return clamp(score);
}

// ============================================================================
// Decision quality
// ============================================================================

/** Input shape for decision quality computation — mirrors StoreDecisionParams. */
export interface DecisionQualityInput {
  confidence: 'low' | 'medium' | 'high';
  rationale?: string | null;
  contextTaskId?: string | null;
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
 * Result clamped to [0.0, 1.0].
 */
export function computeDecisionQuality(params: DecisionQualityInput): number {
  let score = CONFIDENCE_SCORE_MAP[params.confidence] ?? 0.5;

  if (params.rationale && params.rationale.length > 50) score += 0.1;
  if (params.contextTaskId) score += 0.05;

  return clamp(score);
}

// ============================================================================
// Observation quality
// ============================================================================

/** Input shape for observation quality computation — mirrors ObserveBrainParams. */
export interface ObservationQualityInput {
  text: string;
  title?: string | null;
}

/**
 * Compute quality score for a brain_observations row.
 *
 * Base: 0.6 (manual observations start higher than auto-extracted entries).
 * Bonuses:
 *   +0.10 if text exceeds 200 chars (rich narrative)
 *   +0.05 if title exceeds 10 chars (meaningful label)
 *
 * Result clamped to [0.0, 1.0].
 */
export function computeObservationQuality(params: ObservationQualityInput): number {
  let score = 0.6;

  if (params.text && params.text.length > 200) score += 0.1;
  if (params.title && params.title.length > 10) score += 0.05;

  return clamp(score);
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
