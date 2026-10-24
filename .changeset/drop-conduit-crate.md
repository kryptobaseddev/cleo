---
id: drop-conduit-crate
tasks: [T13954]
kind: chore
summary: "remove the unused cleo-conduit-core Rust crate"
---
`crates/cleo-conduit-core` had one consumer, `crates/integration-tests`, and no
CI job built it. Its tests that exercised `ConduitMessage` are removed with it;
the cant-core and lafs-core integration tests stay. The workspace members,
`[workspace.dependencies]`, `Cargo.lock`, `release.toml` and the boundary
registry entry are updated. The external signaldock repository pins the
crates.io release `=2026.5.105`, which this does not touch (SignalDock is
being decommissioned, D11178).
