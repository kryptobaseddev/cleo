---
id: t10204-rewire-prune-napi
tasks: [T10204]
kind: feat
summary: "packages/worktree/src/worktree-prune.ts now a thin napi wrapper (SAGA T10176)"
---

feat(T10204): packages/worktree/src/worktree-prune.ts now a thin napi wrapper (SAGA T10176)

Delegates the prune algorithm to worktrunk_core::step::prune via @cleocode/worktree-napi
(T10203). Shrinks executable LOC from ~120 to ~106 (orchestrator entry point: 18 LOC) with
clean SOLID decomposition into private helpers. Audit-log writes and sentinel-index
updates stay in TS per ADR-061 (TS owns the side-effects that aren't in the SDK boundary).
Closes E3 epic T10194.
