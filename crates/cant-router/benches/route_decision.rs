//! Criterion benches for cant-router canonical 3-layer routing decision.
//!
//! Captures the perf-budget floor declared in the SG-BOUNDARY-REGISTRY
//! `boundary.ts` entry for cant-router (ADR-078, Saga T10176).
//!
//! Two benches are exposed:
//!
//! - `cant_router_simple_prompt` — short low-complexity prompt; exercises
//!   the Layer 1 feature extraction → Layer 2 classifier → Layer 3 router
//!   path that maps to the `Tier::Low` selection.
//! - `cant_router_complex_prompt` — refactor-style prompt with file
//!   references, brackets, and reasoning keywords; exercises the same
//!   pipeline but maps to the `Tier::High` selection. This is the
//!   representative hot path consumers (CleoOS dispatch) hit on every
//!   model-selection event.
//!
//! Each bench runs `extract_features → classify → route` so the measured
//! time captures the full classification + selection round trip.

#![allow(missing_docs)]

use cant_router::{classify, extract_features, route};
use criterion::{Criterion, black_box, criterion_group, criterion_main};

const SIMPLE_PROMPT: &str = "Format this JSON file.";

const COMPLEX_PROMPT: &str = "Refactor the auth module in src/auth.rs and src/session.rs to use \
JWT tokens. Consider the trade-offs between cookie-based sessions and \
token-based authentication, then explain why JWT is the better choice \
for our microservices architecture. Update tests in tests/auth/ and \
benchmarks in benches/auth_bench.rs.";

fn bench_route_simple(c: &mut Criterion) {
    c.bench_function("cant_router_simple_prompt", |b| {
        b.iter(|| {
            let features = extract_features(black_box(SIMPLE_PROMPT));
            let classification = classify(features);
            let selection = route(classification);
            black_box(selection);
        });
    });
}

fn bench_route_complex(c: &mut Criterion) {
    c.bench_function("cant_router_complex_prompt", |b| {
        b.iter(|| {
            let features = extract_features(black_box(COMPLEX_PROMPT));
            let classification = classify(features);
            let selection = route(classification);
            black_box(selection);
        });
    });
}

criterion_group!(benches, bench_route_simple, bench_route_complex);
criterion_main!(benches);
