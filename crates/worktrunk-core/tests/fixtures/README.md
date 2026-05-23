# Parity Test Fixtures (T10222 · SAGA T10176 · ADR-078)

This directory exists so the `[[test]] parity` target can pull in static
fixtures (canonical numstat strings, shortstat samples, etc.) without
hard-coding multi-line literals inside test modules.

The parity tests under `crates/worktrunk-core/tests/parity.rs` currently
build ephemeral git repositories at test time via the helpers in
`tests/common/mod.rs`. That approach is preferred over committing a
binary git fixture into the repo because:

1. Git ships sub-versioned packfiles. A committed fixture quickly drifts
   from the host git version under CI.
2. `tempfile::TempDir` cleanup is guaranteed even on panic. A committed
   fixture would need explicit copy-and-cleanup per test.
3. Hash determinism: SHA-256 truncation in `paths::compute_project_hash`
   is host-independent, so byte-for-byte path assertions still pass.

Files added here in future should be small, plain-text references (e.g.
recorded `git diff --shortstat` output captured against a frozen repo).
Anything that needs an actual git repo MUST be built at test time.
