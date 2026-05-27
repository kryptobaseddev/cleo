# T11064: Audit of branch-lock.ts as Parallel Lifecycle Owner

**Date**: 2026-05-27 | **Task**: T11064 (child of T10650) | **Saga**: T9977 SG-WORKTRUNK-OWN

## AC1: Git Shell-Out Inventory

`packages/core/src/spawn/branch-lock.ts` (1146 lines) contains **36 git shell-out call sites**
across 6 exported lifecycle functions. All use `execFileSync('git', ...)` with no
NAPI or `@cleocode/worktree` routing.

### Functions audited:

**getGitRoot** (L126): `git rev-parse --show-toplevel`

**createAgentWorktree** (L147):
`git rev-parse --abbrev-ref HEAD`, `git worktree unlock`, `git worktree remove --force`,
`git branch -D`, `git worktree add <path> -b <branch>`, `git worktree lock` (x2)

**pruneOrphanedWorktrees** (L257):
`git worktree prune`, `git worktree unlock`, `git worktree remove --force`

**pruneWorktree** (L348):
`git branch --list`, `git branch -D`, `git status --porcelain`, `git worktree unlock`,
`git worktree remove --force`, `git worktree prune`, `git branch --list`,
`git rev-parse --abbrev-ref HEAD`, `git log --format=%H`

**getDefaultBranch** (L508):
`git symbolic-ref refs/remotes/origin/HEAD`, `git branch --list` (up to 4x)

**completeAgentWorktreeViaMerge** (L588):
`git branch --list`, `git fetch origin`, `git rev-parse --verify`, `git rebase`,
`git rebase --abort`, `git log --format=%H`, `git rev-parse --abbrev-ref HEAD`,
`git checkout`, `git merge --no-ff`, `git rev-parse HEAD`, `git merge --abort`,
`git checkout` (restore)

## AC2: Overlap with @cleocode/worktree

8 direct duplicates identified: git worktree unlock, remove --force, branch -D,
status --porcelain, worktree add -b, worktree lock, branch --list, log --format=%H.

Parallel implementations:
- `createAgentWorktree` (~47 lines) vs `createWorktree` (~300 lines): latter is richer
- `pruneOrphanedWorktrees` (set-based) vs `pruneOrphanedWorktreesByStatus` (status-based)
- `completeAgentWorktreeViaMerge`: UNIQUE to branch-lock, no equivalent in @cleocode/worktree
- `buildWorktreeSpawnResult`: nearly identical env/preamble to createWorktree inline

## AC3: Call Graph

CREATE path:  orchestrateSpawn → @cleocode/worktree.createWorktree (modern)
COMPLETE path: cleo complete → branch-lock.completeAgentWorktreeViaMerge (raw shell-outs)
PRUNE (sentient): sentient tick → branch-lock.pruneOrphanedWorktrees
PRUNE (CLI): cleo worktree prune → worktree/prune.pruneOrphanedWorktreesByStatus

**Neither path routes through Rust worktrunk-core.** Both still perform raw execFileSync.

## AC4: Recommendation

`@cleocode/worktree` should be the canonical lifecycle owner. In priority order:
1. Retire `createAgentWorktree` — use `createWorktree`
2. Migrate `completeAgentWorktreeViaMerge` to `@cleocode/worktree`
3. Consolidate prune functions into single status-based implementation
4. Retire branch-lock L1 lifecycle layer; keep L2 (shim) and L3 (hardening)
5. Route through NAPI to Rust worktrunk-core per ADR-087-A

## AC5: ADR-087-A Updated

ADR-087-A version 2 now includes branch-lock.ts, worktree-complete.ts, and
tasks/complete.ts as parallel lifecycle owners requiring remediation.
