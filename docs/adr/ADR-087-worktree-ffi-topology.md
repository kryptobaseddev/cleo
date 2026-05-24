---
slug: adr-087-worktree-ffi-topology
title: ADR-087 — Worktree FFI Topology (4-surface napi-rs canonical layout)
saga: T10431
date: 2026-05-24
status: accepted
stage: accepted
acceptedAt: 2026-05-24
acceptedBy: T10439
---

# ADR-087: Worktree FFI Topology

- **Status**: Accepted
- **Date**: 2026-05-24
- **Saga**: T10431 SG-WORKTRUNK-OWN
- **Implements**: T10439
- **References**: T10288, T10178

## Context

The `packages/worktree` package is the TypeScript SDK surface for git-worktree
operations. Under the hood it delegates CPU-bound primitives to a Rust core via
napi-rs. During the SG-WORKTRUNK-OWN saga (T9977 → T10431) the exact packaging
layout caused repeated confusion:

- `packages/worktree` — TS wrapper / orchestration layer (npm package `@cleocode/worktree`)
- `crates/worktree-napi` — napi-rs root binding crate (npm package `@cleocode/worktree-napi`)
- `crates/worktree-napi/npm/*` — 5 per-platform prebuild packages (`darwin-x64`, `darwin-arm64`, `linux-x64-gnu`, `win32-x64-msvc`, `linux-arm64-gnu`)
- `crates/worktrunk-core` — pure-Rust SDK (no npm package; consumed only by `worktree-napi`)

This is the **canonical 4-surface napi-rs layout** used by:

- `@swc/core`
- `oxc`
- `@napi-rs/canvas`
- `cant-napi` and `lafs-napi` (siblings in this monorepo)

The confusion was a **documentation gap**, not an architectural one. No code
changes are required; the layout is already correct.

## Decision

**Keep the current 4-surface layout.**

1. `worktrunk-core` stays a pure-Rust crate with no npm footprint.
2. `worktree-napi` is the **single** napi-rs binding crate; it re-exports
   `worktrunk-core` primitives via `#[napi]` macros.
3. Per-platform prebuilds live under `crates/worktree-napi/npm/*` and are
   published as scoped packages consumed by the root `@cleocode/worktree-napi`.
4. `packages/worktree` remains the TypeScript orchestration layer; it imports
   `@cleocode/worktree-napi` at runtime and adds CLEO-specific logic (XDG
   layout, task-id preservation filters, hook orchestration, etc.).

## Consequences

- **Positive**: The layout is industry-standard, well-supported by napi-rs
  tooling (`napi build`, `napi pre-publish`), and matches sibling packages in
  this repo.
- **Positive**: CI already builds and tests the full matrix; no pipeline changes
  needed.
- **Neutral**: New contributors may still need orientation. This ADR closes that
  gap by making the topology explicit and referenceable.
- **Negative**: None. The alternative (flattening into a single TS+Rust package)
  would break platform-specific binary distribution and require custom
  post-install scripts.

## References

- T10439 — Write ADR for Worktree FFI Topology, fix dangling slug refs
- T10288 — napi-rs prebuild package wiring
- T10178 — Initial worktree-napi scaffolding
- `crates/worktree-napi/README.md`
- `packages/worktree/README.md`
