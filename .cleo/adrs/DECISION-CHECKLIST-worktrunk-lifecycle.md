# Worktrunk Lifecycle Change Decision Checklist

**Status**: Active
**Date**: 2026-05-27
**Epic**: T10650
**Saga**: T9977 SG-WORKTRUNK-OWN
**References**: ADR-087-A (D087-A1 through D087-A7), T10821

---

When introducing, modifying, or removing a worktree lifecycle operation, answer all 9 questions. If the answer to any question 1-6 is NO, the change violates ADR-087-A and MUST be blocked in review.

## Checklist

### Q1 — Ownership (Rust SSoT)
Does the lifecycle logic live in `crates/worktrunk-core/` (Rust)?

- [ ] Yes — logic is in Rust `worktrunk-core`, the single source of truth
- [ ] No — **BLOCKED**. All git worktree, git branch, git log lifecycle operations MUST live in Rust `worktrunk-core`. TypeScript is a facade only (D087-A1, D087-A2).

### Q2 — NAPI Exposure
Is the new primitive exposed through `crates/worktree-napi/` with a proper napi-rs `#[napi]` binding?

- [ ] Yes — function has `#[napi]` attribute and is registered in `crates/worktree-napi/src/lib.rs`
- [ ] No — **BLOCKED**. Rust primitives must be surfaced through napi-rs (D087-A1).

### Q3 — TypeScript Bridge
Is the NAPI function re-exported in `packages/worktree/src/napi-binding.ts` with correct TypeScript types?

- [ ] Yes — `napi-binding.ts` has `export const { functionName } = nativeBinding` with typed wrapper
- [ ] No — **BLOCKED**. Consumers cannot reach NAPI without the bridge (D087-A2, D087-A3).

### Q4 — Facade Delegation
Does the caller delegate to `@cleocode/worktree` rather than using raw `execFileSync('git', [...])`, `execa('git', [...])`, or `spawnSync('git', [...])`?

- [ ] Yes — caller imports from `@cleocode/worktree`
- [ ] No — **BLOCKED**. All TypeScript consumers MUST route through `@cleocode/worktree` (D087-A2, D087-A3, D087-A7).

### Q5 — CLI Purity
Is `packages/cleo/src/` free of lifecycle logic — does it only parse args and dispatch?

- [ ] Yes — CLI handlers only parse/validate args and call core
- [ ] No — **BLOCKED**. CLI is a thin command-parsing layer (D087-A4).

### Q6 — Lint Gate
Does `scripts/lint-no-raw-git-worktree.mjs` cover the call site?

- [ ] Yes — lint rejects raw `git worktree`/`git branch`/lifecycle `git log` at this location
- [ ] No — **BLOCKED**. All TypeScript packages must be lint-guarded against lifecycle shell-outs (D087-A6).

### Q7 — Test Coverage
Do Rust tests cover lifecycle edge cases?

- [ ] Yes — tests cover: dirty worktree, orphan branch, merge conflict, lock fallback, force remove
- [ ] No — add tests before merging

### Q8 — Migration Completeness
If replacing a TypeScript shell-out, is the old code **deleted** (not bypassed, not commented out, not behind a feature flag)?

- [ ] Yes — old `gitSync`/`gitSilent` calls removed
- [ ] No — **BLOCKED**. False completions (T10022 precedent) occur when old code remains.

### Q9 — BRAIN Memory
Is the architectural decision recorded?

- [ ] Yes — `cleo memory observe "..." --title "..."` captures the decision
- [ ] No — record it before merge

---

## Review Gate

All 9 questions must be answered before merge. Questions 1-6 are hard gates — a NO blocks the PR. Questions 7-9 are soft gates — a NO requires a comment explaining the plan.

## Referenced By

- T10650 (P0: Restore Worktrunk Rust SSoT) — all child tasks T10651-T10666
- T10652 (Write ADR addendum) — this checklist is the T10821 deliverable
- T11064 (Audit branch-lock.ts) — uses Q4 and Q8 to verify migration completeness
- T11125 (NAPI test coverage) — uses Q7 to verify edge-case coverage
- `orchestrate-saga` skill — references this checklist for saga-level gate enforcement
