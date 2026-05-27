# T11064: Audit of branch-lock.ts as Parallel Lifecycle Owner

**Date**: 2026-05-27
**Task**: T11064 (child of T10650)
**Saga**: T9977 SG-WORKTRUNK-OWN
**Related Epic**: T10853 E-WORKTRUNK-CORE-SPAWN-CONSOLIDATION

## AC1: Git Shell-Out Inventory in branch-lock.ts

`packages/core/src/spawn/branch-lock.ts` (1146 lines) contains **36 git shell-out call sites**
across 6 exported lifecycle functions, all using `execFileSync('git', ...)` with no
NAPI or `@cleocode/worktree` routing.

### Helper functions
- `gitSync(args, cwd)` — L61-67: runs `git` with `execFileSync`, returns stdout
- `gitSilent(args, cwd)` — L76-83: runs `git` silently, returns boolean

### `getGitRoot(projectRoot)` — L126-132
| # | Line | Command | Purpose |
|---|------|---------|---------|
| 1 | 128 | `git rev-parse --show-toplevel` | Resolve git root |

### `createAgentWorktree(taskId, projectRoot)` — L147-193
| # | Line | Command | Purpose |
|---|------|---------|---------|
| 2 | 158 | `git rev-parse --abbrev-ref HEAD` | Resolve base ref |
| 3 | 165 | `git worktree unlock <path>` | Unlock stale worktree |
| 4 | 166 | `git worktree remove --force <path>` | Remove stale worktree |
| 5 | 170 | `git branch -D <branch>` | Delete stale branch |
| 6 | 174 | `git worktree add <path> -b <branch> <base>` | **CREATE worktree** |
| 7 | 178 | `git worktree lock --reason ... <path>` | Lock with reason |
| 8 | 179 | `git worktree lock <path>` | Lock fallback |

### `pruneOrphanedWorktrees(projectRoot, taskIds?)` — L257-297
| # | Line | Command | Purpose |
|---|------|---------|---------|
| 9 | 267 | `git worktree prune` | Admin cleanup |
| 10 | 279 | `git worktree unlock <path>` | Unlock before remove |
| 11 | 280 | `git worktree remove --force <path>` | Remove stale |

### `pruneWorktree(taskId, projectRoot, opts)` — L348-474
| # | Line | Command | Purpose |
|---|------|---------|---------|
| 12 | 376 | `git branch --list <branch>` | Check branch exists |
| 13 | 378 | `git branch -D <branch>` | Delete stale branch (early exit) |
| 14 | 392 | `git status --porcelain` | Dirty detection |
| 15 | 421 | `git worktree unlock <path>` | Unlock before remove |
| 16 | 422 | `git worktree remove --force <path>` | Remove worktree |
| 17 | 428 | `git worktree prune` | Admin cleanup (fallback) |
| 18 | 445 | `git branch --list <branch>` | Check branch exists (post-remove) |
| 19 | 450 | `git rev-parse --abbrev-ref HEAD` | Resolve base ref |
| 20 | 454 | `git log --format=%H <base>..<branch>` | Count ahead commits |

### `getDefaultBranch(projectRoot)` — L508-552
| # | Line | Command | Purpose |
|---|------|---------|---------|
| 21 | 533 | `git symbolic-ref refs/remotes/origin/HEAD` | Resolve origin default |
| 22 | 543 | `git branch --list <candidate>` | Probe local branches (up to 4x) |

### `completeAgentWorktreeViaMerge(taskId, projectRoot, opts)` — L588-797
| # | Line | Command | Purpose |
|---|------|---------|---------|
| 23 | 623 | `git branch --list <branch>` | Branch exists check |
| 24 | 655 | `git fetch origin` | Fetch latest |
| 25 | 659-661 | `git rev-parse --verify refs/remotes/origin/<b>` | Remote exists check |
| 26 | 666 | `git rebase <onto>` | Rebase worktree onto target |
| 27 | 669 | `git rebase --abort` | Abort on conflict |
| 28 | 687 | `git log --format=%H <target>..<branch>` | Count commits ahead |
| 29 | 719 | `git rev-parse --abbrev-ref HEAD` | Save original branch |
| 30 | 726 | `git checkout <targetBranch>` | Switch to target |
| 31 | 750-755 | `git merge --no-ff <branch> -m "..."` | **MERGE** (direct execFileSync) |
| 32 | 756 | `git rev-parse HEAD` | Capture merge commit SHA |
| 33 | 759 | `git merge --abort` | Abort on merge failure |
| 34 | 765 | `git checkout <original>` | Restore original branch |

