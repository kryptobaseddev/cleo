# T10651: Audit — Current Lifecycle Split Across TS/Rust

## Summary

The worktree lifecycle is **duplicated across two parallel code domains** with overlapping semantics and separate git shell-out wrappers. `packages/worktree` is the canonical SSoT (post-T1161) with NAPI bindings for create/destroy/prune/copy, while `packages/core/src/spawn/branch-lock.ts` (T1118) reimplements the same lifecycle operations with raw `execFileSync('git', ...)` — no NAPI routing.

**Total shell-outs cataloged: 53+** across 7 source files (excluding tests).

---

## PART 1: packages/worktree/src/ — Audit

### 1. git.ts (196 lines) — Central Shell-Out Module

This is the legitimate owner of git subprocess execution in the worktree package. Every shell-out routes through one of three wrappers:

| Line | Function | Operation | Classification |
|------|----------|-----------|----------------|
| 44-51 | `gitSync()` | `execFileSync('git', args, ...)` | Wrapper — all sync git |
| 65-76 | `gitSilent()` | `execFileSync('git', args, ...)` non-throwing | Wrapper — all silent git |
| 89-96 | `gitAsync()` | `execFileAsync('git', args, ...)` | Wrapper — all async git |
| 107 | `getGitRoot()` | `gitSync(['rev-parse', '--show-toplevel'], ...)` | **Lifecycle** — git root resolution |
| 122 | `resolveHeadRef()` | `gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], ...)` | **Lifecycle** — HEAD resolution |
| 176 | `addTransientWorktree()` | `gitAsync(['worktree', 'add', flag, branch, worktreePath, baseRef], ...)` | **LIFECYCLE CREATE** — transient (non-XDG) worktree |
| 194 | `removeTransientWorktree()` | `gitAsync(['worktree', 'remove', '--force', worktreePath], ...)` | **LIFECYCLE DESTROY** — transient worktree |

**Replacement owner for lifecycle calls:** `addTransientWorktree` and `removeTransientWorktree` are explicitly for non-agent worktrees (e.g., doc-PR-publish flow per T9984). The gitSync/gitSilent/gitAsync wrappers are the legitimate shell-out surface for all subprocess git — replacement target is **Rust worktrunk-core NAPI** (ADR-087).

### 2. worktree-create.ts (479 lines) — Agent Worktree Creation

All shell-outs route through `gitSync`/`gitSilent` from git.ts:

| Line | Operation | Classification |
|------|-----------|----------------|
| 203 | `gitSync(['status', '--porcelain'], ...)` | Dirty check — pre-cleanup |
| 209 | `gitSilent(['worktree', 'unlock', ...])` | Cleanup — stale unlock |
| 210 | `gitSilent(['worktree', 'remove', '--force', ...])` | Cleanup — stale remove |
| 216 | `gitSilent(['branch', '-D', ...])` | Cleanup — stale branch |
| 227 | `gitSync(['branch', '--list', branch], ...)` | Branch existence check |
| 236 | `gitSync(['log', '--format=%H', ...])` | Orphan commit detection |
| 248 | `gitSync(['worktree', 'add', '-b', branch, ...])` | **LIFECYCLE CREATE** — force-reset path |
| 253 | `gitSync(['worktree', 'add', '-b', branch, ...])` | **LIFECYCLE CREATE** — branch-reuse path |
| 254 | `gitSync(['worktree', 'add', branch, ...])` | **LIFECYCLE CREATE** — reattach path |
| 286 | `gitSilent(['worktree', 'lock', '--reason', ...])` | Lock — with reason (git >= 2.37) |
| 288 | `gitSilent(['worktree', 'lock', ...])` | Lock — fallback |
| 110 | `gitSilent(['sparse-checkout', 'init', '--no-cone'], ...)` | Sparse-checkout — spawn-clone-exclude |
| 111 | `gitSilent(['sparse-checkout', 'set', '--no-cone', ...])` | Sparse-checkout — set exclusions |
| 138 | `gitSilent(['sparse-checkout', 'init', '--cone'], ...)` | Sparse-checkout — scope mode |
| 139 | `gitSilent(['sparse-checkout', 'set', scope], ...)` | Sparse-checkout — scope set |

