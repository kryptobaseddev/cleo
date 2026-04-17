#![forbid(unsafe_code)]
//! `CleoOS` v2 model router — 3-layer classifier + router + pipeline.
//!
//! Implements ULTRAPLAN §11: classify a prompt by complexity, select a
//! model tier (low/mid/high), and route to the primary model with
//! fallback chain, cost caps, and latency budgets.
//!
//! # Architecture
//!
//! The router is a 3-layer pipeline:
//!
//! 1. **Layer 1 — Classifier** ([`classifier`]): a pure-function linear
//!    weighted scoring model over five prompt features. No training
//!    data required — this is the Wave 6 baseline.
//! 2. **Layer 2 — Router** ([`router`]): a rules engine that maps the
//!    classifier's tier decision onto a primary model, fallback chain,
//!    cost cap, and latency budget. The tier matrix is a Rust constant
//!    in v1.
//! 3. **Layer 3 — Pipeline** ([`pipeline`]): an observation logger that
//!    records routing decisions for the future v2 reranker.
//!
//! Wave 6 does not invoke models — it returns a [`ModelSelection`]
//! describing what *would* be called. Actual model invocation is the
//! bridge's job in Waves 2 and 5.
//!
//! # Example
//!
//! ```
//! use cant_router::{extract_features, classify, route};
//!
//! let prompt = "Refactor the auth module to use JWT tokens.";
//! let features = extract_features(prompt);
//! let classification = classify(features);
//! let selection = route(classification);
//! assert!(!selection.primary_model.is_empty());
//! ```

pub mod classifier;
pub mod features;
pub mod pipeline;
pub mod router;
pub mod types;

pub use classifier::classify;
pub use features::extract_features;
pub use pipeline::ObservationLog;
pub use router::{downgrade_for_cost, route, route_with_caps};
pub use types::{Classification, ModelSelection, PromptFeatures, RoutingObservation, Tier};
