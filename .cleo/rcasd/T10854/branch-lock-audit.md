# Branch-Lock Audit: Lifecycle Ownership & Call Graph

Task: T10854 | Epic: T10853 (T9977 Saga) | Date: 2026-05-27

## T10855: Exported Functions & Callers

### Exported Functions (14 total)

| # | Function | Line | Category | Recommendation |
|---|----------|------|----------|----------------|
| 1 | `resolveAgentWorktreeRoot` | 111 | Worktree paths | MOVE to @cleocode/paths (already SSoT routed through computeProjectHash) |
| 2 | `getGitRoot` | 126 | Git query | MOVE to @cleocode/worktree/git.js (duplicated there at line 105) |
| 3 | `createAgentWorktree` | 147 | Lifecycle | REPLACE by provisionWorktree NAPI (T11122 target) |
| 4 | `buildWorktreeSpawnResult` | 209 | Lifecycle | MOVE to worktree isolation module; no git calls |
| 5 | `pruneOrphanedWorktrees` | 257 | Lifecycle | REPLACE by NAPI pruneWorktrees (T11123 target) |
| 6 | `pruneWorktree` | 348 | Lifecycle | REPLACE by destroyWorktree NAPI (T11123 target) |
| 7 | `getDefaultBranch` | 508 | Integration | MOVE to @cleocode/worktree/git.js; NAPI should own default-branch resolution |
| 8 | `completeAgentWorktreeViaMerge` | 588 | Integration | REPLACE by NAPI merge workflow (T11124 target) |
| 9 | `completeAgentWorktreeIntegration` | 840 | Integration | REPLACE by NAPI merge + audit (T11124 target) |
| 10 | `ensureGitShimDir` | 915 | Shim (L2) | KEEP in branch-lock or move to separate shim module |
| 11 | `detectFsHardenCapabilities` | 991 | Fs harden (L3) | KEEP; pure Node.js — no git calls |
| 12 | `applyFsHarden` | 1047 | Fs harden (L3) | KEEP; only shell-outs are `uname`, `which`, `chattr`, `chflags` |
| 13 | `removeFsHarden` | 1098 | Fs harden (L3) | KEEP; shell-outs to `chattr -i`/`chflags nouchg` |
| 14 | `buildAgentEnv` | 1141 | Composite | KEEP; trivial Object.assign wrapper |

### Private Helpers

| Helper | Line | Notes |
|--------|------|-------|
| `gitSync(args, cwd)` | 61 | Thin execFileSync('git', args) wrapper — duplicated by @cleocode/worktree/git.js |
| `gitSilent(args, cwd)` | 76 | Silent version — duplicated by @cleocode/worktree/git.js |

### Caller Map

#### Direct importers of branch-lock.ts
- `packages/core/src/spawn/index.ts` — barrel re-export (lines 20-35)
- `packages/core/src/internal.ts` — public API re-export (lines 2366, 2382)
- `packages/core/src/tools/sdk/spawn-primitives.ts` — re-exports buildAgentEnv, buildWorktreeSpawnResult
- `packages/core/src/orchestrate/worktree-complete.ts` — imports WorktreeIntegrationResult + 3 functions

#### Production callers (non-test)
- `packages/core/src/tasks/complete.ts:977` → `completeAgentWorktreeIntegration`
- `packages/core/src/orchestrate/worktree-complete.ts:306` → `completeAgentWorktreeIntegration`
- `packages/core/src/orchestrate/worktree-complete.ts:255,497` → `resolveAgentWorktreeRoot`
- `packages/core/src/sentient/cross-project-hygiene.ts:602` → `pruneOrphanedWorktrees`
- `packages/cleo/src/dispatch/domains/orchestrate.ts:1615-1644` → `pruneOrphanedWorktrees`, `pruneWorktree`

#### Test callers
- `packages/core/src/spawn/__tests__/worktree-prune.test.ts` (9 tests)
- `packages/core/src/spawn/__tests__/worktree-merge.test.ts` (9 tests)
- `packages/core/src/spawn/__tests__/worktree-audit.test.ts` (5 tests)
- `packages/core/src/__tests__/worktree-complete-auto.test.ts` (5 tests)
- `packages/core/src/orchestrate/__tests__/worktree-complete.test.ts` (5 tests)
- `packages/core/src/sentient/__tests__/cross-project-hygiene.test.ts` (imports `* as branchLock`)

## T10856: Git Command Classification

### Lifecycle Commands (worktree create/destroy/prune — NAPI target)
| Command | Location(s) | Context |
|---------|-------------|---------|
| `git worktree unlock <path>` | L165, L279, L421 | createAgentWorktree (stale cleanup), pruneOrphanedWorktrees, pruneWorktree |
| `git worktree remove --force <path>` | L166, L280, L422 | createAgentWorktree (stale cleanup), pruneOrphanedWorktrees, pruneWorktree |
| `git worktree add <path> -b <branch> <ref>` | L174 | createAgentWorktree — THE core lifecycle operation |
| `git worktree lock [--reason] <path>` | L178, L179 | createAgentWorktree — hardware-level isolation |
| `git worktree prune` | L267, L428 | pruneOrphanedWorktrees, pruneWorktree |

