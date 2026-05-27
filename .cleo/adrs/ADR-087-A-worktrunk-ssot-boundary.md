# ADR-087-A — Worktrunk SSoT Boundary Contract

**Status**: Accepted (updated 2026-05-27 for branch-lock validation)
**Date**: 2026-05-26
**Updated**: 2026-05-27 — added D087-A7 (branch-lock.ts coverage) per T10652
**Epic**: T10650
**Saga**: T9977 SG-WORKTRUNK-OWN
**Amends**: ADR-087 Worktree FFI Topology
**References**: T10022, T9984, T10203, T11064, D010, D029, D030

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
RFC 2119.

---

## Context

ADR-087 established the canonical 4-surface napi-rs layout:

1. `worktrunk-core` — pure-Rust SDK (no npm footprint)
2. `worktree-napi` — napi-rs binding crate
3. Per-platform prebuilds under `crates/worktree-napi/npm/*`
4. `packages/worktree` — TypeScript orchestration layer

However, ADR-087 did not explicitly define the **lifecycle ownership boundary** between Rust and TypeScript. This ambiguity allowed architecture drift to occur: the TypeScript `packages/worktree` package continued to perform raw `git worktree`, `git branch`, and `git log` shell-outs for lifecycle operations, despite the Rust `worktrunk-core` crate already exposing equivalent primitives.

### Evidence of Drift — packages/worktree/src/

The following shell-outs remain in `packages/worktree/src/` as of the filing of T10650:

| File | Line | Shell-out | What It Does |
|------|------|-----------|--------------|
| `worktree-create.ts` | 202 | `gitSync(['status', '--porcelain'], ...)` | Dirty detection before stale removal |
| `worktree-create.ts` | 208 | `gitSilent(['worktree', 'unlock', ...], ...)` | Unlock stale worktree |
| `worktree-create.ts` | 209 | `gitSilent(['worktree', 'remove', '--force', ...], ...)` | Remove stale worktree |
| `worktree-create.ts` | 215 | `gitSilent(['branch', '-D', ...], ...)` | Delete stale branch |
| `worktree-create.ts` | 226 | `gitSync(['branch', '--list', ...], ...)` | Check branch exists |
| `worktree-create.ts` | 235 | `gitSync(['log', '--format=%H', ...], ...)` | Orphan commit detection |
| `worktree-create.ts` | 245 | `gitSilent(['branch', '-D', ...], ...)` | Force reset branch |
| `worktree-create.ts` | 247 | `gitSync(['worktree', 'add', '-b', ...], ...)` | **CREATE worktree** |
| `worktree-create.ts` | 263 | `gitSync(['worktree', 'add', ...], ...)` | Reuse existing branch |
| `worktree-create.ts` | 277-281 | `gitSilent(['worktree', 'lock', ...], ...)` | Lock worktree |
| `worktree-destroy.ts` | 64 | `gitSync(['status', '--porcelain'], ...)` | Dirty detection |
| `worktree-destroy.ts` | 108 | `gitSilent(['worktree', 'unlock', ...], ...)` | Unlock before remove |
| `worktree-destroy.ts` | 135 | `gitSync(['branch', '--list', ...], ...)` | Check branch exist |
| `worktree-destroy.ts` | 137 | `gitSync(['branch', '-D', ...], ...)` | Delete branch |
| `worktree-prune.ts` | 98 | `gitSilent(['worktree', 'prune'], ...)` | Admin cleanup |
| `worktree-prune.ts` | 175 | `gitSilent(['worktree', 'unlock', ...], ...)` | Unlock stale |
| `worktree-prune.ts` | 176 | `gitSilent(['worktree', 'remove', '--force', ...], ...)` | Remove stale |

### Evidence of Drift — packages/core/src/spawn/branch-lock.ts

T11064 audit discovered branch-lock.ts (`packages/core/src/spawn/branch-lock.ts`) as a **parallel lifecycle owner** not covered by the original ADR-087-A. This file implements the L1 worktree lifecycle layer for agent spawn (T1118) and performs raw git execFileSync operations for:

| Function | Lines | Operations |
|----------|-------|------------|
| `createAgentWorktree` | 147-193 | `git worktree add -b`, `git worktree lock`, `git worktree unlock`, `git worktree remove --force`, `git branch -D`, `git rev-parse` |
| `pruneOrphanedWorktrees` | 257-297 | `git worktree prune`, `git worktree unlock`, `git worktree remove --force` |
| `pruneWorktree` | 348-474 | `git worktree unlock`, `git worktree remove --force`, `git worktree prune`, `git status --porcelain`, `git branch --list`, `git branch -D`, `git log --format=%H`, `git rev-parse` |
| `completeAgentWorktreeViaMerge` | 569-778 | `git branch --list`, `git fetch origin`, `git rev-parse`, `git rebase`, `git checkout`, `git merge --no-ff`, `git log --format=%H` |
| `getDefaultBranch` | 500-522 | `git symbolic-ref`, `git branch --list` |
| `getGitRoot` | 126-132 | `git rev-parse --show-toplevel` |

All of these use raw `execFileSync('git', [...], ...)` via the `gitSync`/`gitSilent` helpers — no NAPI routing, no `@cleocode/worktree` delegation. This creates a second lifecycle owner that duplicates the same git operations that `packages/worktree/src/` performs and that Rust `worktrunk-core` already exposes.

Meanwhile, Rust `worktrunk-core` already exposes:

- `provision_worktree` — `git worktree add -b <branch>`
- `destroy_worktree` — `git worktree remove [--force]`
- `list_worktrees` — parsed `git worktree list --porcelain`
- `lock_worktree` / `unlock_worktree` — `git worktree lock` / `unlock`
- `get_default_branch` — remote+local default-branch resolution
- `branch_exists` — `git branch --list` equivalent
- `rev_parse` — `git rev-parse` equivalent

And `worktree-napi` exposes 13 napi-bound functions, of which only 7 are re-exported in the TypeScript `napi-binding.ts`. **Critically missing from the TS bridge**: `provisionWorktree`, `promoteBranch`, `relocateWorktree`, `copyIgnored`, `syncWorktree`, `runStep`.

### T10022 False Completion

Task T10022 ("worktree-create.ts: REMOVE hardcoded [...] block — route through napi.provisionWorktree") is marked `done` but the code does not reflect this intent. `worktree-create.ts` still calls `gitSync(['worktree', 'add', ...])` directly, and `napi-binding.ts` does not expose `provisionWorktree`.

## Decision

### D087-A1 — Rust worktrunk-core is the SOLE owner of git worktree lifecycle

The Rust `worktrunk-core` crate MUST be the single source of truth for ALL git worktree lifecycle operations. This includes:

- **Provisioning** — `git worktree add` (new branch and reuse)
- **Destruction** — `git worktree remove`
- **Locking** — `git worktree lock` / `unlock`
- **Listing** — `git worktree list --porcelain`
- **Branch lifecycle** — existence checks, orphan detection, force reset, branch deletion
- **Stale worktree handling** — dirty detection, preservation, cleanup
- **Pruning** — plan building and execution
- **Merge integration** — rebase, checkout, merge --no-ff
- **Default-branch resolution** — remote HEAD + local probe

### D087-A2 — TypeScript @cleocode/worktree is a thin facade ONLY

The TypeScript `packages/worktree` package MUST NOT invoke raw `git worktree`, `git branch`, or `git log` for lifecycle decisions. Its responsibilities are strictly:

1. Compute/validate the canonical XDG path (delegated to `@cleocode/paths`)
2. Convert TypeScript option objects to NAPI structs
3. Handle JS error shaping and CLEO-specific error codes
4. Run TypeScript-only hooks/bootstrap that genuinely cannot live in Rust
5. Perform CLEO-specific post-processing (audit log, sentinel index, sparse-checkout, `.worktreeinclude`)
6. NO direct git subprocess lifecycle invocations

### D087-A3 — Core cannot import worktree-napi directly