**Replacement owner for lifecycle:** `git worktree add` (L248, L253, L254) should route through `worktrunk-core::git_wt::provision_worktree` (Rust NAPI per ADR-087). Sparse-checkout is post-provision filtering — may remain TS-owned or migrate to NAPI based on T9226/T9807 decisions.

### 3. worktree-destroy.ts (197 lines) — Agent Worktree Destruction

| Line | Operation | Classification |
|------|-----------|----------------|
| 64 | `gitSync(['status', '--porcelain'], ...)` | Dirty check |
| 108 | `gitSilent(['worktree', 'unlock', ...])` | Pre-NAPI unlock |
| 110 | `napiDestroyWorktree({repoRoot, worktreePath, force})` | **NAPI DESTROY** — primary path ✓ |
| 151 | `gitSync(['branch', '--list', branch], ...)` | Branch existence check |
| 153 | `gitSync(['branch', '-D', branch], ...)` | Branch deletion |

**Assessment:** Destroy is partially migrated to NAPI. The core removal (L110) uses `napiDestroyWorktree`. Still shells out for unlock (L108), dirty detection (L64), and branch deletion (L153). Branch deletion should move to NAPI per Rust `worktrunk-core::git_wt::destroy_worktree`.

### 4. worktree-prune.ts (274 lines) — Worktree Pruning

| Line | Operation | Classification |
|------|-----------|----------------|
| 98 | `gitSilent(['worktree', 'prune'], ...)` | Admin cleanup |
| 175 | `gitSilent(['worktree', 'unlock', ...])` | Unlock per-entry |
| 176 | `gitSilent(['worktree', 'remove', '--force', ...])` | **LIFECYCLE REMOVE** per-entry |
| 228-231 | `execFileSync('git', ['-C', worktreePath, 'log', '-1', '--format=%ct'], ...)` | Idle detection — raw execFileSync (NOT through git.ts!) |
| 269 | `napiPrune({repoRoot, integrationTarget})` | **NAPI PRUNE PLAN** — read-only ✓ |

**Assessment:** `git worktree remove` (L176) and idle detection (L228) are raw git. The idle detection bypasses git.ts entirely (`execFileSync('git', ...)` direct). Prune plan construction uses NAPI, but removal uses raw git. NAPI `removeDir` is used as fallback (L184).

### 5. worktree-list.ts (149 lines) — Worktree Listing

| Line | Operation | Classification |
|------|-----------|----------------|
| 112 | `getGitRoot(worktreePath)` | Git root per-worktree |
| via `buildBranchLookup()` | `execFileSync('git', ['worktree', 'list', '--porcelain'], ...)` | **Branch mapping** — raw git |

**Assessment:** `buildBranchLookup` shells out to `git worktree list --porcelain` for branch-to-path mapping. Could be replaced by NAPI `listWorktrees`.

### 6. worktree-pnpm.ts (136 lines) — Dependency Installation

| Line | Operation | Classification |
|------|-----------|----------------|
| 118 | `execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], ...)` | pnpm install | **Not git** — package manager |

### 7. copy-on-write.ts (97 lines)

**No shell-outs.** Fully migrated to NAPI (`copyPathsParallel`). ✓

### 8. worktree-migrate.ts (176 lines)

**No shell-outs.** Pure filesystem operations. ✓

---

## PART 2: packages/core/src/spawn/branch-lock.ts — Audit

### Own gitSync/gitSilent Wrappers (L61-83)

branch-lock.ts defines its OWN `gitSync` and `gitSilent` — these are **independent duplicates** of the wrappers in `packages/worktree/src/git.ts`. Same pattern, same semantics, different module. Not routing through the canonical `@cleocode/worktree` SSoT.

### createAgentWorktree() (L147-193)

| Line | Operation | Classification |
|------|-----------|----------------|
| 128 | `gitSync(['rev-parse', '--show-toplevel'], ...)` | Git root — **DUPLICATE** of worktree's `getGitRoot()` |
| 158 | `gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], ...)` | HEAD ref — **DUPLICATE** of worktree's `resolveHeadRef()` |
| 165 | `gitSilent(['worktree', 'unlock', ...])` | Stale cleanup |
| 166 | `gitSilent(['worktree', 'remove', '--force', ...])` | Stale cleanup |
| 170 | `gitSilent(['branch', '-D', ...])` | Stale branch |
| 174 | `gitSync(['worktree', 'add', worktreePath, '-b', branch, baseRef], ...)` | **LIFECYCLE CREATE** — **DUPLICATE** of worktree-create.ts |
| 178 | `gitSilent(['worktree', 'lock', '--reason', ...])` | Lock with reason |
| 179 | `gitSilent(['worktree', 'lock', ...])` | Lock fallback |

