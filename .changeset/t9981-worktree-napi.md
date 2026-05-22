---
"@cleocode/cleo": patch
---

feat(T9981): crates/worktree-napi — napi-rs binding for worktrunk-core

Adds the napi-rs binding crate exposing 6 functions to JavaScript:
provisionWorktree, destroyWorktree, copyPathsParallel, readWorktreeInclude,
applyInclude, listWorktrees. Cross-platform prebuilt CI matrix (Linux x64/arm64,
macOS x64/arm64, Windows x64). npm optionalDependencies pattern with 5 per-arch
wrapper packages. First multi-triple prebuild workflow in the repo.

Unblocks E5 (TS-WORKTREE-REWIRE / T9982) consuming the napi surface.

Saga: T9977
Decision: D010
Closes: T10008, T10009, T10010, T10011, T10012, T10013, T10014, T10015, T10016, T10017