`packages/core` MUST consume worktree operations exclusively through `@cleocode/worktree`. Direct imports from `@cleocode/worktree-napi` are forbidden outside the `packages/worktree` package boundary.

### D087-A4 — CLI cannot perform lifecycle logic

`packages/cleo` MUST remain a thin command-parsing and dispatch layer. No git worktree lifecycle logic may exist in CLI command handlers.

### D087-A5 — Path computation stays in @cleocode/paths for this remediation

Canonical path computation (`computeProjectHash`, `resolveWorktreeRootForHash`, `resolveTaskWorktreePath`) remains in `@cleocode/paths` to reduce blast radius. A follow-up task (NOT in this epic) MAY evaluate moving path computation into `worktrunk-core` if absolute Worktrunk SSoT is desired.

### D087-A6 — Lint gate must enforce the boundary

`scripts/lint-no-raw-git-worktree.mjs` MUST be updated to reject raw git worktree shell-outs in **both** `packages/worktree/src/` and `packages/core/src/spawn/branch-lock.ts` — not just outside them. The allowlist MUST be restricted to:

- `crates/worktrunk-core/**` — legitimate lifecycle owner
- `crates/worktree-napi/**` — NAPI tests only
- Rust test fixtures

TypeScript packages (`packages/worktree/src/`, `packages/core/src/`, `packages/cleo/src/`) MUST NOT invoke raw `git worktree`, `git branch`, or lifecycle-relevant `git log`.

### D087-A7 — branch-lock.ts MUST route through @cleocode/worktree (T11064)

`packages/core/src/spawn/branch-lock.ts` is a parallel lifecycle owner performing raw `execFileSync('git', [...])` for the same operations that `packages/worktree/src/` performs. Both files MUST route through the same Rust-backed facade.

The migration path for branch-lock.ts:

1. **T10650 Wave 0-1**: Rust `worktrunk-core` gains high-level primitives (`provision_agent_worktree`, `merge_agent_worktree`, `prune_agent_worktree`) that encapsulate the full lifecycle policy currently duplicated across `worktree-create.ts` and `branch-lock.ts`.
2. **T10650 Wave 2**: `packages/worktree` exposes these as NAPI-backed functions (`createWorktree`, `completeWorktree`, `pruneWorktree`).
3. **T10650 Wave 2-3**: `branch-lock.ts` rewrites `createAgentWorktree`, `completeAgentWorktreeViaMerge`, `pruneWorktree`, `pruneOrphanedWorktrees`, and `getDefaultBranch` to delegate to `@cleocode/worktree` instead of raw `execFileSync('git', [...])`.
4. **T10650 Wave 3**: Lint gate (D087-A6) covers `packages/core/src/spawn/branch-lock.ts` in addition to `packages/worktree/src/`.

Validation (T10820): All 6 lifecycle functions in branch-lock.ts are accounted for in the SSoT boundary. No lifecycle owner is left ambiguous — `worktrunk-core` (Rust) owns lifecycle; `@cleocode/worktree` (TS) is the facade; `branch-lock.ts` delegates through it.

Anticipated reduction: ~28 raw git shell-out sites across `worktree-create.ts`, `worktree-destroy.ts`, `worktree-prune.ts`, and `branch-lock.ts` → 0 after migration.

## Consequences

### Positive

- Single source of truth for worktree lifecycle eliminates divergence between Rust, TypeScript, tests, CLI, agent spawning, AND the branch-lock spawn engine.
- Rust's type system and error handling improve reliability of edge cases (dirty worktrees, orphan branches, force reset, merge conflicts).
- NAPI bridge provides a clean FFI boundary with predictable performance characteristics.
- Lint gate prevents future architecture drift across ALL TypeScript surfaces.
- Eliminates duplicate lifecycle logic between `packages/worktree/src/` and `packages/core/src/spawn/branch-lock.ts`.

### Negative (Migration Cost)

