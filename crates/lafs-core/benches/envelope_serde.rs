//! Criterion benches for lafs-core canonical envelope serde round-trip.
//!
//! Captures the perf-budget floor declared in the SG-BOUNDARY-REGISTRY
//! `boundary.ts` entry for lafs-core (ADR-078, Saga T10176).
//!
//! Two benches are exposed:
//!
//! - `lafs_envelope_success_roundtrip` — canonical success envelope with
//!   a small structured result payload. Establishes the absolute serde
//!   floor for CLI response envelopes.
//! - `lafs_envelope_error_roundtrip` — canonical error envelope with a
//!   structured [`LafsError`] including category, retryability, agent
//!   action, and a nested `details` payload. Mirrors the on-wire shape
//!   consumers (cleo CLI dispatch, agent SDKs) actually receive on the
//!   error path.
//!
//! Each bench runs JSON serialize → JSON deserialize so the measured
//! time captures both directions of the round-trip on the canonical
//! hot-path consumed by every CLEO operation envelope.

#![allow(missing_docs)]

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use lafs_core::{
    LafsAgentAction, LafsEnvelope, LafsError, LafsErrorCategory, LafsMeta, LafsTransport,
};

fn make_success_envelope() -> LafsEnvelope {
    let meta = LafsMeta::new("tasks.list", LafsTransport::Cli);
    let result = serde_json::json!({
        "tasks": [
            { "id": "T10224", "title": "Publish flips", "status": "in_progress" },
            { "id": "T10206", "title": "conduit-core flip", "status": "done" },
            { "id": "T10194", "title": "E3 epic", "status": "in_progress" },
        ],
        "totalCount": 3,
    });
    LafsEnvelope::success(result, meta)
}

fn make_error_envelope() -> LafsEnvelope {
    let meta = LafsMeta::new("tasks.complete", LafsTransport::Cli);
    let error = LafsError {
        code: "E_EVIDENCE_MISSING".to_string(),
        message: "Gate testsPassed requires evidence atom".to_string(),
        category: LafsErrorCategory::Validation,
        retryable: false,
        retry_after_ms: None,
        details: serde_json::json!({
            "gate": "testsPassed",
            "taskId": "T10224",
            "requiredAtoms": ["tool:test", "test-run:<json>", "pr:<num>"],
        }),
        agent_action: Some(LafsAgentAction::RetryModified),
        escalation_required: Some(false),
        suggested_action: Some(
            "Run `cleo verify T10224 --gate testsPassed --evidence \"tool:test\"`".to_string(),
        ),
        doc_url: Some(
            "https://lafs.dev/errors/E_EVIDENCE_MISSING".to_string(),
        ),
    };
    LafsEnvelope::error(error, meta)
}

fn bench_success_roundtrip(c: &mut Criterion) {
    let envelope = make_success_envelope();
    c.bench_function("lafs_envelope_success_roundtrip", |b| {
        b.iter(|| {
            let serialized = serde_json::to_string(black_box(&envelope))
                .expect("serialize success envelope");
            let deserialized: LafsEnvelope = serde_json::from_str(black_box(&serialized))
                .expect("deserialize success envelope");
            black_box(deserialized);
        });
    });
}

fn bench_error_roundtrip(c: &mut Criterion) {
    let envelope = make_error_envelope();
    c.bench_function("lafs_envelope_error_roundtrip", |b| {
        b.iter(|| {
            let serialized = serde_json::to_string(black_box(&envelope))
                .expect("serialize error envelope");
            let deserialized: LafsEnvelope = serde_json::from_str(black_box(&serialized))
                .expect("deserialize error envelope");
            black_box(deserialized);
        });
    });
}

criterion_group!(benches, bench_success_roundtrip, bench_error_roundtrip);
criterion_main!(benches);