### `completeAgentWorktreeIntegration(taskId, projectRoot, opts)` — L840-881
- Delegates entirely to `completeAgentWorktreeViaMerge` (all 12 calls above)
- Adds audit log entry (filesystem, not git)

### Total: ~36 git invocations across 6 exported functions

---

## AC2: Overlap with worktree-create.ts

### Direct Duplicates (same git operations reimplemented):

| Operation | branch-lock.ts | @cleocode/worktree |
|-----------|----------------|-------------------|
| git worktree unlock | L165, L279, L421 | worktree-create.ts L209 |
| git worktree remove --force | L166, L280, L422 | worktree-create.ts L210 |
| git branch -D (stale cleanup) | L170 | worktree-create.ts L216 |
| git status --porcelain | L392 | worktree-create.ts L203 |
| **git worktree add -b** | L174 | worktree-create.ts L247 |
| git worktree lock | L178-179 | worktree-create.ts L277-281 |
| git branch --list | L376, L445 | worktree-create.ts L227 |
| git log --format=%H | L454, L687 | worktree-create.ts L236 |

### Functions with parallel implementations:

| branch-lock.ts | @cleocode/worktree | Verdict |
|---------------|-------------------|---------|
| `createAgentWorktree` (~47 lines) | `createWorktree` (~300 lines: hooks, sparse-checkout, audit, sentinel, pnpm install, identity verification) | `createWorktree` is richer and canonical. `createAgentWorktree` should be retired. |
| `pruneOrphanedWorktrees` (T1118, set-based) | `pruneOrphanedWorktreesByStatus` (T9547, status-based) in worktree/prune.ts | Two prune functions with different strategies. The status-based one is more sophisticated (T9546 classifier). Explicitly acknowledged at prune.ts L11-15. |
| `pruneWorktree` (single-task) | `destroyWorktree` in worktree-destroy.ts | Single-task prune vs destroy — overlapping but different semantics (prune = post-merge cleanup; destroy = force-cleanup) |
| `completeAgentWorktreeViaMerge` | — | **UNIQUE** to branch-lock. No equivalent in @cleocode/worktree. This is the merge/rebase/complete pipeline, and it's the most complex lifecycle function. |
| `buildWorktreeSpawnResult` | Inlined in `createWorktree` (L411-443) | Nearly identical env vars + preamble. Duplicated. |

---

## AC3: Call Graph — Which Path Uses Which

```
┌─────────────────────────────────────────────────────────────┐
│                    WORKTREE PROVISIONING                      │
├──────────────────┬──────────────────────────────────────────┤
│  orchestrateSpawn │  cleo orchestrate worktree-complete       │
│  (spawn-ops.ts)   │  (orchestrate/worktree-complete.ts)      │
│       │           │       │                                   │
│       ▼           │       ▼                                   │
│  spawnWorktree    │  completeAgentWorktreeIntegration         │
│  (worktree-       │  └─► completeAgentWorktreeViaMerge       │
│   dispatch.ts)    │      (branch-lock.ts L588-797)            │
│       │           │      ├─ fetch origin                     │
│       ▼           │      ├─ rebase onto target               │
│  createWorktree   │      ├─ git merge --no-ff               │
│  (@cleocode/      │      └─ pruneWorktree                    │
│   worktree)       │                                          │
│                   │  cleo complete (tasks/complete.ts L964)   │
│                   │      └─► same branch-lock path            │
├──────────────────┼──────────────────────────────────────────┤
│  cleo sentient tick                                         │
│  (sentient/cross-project-hygiene.ts)                        │
│       │                                                      │
│       ▼                                                      │
│  pruneOrphanedWorktrees (branch-lock.ts L257)               │
│  └─► set-based: pass known-active task IDs                  │
│                                                              │
│  cleo worktree prune --orphaned                             │
│       │                                                      │
│       ▼                                                      │
│  pruneOrphanedWorktreesByStatus (worktree/prune.ts)         │
│  └─► status-based: T9546 classifier                         │
└─────────────────────────────────────────────────────────────┘
```