- Requires implementing a higher-level Rust primitive (`provision_agent_worktree`) that encapsulates the full lifecycle policy currently scattered across TypeScript.
- Requires exposing 6 missing NAPI functions and regenerating TypeScript declarations.
- Requires rewriting `worktree-create.ts`, `worktree-destroy.ts`, AND `branch-lock.ts` to delegate to NAPI.
- Risk of regression in edge cases (dirty detection, orphan handling, lock fallback, merge/rebase) during the migration.
- branch-lock.ts is production-critical (it drives `cleo orchestrate spawn` + `cleo complete` integration) — migration must be verified with end-to-end spawn-merge-prune tests.

### Neutral

- Path computation stays in TypeScript for now, avoiding a cross-language pathing migration in the same epic.
- Sparse-checkout and `.worktreeinclude` application remain TypeScript responsibilities — these are CLEO-specific post-processing, not core git lifecycle.

## Implementation Path

The corrective epic T10650 implements this addendum in five waves:

1. **Wave 0** — Audit, ADR, and API design (T10651, T10652, T10653)
2. **Wave 1** — Rust implementation and NAPI exposure (T10654, T10655, T10656)
3. **Wave 2** — TypeScript bridge and facade rewrite — worktree-create.ts + branch-lock.ts (T10657, T10658, T10659, T10660)
4. **Wave 3** — Lint gate hardening and regression tests — covers both packages/worktree and packages/core (T10661, T10662, T10663, T11125)
5. **Wave 4** — Full verification, documentation, and skill updates — includes T11064 branch-lock audit validation (T10664, T10665, T10666, T11064)

## Decision Checklist for Future Lifecycle Changes

When introducing, modifying, or removing a worktree lifecycle operation, answer these questions (per T10821):

1. **Ownership**: Does the new logic live in `worktrunk-core` (Rust SSoT)? If not, why?
2. **NAPI exposure**: Is the new primitive exposed through `worktree-napi` with a proper napi-rs binding?
3. **TS bridge**: Is the NAPI function re-exported in `napi-binding.ts` with correct TypeScript types?
4. **Facade delegation**: Does the caller (`packages/worktree` or `packages/core/spawn/branch-lock.ts`) delegate to `@cleocode/worktree` rather than using raw `execFileSync('git', [...])` or `execa('git', [...])`?
5. **CLI purity**: Is the `packages/cleo` CLI handler free of lifecycle logic — does it only parse args and dispatch to core?
6. **Lint gate**: Does `scripts/lint-no-raw-git-worktree.mjs` reject the new operator if it appeared in a TypeScript package?
7. **Test coverage**: Do Rust tests cover the lifecycle edge cases (dirty worktree, orphan branch, merge conflict, lock fallback)?
8. **Migration**: If replacing a TypeScript shell-out, is the old code deleted (not just bypassed)?
9. **Brain memory**: Is the architectural decision recorded as a CLEO BRAIN memory via `cleo memory observe`?

If the answer to any question 1-6 is NO, the change violates this ADR and MUST be blocked in review.

## References

- T10650 — P0: Restore Worktrunk Rust SSoT for CLEO worktree lifecycle
- T10652 — This ADR addendum
- T10820 — Validate ADR-087-A against branch-lock findings
- T10821 — Decision checklist for future lifecycle changes
- T11064 — Audit branch-lock.ts as parallel lifecycle owner
- T10022 — False completion: worktree-create.ts NAPI routing (superseded by T10650)
- T9977 — SG-WORKTRUNK-OWN
- T9984 — lint-no-raw-git-worktree.mjs CI gate
- T10203 — NAPI exports for worktrunk-core primitives
- ADR-087 — Worktree FFI Topology (4-surface napi-rs canonical layout)
- ADR-055 — D029 (env-paths worktree canon) and D030 (native worktree)
- ADR-062 — Worktree merge --no-ff doctrine
- `packages/worktree/src/worktree-create.ts`
- `packages/worktree/src/worktree-destroy.ts`
- `packages/worktree/src/worktree-prune.ts`
- `packages/worktree/src/napi-binding.ts`
- `packages/core/src/spawn/branch-lock.ts`
- `packages/contracts/src/branch-lock.ts`
- `crates/worktree-napi/src/lib.rs`
- `crates/worktrunk-core/src/git_wt.rs`
