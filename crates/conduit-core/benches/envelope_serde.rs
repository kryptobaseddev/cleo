//! Criterion benches for conduit-core canonical envelope serde round-trip.
//!
//! Captures the perf-budget floor declared in the SG-BOUNDARY-REGISTRY
//! `boundary.ts` entry for conduit-core (ADR-078, Saga T10176).
//!
//! Two benches are exposed:
//!
//! - `conduit_message_roundtrip_minimal` — minimal envelope (no optional
//!   fields, no metadata). Establishes the absolute serde floor.
//! - `conduit_message_roundtrip_full` — representative envelope with
//!   CANT metadata, tags, threadId/groupId, and a small nested JSON
//!   metadata payload. Mirrors the on-wire shape for real CLEO
//!   agent-to-agent messages.
//!
//! Each bench runs JSON serialize → JSON deserialize so the measured
//! time captures both directions of the round-trip on the canonical
//! hot-path consumers (signaldock-protocol, signaldock-backend).

#![allow(missing_docs)]

use conduit_core::{CantMetadata, CantOperation, ConduitMessage};
use criterion::{Criterion, black_box, criterion_group, criterion_main};

/// Minimal canonical envelope — all optional fields `None`.
fn make_minimal_message() -> ConduitMessage {
    ConduitMessage {
        id: "msg-001".to_string(),
        from: "agent-a".to_string(),
        content: "Hello from agent A".to_string(),
        tags: None,
        thread_id: None,
        group_id: None,
        timestamp: "2026-05-22T12:00:00Z".to_string(),
        metadata: None,
    }
}

/// Representative full envelope — CANT metadata + tags + threading + nested JSON.
/// Mirrors the on-wire shape signaldock-protocol consumers serialize.
fn make_full_message() -> ConduitMessage {
    let cant = CantMetadata {
        directive: Some("please review T5678".to_string()),
        directive_type: "actionable".to_string(),
        addresses: vec!["@cleo-core".to_string(), "@cleo-prime".to_string()],
        task_refs: vec!["T5678".to_string(), "T10206".to_string()],
        tags: vec!["#review".to_string(), "#urgent".to_string()],
        operation: Some(CantOperation {
            gateway: "query".to_string(),
            domain: "tasks".to_string(),
            operation: "show".to_string(),
            params: Some(serde_json::json!({"id": "T5678", "verbose": true})),
        }),
    };
    ConduitMessage {
        id: "msg-bench-full".to_string(),
        from: "agent-bench".to_string(),
        content: "Representative payload for SG-BOUNDARY-REGISTRY perf-floor bench".to_string(),
        tags: Some(vec!["#status".to_string(), "#decision".to_string()]),
        thread_id: Some("thread-bench-001".to_string()),
        group_id: Some("group-bench-001".to_string()),
        timestamp: "2026-05-22T12:00:00Z".to_string(),
        metadata: None,
    }
    .with_cant_metadata(cant)
}

fn bench_minimal_roundtrip(c: &mut Criterion) {
    let msg = make_minimal_message();
    c.bench_function("conduit_message_roundtrip_minimal", |b| {
        b.iter(|| {
            let serialized =
                serde_json::to_string(black_box(&msg)).expect("serialize minimal envelope");
            let deserialized: ConduitMessage =
                serde_json::from_str(black_box(&serialized)).expect("deserialize minimal envelope");
            black_box(deserialized);
        });
    });
}

fn bench_full_roundtrip(c: &mut Criterion) {
    let msg = make_full_message();
    c.bench_function("conduit_message_roundtrip_full", |b| {
        b.iter(|| {
            let serialized =
                serde_json::to_string(black_box(&msg)).expect("serialize full envelope");
            let deserialized: ConduitMessage =
                serde_json::from_str(black_box(&serialized)).expect("deserialize full envelope");
            black_box(deserialized);
        });
    });
}

criterion_group!(benches, bench_minimal_roundtrip, bench_full_roundtrip);
criterion_main!(benches);