### pruneOrphanedWorktrees() (L257-297)

| Line | Operation | Classification |
|------|-----------|----------------|
| 267 | `gitSilent(['worktree', 'prune'], ...)` | Admin cleanup |
| 279 | `gitSilent(['worktree', 'unlock', ...])` | Unlock |
| 280 | `gitSilent(['worktree', 'remove', '--force', ...])` | **LIFECYCLE REMOVE** — **DUPLICATE** of worktree-prune.ts |

### pruneWorktree() (L348-474)

| Line | Operation | Classification |
|------|-----------|----------------|
| 376 | `gitSync(['branch', '--list', ...])` | Branch check |
| 378 | `gitSync(['branch', '-D', ...])` | Branch delete |
| 392 | `gitSync(['status', '--porcelain'], ...)` | Dirty check |
| 421 | `gitSilent(['worktree', 'unlock', ...])` | Unlock |
| 422 | `gitSilent(['worktree', 'remove', '--force', ...])` | **LIFECYCLE REMOVE** — **DUPLICATE** |
| 428 | `gitSilent(['worktree', 'prune'], ...)` | Admin cleanup |
| 445 | `gitSync(['branch', '--list', ...])` | Branch check |
| 450 | `gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], ...)` | HEAD ref |
| 454 | `gitSync(['log', '--format=%H', ...])` | Ahead-check |
| 460 | `gitSync(['branch', '-D', ...])` | Branch delete |

### completeAgentWorktreeViaMerge() (L588-797)

| Line | Operation | Classification |
|------|-----------|----------------|
| 533 | `gitSync(['symbolic-ref', 'refs/remotes/origin/HEAD'], ...)` | Default branch (via `getDefaultBranch`) |
| 543 | `gitSync(['branch', '--list', candidate], ...)` | Branch probe |
| 623 | `gitSync(['branch', '--list', branch], ...)` | Branch check |
| 655 | `gitSilent(['fetch', 'origin'], ...)` | Fetch |
| 659-662 | `gitSilent(['rev-parse', '--verify', ...])` | Remote ref check |
| 666 | `gitSync(['rebase', rebaseOnto], ...)` | **LIFECYCLE REBASE** |
| 669 | `gitSilent(['rebase', '--abort'], ...)` | Rebase abort |
| 687 | `gitSync(['log', '--format=%H', ...])` | Commit count |
| 719 | `gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], ...)` | Current branch |
| 726 | `gitSilent(['checkout', targetBranch], ...)` | Checkout target |
| 750-755 | `execFileSync('git', ['merge', '--no-ff', branch, '-m', subject], ...)` | **LIFECYCLE MERGE** — raw execFileSync (NOT through any wrapper!) |
| 756 | `gitSync(['rev-parse', 'HEAD'], ...)` | Merge SHA |
| 759 | `gitSilent(['merge', '--abort'], ...)` | Merge abort |
| 765 | `gitSilent(['checkout', originalBranch], ...)` | Restore branch |

### Other shell-outs in branch-lock.ts

| Line | Operation | Classification |
|------|-----------|----------------|
| 997 | `execFileSync('uname', ['-r'], ...)` | OS detection (fs harden) — not git |

### adapter-registry.ts and spawn/index.ts

**No shell-outs.** Pure TS registry and barrel exports.

---

## PART 3: Duplication Analysis

### Critical duplicated lifecycle operations

| Operation | packages/worktree | packages/core/spawn/branch-lock |
|-----------|-------------------|-------------------------------|
| **Create worktree** | `createWorktree()` → git.ts:gitSync | `createAgentWorktree()` → local gitSync |
| **Destroy worktree** | `destroyWorktree()` → NAPI + git.ts fallback | `pruneWorktree()` / `pruneOrphanedWorktrees()` → local gitSilent |
| **Prune worktrees** | `pruneWorktrees()` → NAPI plan + git.ts remove | `pruneOrphanedWorktrees()` → local gitSilent |
| **Merge worktree** | N/A | `completeAgentWorktreeViaMerge()` → raw execFileSync |
| **Git root** | `git.ts:getGitRoot()` | `branch-lock.ts:getGitRoot()` |
| **HEAD ref** | `git.ts:resolveHeadRef()` | `branch-lock.ts:` inline `gitSync(['rev-parse', '--abbrev-ref'])` |
| **Branch lock** | Via git.ts:gitSilent | Via local gitSilent |
| **Dirty check** | Via git.ts:gitSync('status') | Via local gitSync('status') |
| **Branch list** | Via git.ts:gitSync('branch --list') | Via local gitSync('branch --list') |

