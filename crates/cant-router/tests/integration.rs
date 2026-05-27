//! End-to-end integration tests for the `cant-router` crate.
//!
//! These tests exercise the full extract → classify → route → log
//! pipeline to verify the three layers compose correctly.

use cant_router::{
    ObservationLog, Tier, classify, downgrade_for_cost, extract_features, route,
    types::RoutingObservation,
};

#[test]
fn end_to_end_low_tier_prompt() {
    // Short, simple prompt with no reasoning keywords, no files, no brackets.
    let prompt = "print hello world";
    let features = extract_features(prompt);
    let classification = classify(features);
    let selection = route(classification.clone());

    assert_eq!(classification.tier, Tier::Low);
    assert_eq!(selection.tier, Tier::Low);
    assert_eq!(selection.primary_model, "claude-haiku-4-5");
    assert!(selection.cost_cap_usd < 0.25);
    assert!(selection.latency_budget_ms <= 10_000);
}

#[test]
fn end_to_end_high_tier_prompt() {
    // Long, high-reasoning, many files, CamelCase-dense, deep brackets.
    let base = "Analyze and evaluate the trade-off between ModelSelection \
                RoutingObservation and ObservationLog across \
                src/router.rs src/classifier.rs src/pipeline.rs docs/plan.md. \
                Compare why we should decide whether to ((((refactor)))) the \
                PipelineLogger. ";
    // Pad to get a high token_count feature (~1000+ tokens).
    let prompt = base.repeat(20);

    let features = extract_features(&prompt);
    let classification = classify(features);
    let selection = route(classification.clone());

    assert_eq!(classification.tier, Tier::High);
    assert_eq!(selection.tier, Tier::High);
    assert_eq!(selection.primary_model, "claude-opus-4-6");
    assert_eq!(selection.fallback_models.len(), 2);
    assert!(selection.reason.contains("high tier"));
}

#[test]
fn pipeline_logs_observation() {
    let prompt = "Refactor the auth.rs module";
    let features = extract_features(prompt);
    let classification = classify(features.clone());
    let selection = route(classification.clone());

    let log = ObservationLog::new();
    assert!(log.is_empty());

    let obs = RoutingObservation {
        features,
        classification,
        selection,
        timestamp: "2026-04-07T12:00:00Z".to_string(),
    };
    log.record(obs);

    assert_eq!(log.len(), 1);
    let snap = log.snapshot();
    assert_eq!(snap.len(), 1);
    assert_eq!(snap[0].timestamp, "2026-04-07T12:00:00Z");
}

#[test]
fn end_to_end_downgrade_chain_on_cost_cap() {
    // Force a high-tier selection, then walk the downgrade ladder all
    // the way down to None.
    let prompt = "Analyze and evaluate why we should decide \
                  how to compare ModelSelection RoutingObservation \
                  src/router.rs (((nested))) trade-off";
    let features = extract_features(prompt);
    let classification = classify(features);
    // The classifier may not score this as High depending on heuristics,
    // so construct a manual High classification to test the full ladder.
    let high = cant_router::Classification {
        score: 0.9,
        tier: Tier::High,
        features: classification.features.clone(),
    };
    let s_high = route(high);
    assert_eq!(s_high.tier, Tier::High);

    #[allow(clippy::expect_used)]
    let s_mid = downgrade_for_cost(s_high).expect("high → mid");
    assert_eq!(s_mid.tier, Tier::Mid);
    assert_eq!(s_mid.primary_model, "claude-sonnet-4-6");

    #[allow(clippy::expect_used)]
    let s_low = downgrade_for_cost(s_mid).expect("mid → low");
    assert_eq!(s_low.tier, Tier::Low);
    assert_eq!(s_low.primary_model, "claude-haiku-4-5");

    let s_none = downgrade_for_cost(s_low);
    assert!(s_none.is_none());
}