### Key findings:
1. **CREATE path**: `orchestrateSpawn` → `@cleocode/worktree.createWorktree` (modern routing)
2. **COMPLETE path**: `cleo complete` → `branch-lock.completeAgentWorktreeViaMerge` (raw shell-outs)
3. **PRUNE path (sentient)**: `sentient tick` → `branch-lock.pruneOrphanedWorktrees` (raw shell-outs)
4. **PRUNE path (CLI)**: `cleo worktree prune` → `worktree/prune.pruneOrphanedWorktreesByStatus` (raw shell-outs)

**Neither path currently routes through Rust worktrunk-core.** Both `@cleocode/worktree` and `branch-lock.ts` perform raw `execFileSync('git', ...)` shell-outs — the NAPI migration defined in ADR-087-A has not yet been implemented.

---

## AC4: Canonical Owner Recommendation

**`@cleocode/worktree` should be the canonical owner of ALL worktree lifecycle.**
`branch-lock.ts` in `packages/core/src/spawn/` is a parallel lifecycle owner that
duplicates creation, pruning, and merge logic already present (or planned) in
`@cleocode/worktree`.

### Recommended consolidation path (for T10853):

1. **Merge creation**: Retire `createAgentWorktree` in favor of `createWorktree`.
   `createWorktree` already has richer features (hooks, sparse-checkout, audit,
   sentinel, pnpm install, identity verification via T11033/T11035).

2. **Migrate merge/complete**: Move `completeAgentWorktreeViaMerge` and
   `completeAgentWorktreeIntegration` from `branch-lock.ts` to
   `@cleocode/worktree`. This is the single most impactful migration — it's the
   most complex lifecycle function and currently lives in `packages/core`.

3. **Consolidate pruning**: Unify `pruneOrphanedWorktrees` (set-based, T1118)
   and `pruneOrphanedWorktreesByStatus` (status-based, T9547) into a single
   function in `@cleocode/worktree`. The status-based approach is preferred as
   it can derive "active" status from CLEO tasks.db rather than requiring
   callers to track active task IDs.

4. **Retire branch-lock lifecycle wrappers**: Once 1-3 are complete,
   `branch-lock.ts` should only retain L2 (shim materialization) and L3
   (filesystem hardening). The L1 lifecycle layer should be removed entirely.

5. **Route through Rust**: Once all lifecycle is consolidated in
   `@cleocode/worktree`, route through NAPI to `worktrunk-core` per ADR-087-A.

### Why branch-lock.ts is a significant parallel owner:
- It independently provisions worktrees (bypassing `@cleocode/worktree`)
- It independently merges/prunes worktrees (no equivalent in `@cleocode/worktree`)
- It lives in `packages/core/src/spawn/` — violating ADR-087-A D087-A3 which
  states "`packages/core` MUST consume worktree operations exclusively through
  `@cleocode/worktree`"
- It is the active integration path for `cleo complete` and
  `cleo orchestrate worktree-complete` — the most critical lifecycle operations
- 7 other files in `packages/core/src/` import from `branch-lock.ts`

---

## AC5: ADR-087-A Update Required

The ADR-087-A reference section currently lists drift in `packages/worktree/src/` but
does NOT mention `packages/core/src/spawn/branch-lock.ts` as a parallel lifecycle owner.
This is a significant omission — branch-lock.ts contains the merge/complete pipeline
that ADR-087-A's implementation wave must remediate.

**The ADR's references section should be updated to include:**
- `packages/core/src/spawn/branch-lock.ts` — parallel lifecycle owner (~36 git shell-outs across create/prune/merge)
- `packages/core/src/orchestrate/worktree-complete.ts` — completion entry point routing through branch-lock
- `packages/core/src/tasks/complete.ts` (L964-977) — auto-integration path routing through branch-lock
