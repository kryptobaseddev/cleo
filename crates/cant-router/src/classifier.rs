//! Layer 1: linear weighted classifier.
//!
//! Scores a [`PromptFeatures`] vector against the five-term linear
//! model from ULTRAPLAN §11.1 and maps the scalar score to a
//! [`Tier`] via two thresholds.
//!
//! The classifier is pure-function, deterministic, and requires no
//! training data — it is the Wave 6 baseline. A learned reranker will
//! supplant it in a later wave once the pipeline logger has collected
//! enough real-traffic observations.

use crate::types::{Classification, PromptFeatures, Tier};

/// Weight applied to the normalized `token_count` feature.
pub const WEIGHT_TOKEN_COUNT: f64 = 0.15;

/// Weight applied to the normalized `syntactic_complexity` feature.
pub const WEIGHT_SYNTACTIC_COMPLEXITY: f64 = 0.25;

/// Weight applied to the normalized `reasoning_depth` feature.
pub const WEIGHT_REASONING_DEPTH: f64 = 0.30;

/// Weight applied to the normalized `domain_specificity` feature.
pub const WEIGHT_DOMAIN_SPECIFICITY: f64 = 0.20;

/// Weight applied to the normalized `touches_files_count` feature.
pub const WEIGHT_TOUCHES_FILES_COUNT: f64 = 0.10;

/// Score threshold at or above which the classifier returns [`Tier::High`].
pub const THRESHOLD_HIGH: f64 = 0.75;

/// Score threshold at or above which the classifier returns [`Tier::Mid`].
///
/// Scores strictly below this threshold are mapped to [`Tier::Low`].
pub const THRESHOLD_MID: f64 = 0.35;

/// Classify a feature vector into a [`Classification`] result.
///
/// Applies the linear weighted sum from ULTRAPLAN §11.1 and maps the
/// resulting score to a tier via [`THRESHOLD_HIGH`] and
/// [`THRESHOLD_MID`]. The input [`PromptFeatures`] is preserved in the
/// returned [`Classification`] so downstream consumers can inspect the
/// raw signals that produced the decision.
#[must_use]
pub fn classify(features: PromptFeatures) -> Classification {
    let normalized = normalize_features(&features);
    let score = WEIGHT_TOKEN_COUNT * normalized.token_count
        + WEIGHT_SYNTACTIC_COMPLEXITY * normalized.syntactic_complexity
        + WEIGHT_REASONING_DEPTH * normalized.reasoning_depth
        + WEIGHT_DOMAIN_SPECIFICITY * normalized.domain_specificity
        + WEIGHT_TOUCHES_FILES_COUNT * normalized.touches_files_count;

    let tier = if score >= THRESHOLD_HIGH {
        Tier::High
    } else if score >= THRESHOLD_MID {
        Tier::Mid
    } else {
        Tier::Low
    };

    Classification {
        score,
        tier,
        features,
    }
}

/// Normalize each feature to `[0.0, 1.0]` for the weighted sum.
///
/// These normalization constants are heuristic v1 defaults. They are
/// tuned against the ULTRAPLAN §11.1 example ranges, not against a
/// labeled corpus — Wave 6.5+ work may refine them against real data
/// collected by the [`crate::pipeline::ObservationLog`].
fn normalize_features(f: &PromptFeatures) -> NormalizedFeatures {
    NormalizedFeatures {
        token_count: (f.token_count as f64 / 1000.0).min(1.0),
        syntactic_complexity: f.syntactic_complexity.clamp(0.0, 1.0),
        reasoning_depth: (f.reasoning_depth as f64 / 10.0).min(1.0),
        domain_specificity: f.domain_specificity.clamp(0.0, 1.0),
        touches_files_count: (f.touches_files_count as f64 / 20.0).min(1.0),
    }
}

/// Intermediate structure holding features clamped to `[0.0, 1.0]`.
struct NormalizedFeatures {
    token_count: f64,
    syntactic_complexity: f64,
    reasoning_depth: f64,
    domain_specificity: f64,
    touches_files_count: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper — build a `PromptFeatures` with explicit fields.
    fn features(
        token_count: usize,
        syntactic_complexity: f64,
        reasoning_depth: usize,
        domain_specificity: f64,
        touches_files_count: usize,
    ) -> PromptFeatures {
        PromptFeatures {
            token_count,
            syntactic_complexity,
            reasoning_depth,
            domain_specificity,
            touches_files_count,
        }
    }

