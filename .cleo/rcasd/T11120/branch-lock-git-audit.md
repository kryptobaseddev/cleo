# T11120 Audit: branch-lock.ts Git Shell-Out Surface

**File**: `packages/core/src/spawn/branch-lock.ts` (1146 lines)
**Date**: 2026-05-27
**Actual git spawns found**: 34 (task title says 42 — delta likely from counting subcommand variations)

---

## 1. execFileSync Call Sites

Three locations directly call `execFileSync('git', ...)`:

| Line | Site | Type |
|------|------|------|
| 62 | `gitSync()` wrapper body | All 17 gitSync invocations flow through here |
| 78 | `gitSilent()` wrapper body | All 16 gitSilent invocations flow through here |
| 750 | Raw merge call | `execFileSync('git', ['merge','--no-ff',branch,'-m',subject])` |

Plus 8 non-git execFileSync calls (uname, which, chattr, chflags) — not in scope.

---

## 2. Git Operations Catalog

### gitSync invocations (17)

| # | Subcommand | Occurrences | Functions |
|---|-----------|-------------|-----------|
| 1 | `rev-parse --show-toplevel` | 1 | getGitRoot |
| 2 | `rev-parse --abbrev-ref HEAD` | 3 | createAgentWorktree, pruneWorktree, completeAgentWorktree |
| 3 | `rev-parse HEAD` | 1 | completeAgentWorktree (post-merge SHA) |
| 4 | `worktree add [-b branch] <path> <baseRef>` | 1 | createAgentWorktree |
| 5 | `branch --list <name>` | 4 | pruneWorktree, getDefaultBranch, completeAgentWorktree (×2) |
| 6 | `branch -D <name>` | 2 | createAgentWorktree (stale cleanup), pruneWorktree |
| 7 | `status --porcelain` | 1 | pruneWorktree (dirty detection) |
| 8 | `log --format=%H <range>` | 2 | pruneWorktree (orphan check), completeAgentWorktree (commit count) |
| 9 | `symbolic-ref refs/remotes/origin/HEAD` | 1 | getDefaultBranch |
| 10 | `rebase <target>` | 1 | completeAgentWorktree (pre-merge rebase) |

### gitSilent invocations (16)

| # | Subcommand | Occurrences | Functions |
|---|-----------|-------------|-----------|
| 11 | `worktree unlock <path>` | 3 | createAgentWorktree, pruneOrphanedWorktrees, pruneWorktree |
| 12 | `worktree remove --force <path>` | 3 | createAgentWorktree, pruneOrphanedWorktrees, pruneWorktree |
| 13 | `worktree lock [--reason] <path>` | 2 | createAgentWorktree |
| 14 | `worktree prune` | 2 | pruneOrphanedWorktrees, pruneWorktree |
| 15 | `branch -D <name>` | 1 | createAgentWorktree |
| 16 | `fetch origin` | 1 | completeAgentWorktree |
| 17 | `rebase --abort` | 1 | completeAgentWorktree |
| 18 | `checkout <branch>` | 2 | completeAgentWorktree (switch to target, restore original) |
| 19 | `merge --abort` | 1 | completeAgentWorktree |

### Raw execFileSync('git'...) (1)

| # | Subcommand | Occurrences | Function |
|---|-----------|-------------|----------|
| 20 | `merge --no-ff <branch> -m <msg>` | 1 | completeAgentWorktree (THE merge, ADR-062) |

**Total distinct git subprocess spawns: 34**

---

## 3. NAPI Mapping

### COVERED (4 operations)

| Git Op | NAPI Export | Bridge Status |
|--------|------------|---------------|
| `worktree add` | `provisionWorktree(opts)` | **RUST EXISTS, NOT BRIDGED TO TS** |
| `worktree remove --force` | `destroyWorktree(opts)` | Bridged ✓ |
| `worktree lock` | `provisionWorktree(opts).lockReason` | Same as provisionWorktree |
| `worktree prune` | `pruneWorktrees(opts)` | Bridged ✓ (plan-only, no execution) |

### NAPI GAPS (12 distinct operations, 30 invocations)

