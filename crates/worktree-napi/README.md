# `worktree-napi` — napi-rs Bindings for worktrunk-core

**Crate**: `worktree-napi` (internal-only — `publish = false`)
**Depends on**: [`worktrunk-core`](../worktrunk-core/)
**Saga**: T10176 SG-BOUNDARY-REGISTRY
**Epic**: T10907 (Worktrunk ownership formalization)
**Stewardship**: CleoCode (`@kryptobaseddev`) — sole steward

## Purpose

`worktree-napi` is the napi-rs binding layer that exposes the pure-Rust
`worktrunk-core` SDK to JavaScript and TypeScript consumers. It is the
canonical path for Node.js code (including `packages/worktree/`) to invoke
worktrunk primitives without shelling out to `git worktree` directly.

This crate is the foundation for E5 (`TS-WORKTREE-REWIRE`, T9982) and is
the sole steward of the Node.js-facing worktree-provisioning contract.

## Stewardship

**CleoCode (`@kryptobaseddev`) is the sole steward** of this crate.
All changes to the crate surface — napi exports, safety contracts,
error-handling conventions, and build configuration — require review
by the CleoCode maintainer.

## Exported functions

- `provision_worktree` — `git worktree add` with optional lock
- `destroy_worktree` — `git worktree remove [--force]`
- `copy_paths_parallel` — reflink-aware parallel copy of explicit leaves
- `read_worktree_include` — parse `<repo_root>/.worktreeinclude`
- `apply_include` — read + filter + copy in one call
- `list_worktrees` — parsed `git worktree list --porcelain` output
- `prune_worktrees` — build a `PrunePlan`
- `promote_branch` — build a `PromotePlan`
- `relocate_worktree` — build a `RelocatePlan`
- `copy_ignored` — plan + execute the `[copy-ignored]` step
- `remove_dir` — recursive parallel directory removal with counts
- `sync_worktree` — seed a freshly-provisioned worktree from a source tree
- `run_step` — generic dispatcher routing `StepKind` envelopes to primitives

## Architecture

```
┌─────────────────────────┐
│ packages/worktree/       │  TypeScript consumer
│ (cleo orchestrate spawn) │
└───────────┬─────────────┘
            │ require('@cleocode/worktree-napi')
            ▼
┌─────────────────────────┐
│ crates/worktree-napi/    │  napi-rs binding shim (THIS CRATE)
│ (index.cjs / index.d.ts) │  Error funneling: anyhow → napi::Error
└───────────┬─────────────┘
            │ worktrunk-core = { path = "../worktrunk-core" }
            ▼
┌─────────────────────────┐
│ crates/worktrunk-core/   │  Pure-Rust SDK
│ (Repo trait, ProcessRepo,│  reflink copy, worktreeinclude,
│  git_wt, steps, cache)   │  paths, diff, progress, semaphore)
└─────────────────────────┘
```

## Build

```bash
cd crates/worktree-napi
cargo build --release
```

The `build.rs` script invokes `napi-build` to configure the N-API build.
Prebuilt binaries are distributed via the `@cleocode/worktree-napi` npm
package (see CI workflow `worktree-napi-prebuild.yml` for cross-platform
compilation targets).

## Safety contract

All errors from `worktrunk-core` (which use `anyhow::Result`) are funneled
through `napi_err()` which wraps `to_string()` of the underlying error chain
into a `napi::Error`. JS-side callers always receive a readable
`Error.message`.

The `#![allow(unsafe_code)]` lint is present because napi-rs FFI macros
generate unsafe blocks internally — this is inherent to the binding layer
and not a crate-level safety concern.

## See also

- [`worktrunk-core`](../worktrunk-core/) — the pure-Rust SDK that this crate wraps
- [ADR-078 — Boundary Registry as SSoT](../../docs/adr/adr-078-boundary-registry.md)
- Saga T10176 SG-BOUNDARY-REGISTRY
- Epic T10907 (Worktrunk ownership formalization)
- `packages/worktree/` — TypeScript consumer of this binding
- `CODEOWNERS` — formal ownership declaration (root of this repo)
