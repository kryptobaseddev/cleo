//! Shared types for the `cant-router` crate.
//!
//! Defines the core data structures used across all three layers of
//! the model router: the tier matrix, prompt features, classification
//! results, final model selections, and routing observations.
//!
//! These types are `serde`-serializable so routing decisions can be
//! logged, replayed, or shipped across process boundaries (e.g., to the
//! future BRAIN-backed reranker in v2).

use serde::{Deserialize, Serialize};

/// Model tier — drives routing decisions (ULTRAPLAN §11, L3).
///
/// The tier matrix is intentionally a 3-level ladder: `Low`, `Mid`,
/// `High`. Classifier scores are mapped onto this ladder by
/// [`crate::classifier::classify`], and the router selects a primary
/// model and fallback chain per tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// Lowest tier — fastest, cheapest models. Short, simple prompts.
    Low,
    /// Middle tier — balanced cost/latency/capability. Default workhorse.
    Mid,
    /// Highest tier — most capable, most expensive models. Complex reasoning.
    High,
}

impl Tier {
    /// The next tier up for escalation (ULTRAPLAN §11, L4).
    ///
    /// Returns `None` if already at [`Tier::High`], which signals the
    /// caller that no further escalation is possible.
    #[must_use]
    pub fn escalate(self) -> Option<Tier> {
        match self {
            Tier::Low => Some(Tier::Mid),
            Tier::Mid => Some(Tier::High),
            Tier::High => None,
        }
    }

    /// Token budget cap for the system prompt per tier.
    ///
    /// Caps are drawn from ULTRAPLAN §9.4 and express the maximum
    /// number of tokens the system prompt slot may occupy for a given
    /// tier. Higher tiers get larger budgets because they serve
    /// higher-complexity work.
    #[must_use]
    pub fn system_prompt_cap(self) -> usize {
        match self {
            Tier::Low => 4000,
            Tier::Mid => 12000,
            Tier::High => 32000,
        }
    }

    /// Token budget cap for the mental-model slot per tier.
    ///
    /// The mental-model slot carries a compressed representation of the
    /// agent's persistent knowledge. `Low` tier agents get zero budget
    /// (no mental model), `Mid` gets 1000 tokens, and `High` gets 2000.
    #[must_use]
    pub fn mental_model_cap(self) -> usize {
        match self {
            Tier::Low => 0,
            Tier::Mid => 1000,
            Tier::High => 2000,
        }
    }

    /// Token budget cap for context sources per tier.
    ///
    /// Context sources include retrieved documents, memory snippets,
    /// and other dynamic context. Caps are drawn from ULTRAPLAN §9.4.
    #[must_use]
    pub fn context_sources_cap(self) -> usize {
        match self {
            Tier::Low => 0,
            Tier::Mid => 4000,
            Tier::High => 12000,
        }
    }
}

/// A feature vector extracted from a prompt or task description.
///
/// These features are the inputs to the linear classifier in
/// [`crate::classifier::classify`]. Each field corresponds to one of
/// the five heuristic signals defined in ULTRAPLAN §11.1.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptFeatures {
    /// Raw whitespace-delimited token count of the prompt.
    pub token_count: usize,
    /// Syntactic complexity in `[0.0, 1.0]` — proxied by nested bracket depth.
    pub syntactic_complexity: f64,
    /// Count of reasoning keywords (why / should / compare / decide / ...).
    pub reasoning_depth: usize,
    /// Domain-specificity in `[0.0, 1.0]` — proxied by CamelCase identifier density.
    pub domain_specificity: f64,
    /// Number of file references detected in the prompt.
    pub touches_files_count: usize,
}

/// A classification result — the tier recommended by the classifier.
///
/// Produced by [`crate::classifier::classify`] and consumed by
/// [`crate::router::route`] (and friends).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Classification {
    /// Scalar complexity score in `[0.0, 1.0]` produced by the weighted sum.
    pub score: f64,
    /// The tier chosen by threshold-mapping `score`.
    pub tier: Tier,
    /// The raw feature vector that produced this classification.
    pub features: PromptFeatures,
}

/// The final model selection from the router.
///
/// Describes what model the router would invoke, along with the
/// fallback chain, cost cap, latency budget, and a human-readable
/// reason. The actual model invocation is the bridge's job — this
/// crate only decides *what* to call, never *how*.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelSelection {
    /// The tier that produced this selection.
    pub tier: Tier,
    /// The primary model identifier (e.g., `"claude-opus-4-6"`).
    pub primary_model: String,
    /// Ordered fallback chain invoked on primary failure.
    pub fallback_models: Vec<String>,
    /// Hard cost cap for the request, in USD.
    pub cost_cap_usd: f64,
    /// Soft latency budget for the request, in milliseconds.
    pub latency_budget_ms: u64,
    /// Human-readable reason string describing why this selection was made.
    pub reason: String,
}

/// A routing observation logged to the pipeline for future reranker training.
///
/// Wave 6 writes observations to an in-memory [`crate::ObservationLog`].
/// Future waves will persist them to `brain.db:routing_observations` so
/// the v2 learned reranker can train on real traffic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingObservation {
    /// The feature vector that triggered the classification.
    pub features: PromptFeatures,
    /// The classification result.
    pub classification: Classification,
    /// The final model selection.
    pub selection: ModelSelection,
    /// RFC 3339 timestamp as a string (provided by the caller).
    pub timestamp: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_escalate_low_to_mid() {
        assert_eq!(Tier::Low.escalate(), Some(Tier::Mid));
    }

    #[test]
    fn tier_escalate_mid_to_high() {
        assert_eq!(Tier::Mid.escalate(), Some(Tier::High));
    }

    #[test]
    fn tier_escalate_high_returns_none() {
        assert_eq!(Tier::High.escalate(), None);
    }

    #[test]
    fn tier_caps_match_ultraplan_9_4() {
        // Exact values from ULTRAPLAN §9.4.
        assert_eq!(Tier::Low.system_prompt_cap(), 4000);
        assert_eq!(Tier::Mid.system_prompt_cap(), 12000);
        assert_eq!(Tier::High.system_prompt_cap(), 32000);

        assert_eq!(Tier::Low.mental_model_cap(), 0);
        assert_eq!(Tier::Mid.mental_model_cap(), 1000);
        assert_eq!(Tier::High.mental_model_cap(), 2000);

        assert_eq!(Tier::Low.context_sources_cap(), 0);
        assert_eq!(Tier::Mid.context_sources_cap(), 4000);
        assert_eq!(Tier::High.context_sources_cap(), 12000);
    }

    #[test]
    fn tier_serializes_lowercase() {
        #[allow(clippy::expect_used)]
        let json = serde_json::to_string(&Tier::High).expect("serialize");
        assert_eq!(json, "\"high\"");
    }
}
