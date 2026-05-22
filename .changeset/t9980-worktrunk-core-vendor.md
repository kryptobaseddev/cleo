---
"@cleocode/cleo": patch
---

feat(T9980): vendor worktrunk as crates/worktrunk-core (own outright)

Vendors ~1340 LOC of parallel-copy + path-canonicalization + .worktreeinclude
parsing into a new internal crate. Zero attribution to original author —
all files carry CleoCode SPDX headers. Pure Rust SDK; no CLI deps, no napi
exports (napi binding lands in T9981 / E4).

This is the foundation for fixing the 60s `cleo orchestrate spawn` timeout
on the cleocode monorepo (1.9 GB / 69k-file sequential cp() bottleneck).

Saga: T9977
Decision: D010
Closes: T9999, T10000, T10001, T10002, T10003, T10004, T10005, T10006, T10007
