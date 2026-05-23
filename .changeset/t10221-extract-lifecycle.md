---
"@cleocode/cleo": patch
---

feat(T10221): extract lifecycle SDK primitives into worktrunk-core (SAGA T10176, T10218)

Pure-function refactor of cache + remove_dir + sync + diff per ADR-078 SoC contract.
Builds on T10219's `Repo` trait + `ProcessRepo` substitute. Four new top-level
modules under `crates/worktrunk-core/src/`:

- `cache.rs` — on-disk JSON cache primitives (read/write/sweep/clear). Donor
  dependency on `Repository::wt_dir()` replaced with explicit `&Path` argument
  at the SDK boundary. Logging dependency (`log` crate) dropped — the SDK no
  longer has an opinion on diagnostic frameworks.
- `remove_dir.rs` — recursive parallel directory removal with optional
  progress reporting. Uses the existing SDK `Progress` type. `LazyLock` pool
  initializer now degrades gracefully (4-thread → 1-thread → panic) matching
  the `copy.rs` policy.
- `sync.rs` — counting semaphore (`Semaphore` + `SemaphoreGuard`). Pure
  std-only; `Mutex` poison recovery via `PoisonError::into_inner` so SDK
  consumers do not panic on contention races.
- `diff.rs` — pure git-diff parsers (`LineDiff`, `DiffStats`,
  `parse_numstat_line`, `parse_shortstat`). The donor's `cformat!`-styled
  `format_summary` was intentionally dropped — CLI consumers compose color
  themselves from the raw struct fields. Inline ANSI-strip implemented
  locally so the `ansi_str` crate stays out of the SDK dep graph.

Opportunistic Repo trait promotion: `Repo::diff_stats_summary` flipped from
`unimplemented_in_sdk` to a real `ProcessRepo` impl. Integration test
demonstrates the pipe `Repo::diff_stats_summary` → `DiffStats::from_shortstat`
end-to-end.

CLI-binary-only modules documented: a `# CLI-binary-only modules` section
in `lib.rs` now explains why `worktrunk::priority` and
`worktrunk::signal_forwarder` are intentionally NOT vendored — both are
process-lifecycle side effects that mutate the host's signal disposition /
OS scheduling priority and would silently break napi consumers if invoked
from a library.

Test count: 104 unit + 6 integration + 2 doctest = 112 passing
(was 69 in T10219; +35 new tests for the four lifecycle modules + the
`diff_stats_summary` promotion).

Cargo:
- `cargo build -p worktrunk-core --all-features` — green
- `cargo test -p worktrunk-core --all-features` — 112 / 112 pass
- `cargo clippy -p worktrunk-core --all-features --no-deps -- -D warnings` — zero
- `pnpm biome check --write .` — zero new findings