| Gap | Count | Functions | Priority |
|-----|-------|-----------|----------|
| `rev-parse` (root/branch/HEAD) | 5 | getGitRoot, createAgentWorktree, pruneWorktree, completeAgentWorktree | HIGH |
| `branch --list / -D` | 7 | createAgentWorktree, pruneWorktree×3, getDefaultBranch, completeAgentWorktree | HIGH |
| `status --porcelain` | 1 | pruneWorktree (dirty detection) | MEDIUM |
| `log --format=%H <range>` | 2 | pruneWorktree, completeAgentWorktree | MEDIUM |
| `symbolic-ref origin/HEAD` | 1 | getDefaultBranch | MEDIUM |
| `fetch origin` | 1 | completeAgentWorktree | MEDIUM |
| `rebase / rebase --abort` | 2 | completeAgentWorktree | HIGH |
| `checkout <branch>` | 2 | completeAgentWorktree | HIGH |
| `merge --no-ff / --abort` | 2 | completeAgentWorktree | CRITICAL |
| `worktree unlock` | 3 | createAgentWorktree, pruneOrphanedWorktrees, pruneWorktree | MEDIUM |
| `rev-parse --verify refs/remotes/...` | 1 | completeAgentWorktree | LOW |

### Coverage: 11.8% (4 of 34 invocations partially covered, 2 fully covered)

---

## 4. Critical Finding: TS Bridge Gap

The Rust NAPI crate (`crates/worktree-napi/`) exports **13 functions** but the TS bridge (`packages/worktree/src/napi-binding.ts`) only surfaces **7**.

**NOT bridged (6):**

| Export | Priority | Why it matters |
|--------|----------|----------------|
| `provisionWorktree` | **BLOCKER** | Core git worktree creation — the main operation |
| `promoteBranch` | HIGH | Branch swap for release workflow |
| `relocateWorktree` | HIGH | Worktree relocation planning |
| `syncWorktree` | HIGH | Post-provision sync from main |
| `copyIgnored` | MEDIUM | Ignored-file copy step |
| `runStep` | MEDIUM | Generic step dispatcher |

`provisionWorktree` exists in Rust (9 references in `crates/worktree-napi/src/lib.rs`) and is declared in `index.d.ts` L267 but the `WorktreeNapiModule` interface in `napi-binding.ts` (L147-165) doesn't include it. Adding it would cover the `git worktree add` calls in both `branch-lock.ts:createAgentWorktree` (L174) AND `packages/worktree/src/git.ts:addTransientWorktree` (L176).

---

## 5. Duplicated Helpers (T11121 scope)

`gitSync` / `gitSilent` are defined twice:

| Location | Extras |
|----------|--------|
| `packages/core/src/spawn/branch-lock.ts` L61-83 | No timeout, no async variant |
| `packages/worktree/src/git.ts` L44-76 | Timeout support (180s), async variant (gitAsync) |

T11121 already exists to fix this duplication.

---

## 6. Recommendations

### Immediate (T11122-T11124 already scoped):
1. **Bridge `provisionWorktree`** (unblocks T11122 — migrate createAgentWorktree)
2. **Add `mergeNoFF` to NAPI** — the raw `execFileSync('git', ['merge'...])` at L750 is the ugliest call in the file
3. **Add `rebaseBranch` / `abortRebase`** — needed for completeAgentWorktree migration (T11124)

### Required new NAPI operations for full migration:
- `gitRoot(repoRoot)` → replaces `rev-parse --show-toplevel`
- `currentBranch(repoRoot)` → replaces `rev-parse --abbrev-ref HEAD`
- `headRef(repoRoot)` → replaces `rev-parse HEAD`
- `branchExists(repoRoot, branch)` → replaces `branch --list`
- `deleteBranch(repoRoot, branch)` → replaces `branch -D`
- `isDirty(worktreePath)` → replaces `status --porcelain`
- `commitCount(repoRoot, range)` → replaces `log --format=%H`
- `defaultBranch(repoRoot)` → replaces `symbolic-ref origin/HEAD`
- `fetchOrigin(repoRoot)` → replaces `fetch origin`
- `checkoutBranch(repoRoot, branch)` → replaces `checkout`
- `unlockWorktree(repoRoot, path)` → replaces `worktree unlock` (or auto-unlock in destroyWorktree)

JSON audit data: `.cleo/rcasd/T11120/branch-lock-git-audit.json`
