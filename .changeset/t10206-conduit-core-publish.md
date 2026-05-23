---
"@cleocode/cleo": patch
---

feat(T10206): conduit-core publish=true + criterion serde round-trip bench (SAGA T10176)

Flips `crates/conduit-core/Cargo.toml` to `publish = true` (forced by the
signaldock-protocol publishing chain per sg-boundary-crates-decision-matrix,
Decision D010, ADR-078). Adds the canonical perf-floor bench at
`crates/conduit-core/benches/envelope_serde.rs` — two criterion bench
functions exercising JSON serialize → deserialize on the `ConduitMessage`
envelope:

- `conduit_message_roundtrip_minimal` — all-`None` optional fields. p50 ≈ 196.6 ns.
- `conduit_message_roundtrip_full`    — full CANT metadata + tags + nested JSON. p50 ≈ 1.98 µs.

Per ADR-078 perf-budget contract, these floors will be declared in the
T10197 boundary registry entry for conduit-core.