### 3 git shell-out wrapper implementations exist

1. `packages/worktree/src/git.ts` — canonical SSoT for worktree package — 3 wrappers with timeout support (T9545)
2. `packages/core/src/spawn/branch-lock.ts` — local duplicates — 2 wrappers WITHOUT timeout support
3. `packages/worktree/src/worktree-prune.ts` L228 — raw `execFileSync('git', ...)` bypassing all wrappers

### Packages/worktree already has partial NAPI migration

- `copy-on-write.ts` — FULLY migrated to NAPI ✓
- `worktree-destroy.ts` — PARTIALLY migrated (core removal via NAPI, unlock+branch via git.ts)
- `worktree-prune.ts` — PARTIALLY migrated (plan via NAPI, removal via git.ts)
- `worktree-create.ts` — NOT migrated (all git via git.ts wrappers)
- `worktree-list.ts` — NOT migrated (git via git.ts `buildBranchLookup`)

### Branch-lock.ts has ZERO NAPI routing

Every shell-out in `branch-lock.ts` is raw `execFileSync('git', ...)`. It never routes through `@cleocode/worktree-napi` or `worktrunk-core`. This is the highest-priority remediation target.

### Merge operation is orphaned

`completeAgentWorktreeViaMerge()` (branch-lock.ts L750) uses bare `execFileSync('git', ...)` with custom `CLEO_ORCHESTRATE_MERGE=1` env — not through git.ts or any wrapper. This is the highest-risk shell-out because it writes to the main repo's target branch.

---

## PART 4: Remediation Target Tasks

Each shell-out in packages/worktree that should migrate to Rust NAPI maps to existing T10650 child tasks:

| Shell-out | Target task | Status |
|-----------|------------|--------|
| `git worktree add` (create) | T10654 (T4: provision_agent_worktree) + T10658 (T8: rewrite worktree-create.ts) | Pending |
| `git worktree remove` (destroy) | T10655 (T5: expose via NAPI) + T10659 (T9: rewrite worktree-destroy.ts) | Pending |
| `git worktree list --porcelain` | T10655 (T5) + T10660 (T10: eliminate shell-outs) | Pending |
| `git branch -D` (branch delete) | T10660 (T10) | Pending |
| `git log --format=%H` (ahead check) | T10660 (T10) | Pending |
| `git status --porcelain` (dirty) | T10660 (T10) | Pending |
| `git rebase` (pre-merge) | T10660 (T10) | Pending |
| `git merge --no-ff` (integration) | T10660 (T10) | Pending |

Branch-lock.ts duplication remediation is covered by T11064 (already in ready wave) and partially by T10657-T10661.

---

## PART 5: Key Decisions for Epic T10650

1. **Packages/worktree is the canonical SSoT.** All new worktree lifecycle code should route through it. `branch-lock.ts` should become a thin delegator (T11064).

2. **Merge ownership:** `completeAgentWorktreeViaMerge` is the most dangerous shell-out (it writes to the integration branch). Should move to Rust NAPI via a dedicated `merge_agent_worktree` primitive, or the TS layer should be trimmed to call into worktree package NAPI bindings.

3. **Sparse-checkout is post-provision filtering** — distinguishes from lifecycle shell-outs per AC2 of T10817. These may stay TS-owned or migrate based on scope decisions.

4. **`git.ts` wrappers are NOT the problem.** They're the legitimate shell-out surface. The problem is the parallel implementation in `branch-lock.ts` that bypasses both the canonical wrappers AND the NAPI bindings.

5. **The `gitSync`/`gitSilent` duplication** between worktree/git.ts and core/spawn/branch-lock.ts should be resolved by having branch-lock import from `@cleocode/worktree` (T11064) rather than by maintaining two copies.
