//! Criterion benches for cant-core canonical CANT message parsing.
//!
//! Captures the perf-budget floor declared in the SG-BOUNDARY-REGISTRY
//! `boundary.ts` entry for cant-core (ADR-078, Saga T10176).
//!
//! Two benches are exposed:
//!
//! - `cant_parse_minimal` — bare directive-only header. Establishes the
//!   absolute parse floor for short agent-to-agent ack messages.
//! - `cant_parse_full` — representative real-world CANT message with a
//!   directive, multiple addresses, task refs, tags, plus a multi-line
//!   body that itself contains task references and addresses. Mirrors
//!   the on-wire shape conduit-core / signaldock-protocol consumers
//!   actually receive.
//!
//! Each bench calls [`cant_core::parse`] end-to-end so the measured time
//! captures header/body split, header element extraction, body scanning,
//! and directive classification — the full canonical hot path.

#![allow(missing_docs)]

use cant_core::parse;
use criterion::{Criterion, black_box, criterion_group, criterion_main};

const MINIMAL_MESSAGE: &str = "/ack";

const FULL_MESSAGE: &str = "/done @cleo-prime @signaldock-core T10224 T10206 #shipped #boundary-registry\n\
\n\
## SG-BOUNDARY-REGISTRY Wave E3 complete\n\
\n\
@versionguard please verify v2026.5.99 against the publish chain.\n\
T10194 and T10206 land together — see #ADR-078 for the perf-budget contract.\n\
Follow-up: T10180 owns signaldock-* publish flips. #follow-up";

fn bench_parse_minimal(c: &mut Criterion) {
    c.bench_function("cant_parse_minimal", |b| {
        b.iter(|| {
            let parsed = parse(black_box(MINIMAL_MESSAGE));
            black_box(parsed);
        });
    });
}

fn bench_parse_full(c: &mut Criterion) {
    c.bench_function("cant_parse_full", |b| {
        b.iter(|| {
            let parsed = parse(black_box(FULL_MESSAGE));
            black_box(parsed);
        });
    });
}

criterion_group!(benches, bench_parse_minimal, bench_parse_full);
criterion_main!(benches);
