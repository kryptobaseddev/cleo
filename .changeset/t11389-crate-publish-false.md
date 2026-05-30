---
id: t11389-crate-publish-false
tasks: [T11389, T11390]
kind: chore
summary: Close the crates.io publish footgun — publish=false on 8 crates + Gate 12 zero-crates.io guard
---

E2 (T11389) crate-publish portion. Sets publish=false on the 8 footgun crates (cant-core/lsp/napi/router/runtime, cleo-conduit-core, lafs-core, lafs-napi) that defaulted to publishable — aligns with the owner zero-crates.io decision. Adds scripts/lint-no-crate-publish.mjs (Gate 12) asserting every crate declares publish=false (ALLOWLIST for deliberate future external crates, empty today). 7 unit tests. NOTE: T11389's supervisor-P2-manifest + cant/lafs cross-build parts remain (need release-pipeline/CI verification).
