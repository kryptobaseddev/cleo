//! Layer 2: rules engine — tier matrix and fallback chain.
//!
//! Consumes a [`Classification`] and produces a [`ModelSelection`]
//! describing the primary model, fallback chain, cost cap, and
//! latency budget. The tier matrix is a Rust constant for v1 (per
//! Wave 6 scope) — future waves can load it from a cant-based config.
//!
//! Callers may override cost/latency defaults via
//! [`route_with_caps`] and may downgrade a selection on a cost-cap
//! exceeded event via [`downgrade_for_cost`].

use crate::types::{Classification, ModelSelection, PromptFeatures, Tier};

/// Route a classification to a default [`ModelSelection`].
///
/// Applies the tier matrix with the v1 default cost cap and latency
/// budget for the classification's tier.
#[must_use]
pub fn route(classification: Classification) -> ModelSelection {
    route_with_caps(classification, None, None)
}

/// Route a classification with optional overrides for cost and latency.
///
/// Passing `Some(cap)` replaces the tier's default cost cap; passing
/// `None` uses the default. Same for `latency_budget_override_ms`.
/// Both overrides default independently.
#[must_use]
pub fn route_with_caps(
    classification: Classification,
    cost_cap_override_usd: Option<f64>,
    latency_budget_override_ms: Option<u64>,
) -> ModelSelection {
    let (primary, fallbacks, default_cost, default_latency, reason) = match classification.tier {
        Tier::High => (
            "claude-opus-4-6",
            vec!["claude-sonnet-4-6".to_string(), "kimi-k2.5".to_string()],
            2.00_f64,
            60_000_u64,
            format!("high tier: score={:.3} >= 0.75", classification.score),
        ),
        Tier::Mid => (
            "claude-sonnet-4-6",
            vec!["kimi-k2.5".to_string(), "claude-haiku-4-5".to_string()],
            0.50_f64,
            30_000_u64,
            format!("mid tier: 0.35 <= score={:.3} < 0.75", classification.score),
        ),
        Tier::Low => (
            "claude-haiku-4-5",
            vec!["kimi-k2.5".to_string()],
            0.10_f64,
            10_000_u64,
            format!("low tier: score={:.3} < 0.35", classification.score),
        ),
    };

    ModelSelection {
        tier: classification.tier,
        primary_model: primary.to_string(),
        fallback_models: fallbacks,
        cost_cap_usd: cost_cap_override_usd.unwrap_or(default_cost),
        latency_budget_ms: latency_budget_override_ms.unwrap_or(default_latency),
        reason,
    }
}

/// Downgrade a selection by one tier in response to a cost-cap event.
///
/// Used by the fail-open policy in ULTRAPLAN §11: when a request
/// trips the cost cap, the router downgrades to the next-lower tier
/// and retries. Returns `None` if the selection is already at
/// [`Tier::Low`] (no further downgrade possible).
#[must_use]
pub fn downgrade_for_cost(selection: ModelSelection) -> Option<ModelSelection> {
    let downgraded_tier = match selection.tier {
        Tier::High => Tier::Mid,
        Tier::Mid => Tier::Low,
        Tier::Low => return None,
    };
    // Build a synthetic classification so we can re-route through the
    // normal rules engine. The synthetic classification carries a
    // zero-score feature vector because the original feature data is
    // not required for routing — only the tier matters for the matrix
    // lookup.
    let classification = Classification {
        score: 0.0,
        tier: downgraded_tier,
        features: PromptFeatures {
            token_count: 0,
            syntactic_complexity: 0.0,
            reasoning_depth: 0,
            domain_specificity: 0.0,
            touches_files_count: 0,
        },
    };
    Some(route(classification))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper — build a `Classification` with a given tier.
    fn classification(tier: Tier, score: f64) -> Classification {
        Classification {
            score,
            tier,
            features: PromptFeatures {
                token_count: 0,
                syntactic_complexity: 0.0,
                reasoning_depth: 0,
                domain_specificity: 0.0,
                touches_files_count: 0,
            },
        }
    }

    #[test]
    fn route_low_returns_haiku() {
        let sel = route(classification(Tier::Low, 0.1));
        assert_eq!(sel.tier, Tier::Low);
        assert_eq!(sel.primary_model, "claude-haiku-4-5");
        assert_eq!(sel.fallback_models, vec!["kimi-k2.5".to_string()]);
        assert!((sel.cost_cap_usd - 0.10).abs() < f64::EPSILON);
        assert_eq!(sel.latency_budget_ms, 10_000);
        assert!(sel.reason.contains("low tier"));
    }

    #[test]
    fn route_mid_returns_sonnet() {
        let sel = route(classification(Tier::Mid, 0.5));
        assert_eq!(sel.tier, Tier::Mid);
        assert_eq!(sel.primary_model, "claude-sonnet-4-6");
        assert_eq!(sel.fallback_models.len(), 2);
        assert_eq!(sel.fallback_models[0], "kimi-k2.5");
        assert_eq!(sel.fallback_models[1], "claude-haiku-4-5");
        assert!((sel.cost_cap_usd - 0.50).abs() < f64::EPSILON);
        assert_eq!(sel.latency_budget_ms, 30_000);
        assert!(sel.reason.contains("mid tier"));
    }

    #[test]
    fn route_high_returns_opus() {
        let sel = route(classification(Tier::High, 0.9));
        assert_eq!(sel.tier, Tier::High);
        assert_eq!(sel.primary_model, "claude-opus-4-6");
        assert_eq!(sel.fallback_models.len(), 2);
        assert_eq!(sel.fallback_models[0], "claude-sonnet-4-6");
        assert_eq!(sel.fallback_models[1], "kimi-k2.5");
        assert!((sel.cost_cap_usd - 2.00).abs() < f64::EPSILON);
        assert_eq!(sel.latency_budget_ms, 60_000);
        assert!(sel.reason.contains("high tier"));
    }

    #[test]
    fn route_with_cost_cap_override() {
        let sel = route_with_caps(classification(Tier::High, 0.9), Some(0.75), None);
        assert!((sel.cost_cap_usd - 0.75).abs() < f64::EPSILON);
        // Latency budget unchanged (no override).
        assert_eq!(sel.latency_budget_ms, 60_000);
    }

    #[test]
    fn route_with_latency_override() {
        let sel = route_with_caps(classification(Tier::Mid, 0.5), None, Some(5_000));
        assert_eq!(sel.latency_budget_ms, 5_000);
        // Cost cap unchanged.
        assert!((sel.cost_cap_usd - 0.50).abs() < f64::EPSILON);
    }

    #[test]
    fn downgrade_high_to_mid() {
        let original = route(classification(Tier::High, 0.9));
        let downgraded = downgrade_for_cost(original).expect("should downgrade");
        assert_eq!(downgraded.tier, Tier::Mid);
        assert_eq!(downgraded.primary_model, "claude-sonnet-4-6");
    }

    #[test]
    fn downgrade_mid_to_low() {
        let original = route(classification(Tier::Mid, 0.5));
        let downgraded = downgrade_for_cost(original).expect("should downgrade");
        assert_eq!(downgraded.tier, Tier::Low);
        assert_eq!(downgraded.primary_model, "claude-haiku-4-5");
    }

    #[test]
    fn downgrade_low_returns_none() {
        let original = route(classification(Tier::Low, 0.1));
        assert!(downgrade_for_cost(original).is_none());
    }
}
