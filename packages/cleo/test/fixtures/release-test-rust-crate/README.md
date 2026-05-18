# release-test-rust-crate

Single Rust crate archetype for release-pipeline tests.

A minimal cargo workspace-of-one used by T9543/T9544 to exercise the
`single-rust-crate` archetype path defined in SPEC-T9345 §9.1.

This fixture is **not** runnable on its own — no `Cargo.lock`, no
target/. It exists purely so tests can read its `.cleo/*.json` config +
`Cargo.toml` layout and assert correct archetype resolution.
