---
"@cleocode/cleo": patch
---

feat(T10224): publish=true + criterion benches for cant-{core,router,runtime} + lafs-core (SAGA T10176)

Completes the cleocode publish chain unblocked by T10206 (conduit-core flip).
Each crate now has a criterion bench per ADR-078 perf-budget contract.
Signaldock crates remain publish=false (handled by parallel saga T10180).

Flips (4 crates):
- cant-core: publish=true + license + repository + keywords + categories.
- cant-router: publish=true + license + repository + keywords + categories.
- cant-runtime: publish=true + license + repository + keywords + categories.
- lafs-core: publish=true + license + repository + keywords + categories.

Benches (one per crate, criterion harness):
- cant-core/benches/parse_message.rs — minimal + full CANT parse round-trip
  (p50: 98 ns minimal, 2.78 µs full).
- cant-router/benches/route_decision.rs — simple + complex prompt classify+route
  (p50: 697 ns simple, 2.68 µs complex).
- cant-runtime/benches/env_resolve.rs — simple + full pipeline-args variable
  resolve (p50: 143 ns simple, 1.09 µs full). T07 single-pass invariant
  hot-path.
- lafs-core/benches/envelope_serde.rs — success + error envelope JSON
  round-trip (p50: 2.53 µs success, 2.74 µs error).

Publish-chain unblockers (the real T10206 follow-on):
- lafs-core: vendor `packages/lafs/schemas/v1/envelope.schema.json` into
  `crates/lafs-core/schemas/v1/` so `include_str!` is crate-relative.
  `cargo publish` rejects paths that traverse outside the crate dir.
- cant-core: vendor `packages/caamp/providers/hook-mappings.json` into
  `crates/cant-core/vendor/caamp/` and update `build.rs` to prefer the
  workspace canonical when present, fall back to the vendored copy in
  publish-tarball mode.
- conduit-core: also add `version` to its `lafs-core` path dep (was the
  missing piece from T10206 that blocked the chain).

Parity CI gates (TS canonical stays authoritative):
- `scripts/lint-lafs-schema-parity.mjs` — byte-identity check.
- `scripts/lint-cant-core-hook-mappings-parity.mjs` — byte-identity check.
- New CI job `Rust Vendor Parity Lint (T10224)` wires both into `.github/workflows/ci.yml`.

Verification:
- `cargo build --workspace --all-features` — green.
- `cargo bench --no-run` for all 4 new benches — green.
- `cargo package -p lafs-core -p conduit-core -p cant-core -p cant-router -p cant-runtime --allow-dirty` —
  green (full workspace-aware publish-chain dry-run, including the
  conduit-core gate from AC8).
- `cargo test -p lafs-core` — 37 unit + 2 doctests green (vendored schema
  validates the same as canonical).
- 5 `starter_bundle_*` test failures in `crates/cant-core/tests/parse_new_sections.rs`
  are PRE-EXISTING on origin/main (`packages/agents/starter-bundle/` doesn't
  exist on main); not caused by this PR. Filed as follow-up.
