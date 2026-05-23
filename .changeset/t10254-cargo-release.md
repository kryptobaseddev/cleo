---
id: t10254-cargo-release
tasks: [T10254]
kind: feat
summary: "T10254 (saga T10180 W4 prep): adopt cargo-release for atomic Rust workspace"
---

T10254 (saga T10180 W4 prep): adopt cargo-release for atomic Rust workspace
publishes. Adds `release.toml` with `shared-version = true` and
pre-release-replacements regex that auto-bumps in-workspace
`[workspace.dependencies]` version pins on every `cargo release version`.
Replaces the rejected PR #548 approach of hand-edited per-pin version
bumps.

Also normalises [workspace.dependencies] pins for the 3 publishable
crates (lafs-core, cleo-conduit-core, cant-core) to `= 2026.5.105`,
and switches cleo-conduit-core's stale `lafs-core` pin (`2026.5.99`)
to workspace inheritance (`{ workspace = true }`).

Future release flow:
  cargo release version <calver> --workspace --execute
  cargo publish -p <crate>  # explicit per-crate (workspace mode hits rate limit)

Initial crates.io publish (this saga) executes immediately after merge.