    #[test]
    fn classify_low_tier_simple_prompt() {
        // All features near zero → score well below 0.35.
        let result = classify(features(5, 0.0, 0, 0.0, 0));
        assert_eq!(result.tier, Tier::Low);
        assert!(result.score < THRESHOLD_MID);
    }

    #[test]
    fn classify_mid_tier_moderate_prompt() {
        // Moderate features: 500 tokens, depth 2, 2 files, 0.3 complexity.
        // 0.15*0.5 + 0.25*0.3 + 0.30*0.2 + 0.20*0.3 + 0.10*0.1
        // = 0.075 + 0.075 + 0.06 + 0.06 + 0.01 = 0.28 — still Low
        // Bump to hit mid: 800 tokens, 0.5 complexity, depth 4, 0.5 domain, 6 files.
        // 0.15*0.8 + 0.25*0.5 + 0.30*0.4 + 0.20*0.5 + 0.10*0.3
        // = 0.12 + 0.125 + 0.12 + 0.10 + 0.03 = 0.495
        let result = classify(features(800, 0.5, 4, 0.5, 6));
        assert_eq!(result.tier, Tier::Mid);
        assert!(result.score >= THRESHOLD_MID);
        assert!(result.score < THRESHOLD_HIGH);
    }

    #[test]
    fn classify_high_tier_complex_prompt() {
        // Maximally complex prompt: saturates all normalizers.
        // Score = 0.15 + 0.25 + 0.30 + 0.20 + 0.10 = 1.00
        let result = classify(features(2000, 1.0, 20, 1.0, 30));
        assert_eq!(result.tier, Tier::High);
        assert!(result.score >= THRESHOLD_HIGH);
    }

    #[test]
    fn classify_boundary_035_score() {
        // Craft features so the weighted sum equals exactly 0.35:
        // Set all features to values that produce 0.35.
        // If reasoning_depth contributes the full 0.30 (depth >= 10),
        // we need 0.05 more from somewhere. token_count 1000 saturates
        // at 0.15 * 1.0 = 0.15 which is too much. Instead, use token_count
        // that normalizes to exactly 1/3: 334 tokens → 0.334 * 0.15 = 0.0501
        // Close to 0.35. Safer: depth 10 (full 0.30) + token_count 334
        // (0.334 * 0.15 = 0.0501). Total ~0.3501. That's mid.
        //
        // But we want to test the BOUNDARY behavior. Use a simpler
        // construction: craft a feature vector that produces exactly 0.35.
        // Set domain_specificity = 1.0 (contributes 0.20), reasoning_depth = 5
        // (0.5 * 0.30 = 0.15). Total = 0.35 exactly.
        let result = classify(features(0, 0.0, 5, 1.0, 0));
        assert!((result.score - 0.35).abs() < 1e-9);
        // At exactly 0.35 we should land in Mid (>= THRESHOLD_MID).
        assert_eq!(result.tier, Tier::Mid);
    }

    #[test]
    fn classify_boundary_075_score() {
        // Craft features so the weighted sum equals exactly 0.75.
        // Use reasoning_depth = 10 (full 0.30), domain_specificity = 1.0 (0.20),
        // syntactic_complexity = 1.0 (0.25). Total = 0.30 + 0.20 + 0.25 = 0.75.
        let result = classify(features(0, 1.0, 10, 1.0, 0));
        assert!((result.score - 0.75).abs() < 1e-9);
        // At exactly 0.75 we should land in High (>= THRESHOLD_HIGH).
        assert_eq!(result.tier, Tier::High);
    }

    #[test]
    fn classify_preserves_input_features() {
        let f = features(123, 0.5, 4, 0.7, 9);
        let result = classify(f);
        assert_eq!(result.features.token_count, 123);
        assert_eq!(result.features.reasoning_depth, 4);
        assert_eq!(result.features.touches_files_count, 9);
    }

    #[test]
    fn classify_normalizers_saturate() {
        // Even with extreme values, score cannot exceed the weight sum (1.0).
        let result = classify(features(usize::MAX, 999.0, usize::MAX, 999.0, usize::MAX));
        assert!(result.score <= 1.0 + f64::EPSILON);
        assert_eq!(result.tier, Tier::High);
    }
}