### Integration Commands (merge/rebase — separate ownership needed)
| Command | Location(s) | Context |
|---------|-------------|---------|
| `git fetch origin` | L655 | completeAgentWorktreeViaMerge — prep for rebase |
| `git rebase <onto>` | L666 | completeAgentWorktreeViaMerge — linearize before merge |
| `git rebase --abort` | L669 | completeAgentWorktreeViaMerge — conflict recovery |
| `git checkout <target>` | L726, L765 | completeAgentWorktreeViaMerge — switch to target branch |
| `git merge --no-ff <branch> -m ...` | L750 | completeAgentWorktreeViaMerge — THE core integration operation |
| `git merge --abort` | L759 | completeAgentWorktreeViaMerge — conflict recovery |
| `git branch -D <branch>` | L170, L378, L460 | createAgentWorktree (stale), pruneWorktree |
| `git branch --list <branch>` | L376, L445, L543, L623 | pruneWorktree, getDefaultBranch, completeAgentWorktreeViaMerge |

### Query Commands (read-only — either layer)
| Command | Location(s) | Context |
|---------|-------------|---------|
| `git rev-parse --show-toplevel` | L128 | getGitRoot |
| `git rev-parse --abbrev-ref HEAD` | L158, L450, L719 | createAgentWorktree, pruneWorktree, completeAgentWorktreeViaMerge |
| `git rev-parse HEAD` | L756 | completeAgentWorktreeViaMerge — capture merge SHA |
| `git rev-parse --verify <ref>` | L660 | completeAgentWorktreeViaMerge — check remote exists |
| `git status --porcelain` | L392 | pruneWorktree — dirty check |
| `git symbolic-ref refs/remotes/origin/HEAD` | L533 | getDefaultBranch |
| `git log --format=%H <range>` | L454, L687 | pruneWorktree, completeAgentWorktreeViaMerge |

### Non-Git Shell-outs (L3 filesystem hardening)
| Command | Location | Context |
|---------|----------|---------|
| `uname -r` | L997 | detectFsHardenCapabilities |
| `which chattr` | L1016 | detectFsHardenCapabilities |
| `which chflags` | L1024 | detectFsHardenCapabilities |
| `chattr +i <path>` | L1072 | applyFsHarden |
| `chattr -i <path>` | L1106 | removeFsHarden |
| `chflags uchg <path>` | L1079 | applyFsHarden |
| `chflags nouchg <path>` | L1112 | removeFsHarden |

### Total: ~42 distinct git shell-out calls across 36 call sites

## T10857: Test Fixtures Depending on branch-lock Internals

### Test File Inventory

| Test File | Functions Tested | Count | Migration Risk |
|-----------|-----------------|-------|----------------|
| `packages/core/src/spawn/__tests__/worktree-prune.test.ts` | pruneWorktree | 9 | HIGH — tests git worktree internals directly |
| `packages/core/src/spawn/__tests__/worktree-merge.test.ts` | getDefaultBranch, createAgentWorktree, completeAgentWorktreeViaMerge, resolveAgentWorktreeRoot | 9 | HIGH — creates real git worktrees |
| `packages/core/src/spawn/__tests__/worktree-audit.test.ts` | createAgentWorktree, completeAgentWorktreeIntegration | 5 | HIGH — tests audit log + merge workflow |
| `packages/core/src/__tests__/worktree-complete-auto.test.ts` | createAgentWorktree | 5 | MEDIUM — tests auto-complete integration |
| `packages/core/src/orchestrate/__tests__/worktree-complete.test.ts` | createAgentWorktree | 5 | MEDIUM — tests orchestrate-level complete |
| `packages/core/src/sentient/__tests__/cross-project-hygiene.test.ts` | * branchLock namespace | 1+ | LOW — imports whole module |

### Fixture Setup vs Production Behavior

All tests in `spawn/__tests__/` use real git repositories with actual worktree operations. They create real branches, merge them, and verify filesystem state. This makes them high-risk for NAPI migration — the test fixtures will need to be updated to use the new NAPI functions when the shell-out implementations are replaced.

### Migration Path

1. Create NAPI equivalents in @cleocode/worktree (already partially done via provisionWorktree/destroyWorktree)
2. Port spawn/__tests__ to use NAPI functions
3. After NAPI migration verified, delete shell-out implementations from branch-lock.ts
4. Port orchestrate-level tests to worktree package tests
5. Update cross-project-hygiene to use NAPI directly

### Existing NAPI Coverage (in @cleocode/worktree)

The @cleocode/worktree package already has:
- `packages/worktree/src/git.ts` — getGitRoot, gitSync, gitSilent, resolveHeadRef (duplicates branch-lock helpers)
- `packages/worktree/src/worktree-create.ts` — createWorktree (NAPI-based, replaces createAgentWorktree)
- `packages/worktree/src/worktree-destroy.ts` — destroyWorktree (NAPI-based, replaces pruneWorktree)
- `packages/worktree/src/worktree-prune.ts` — pruneWorktrees (NAPI-based, replaces pruneOrphanedWorktrees)
- `packages/worktree/src/napi-binding.ts` — NAPI bridge layer
