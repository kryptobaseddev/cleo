# T9039 — Worktree Provisioning Pollution: Root Cause Analysis

**Date**: 2026-05-08
**Severity**: P1
**Task**: T9039
**Epic parent**: T9077

---

## Summary

During the T1910 epic, 5 sequential workers (T9015/T9016/T9018/T9019, T1921) had worktrees
provisioned from a polluted base state. Each branch showed 30–50 files / 3000–4000 lines
DELETED relative to expected main. Cherry-pick recovery was required.

---

## Root Cause

### Primary vector: symbolic HEAD resolution during sequential parallel-batch spawns

Both `packages/worktree/src/worktree-create.ts` and `packages/core/src/spawn/branch-lock.ts`
resolved the base ref for new worktree branches via:

```typescript
// BEFORE FIX — both files used this pattern:
baseRef = gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot);
// Returns the branch NAME, e.g. "main"
```

This returns the symbolic branch name (`main`), not a pinned SHA. The problem manifests as
follows:

1. Orchestrator spawns Worker 1 → `git worktree add -b task/T9015 <path> main`
   - `main` at this point is at SHA `abc123` (clean origin/main)
2. Worker 1 completes → orchestrator merges via `git merge --no-ff task/T9015 -m "Merge task/T9015"`
   - Local `main` now points to SHA `def456` (which includes Worker 1's commits)
3. Orchestrator spawns Worker 2 → `git worktree add -b task/T9016 <path> main`
   - `main` NOW resolves to `def456` — which already includes Worker 1's work
4. Worker 2's branch therefore starts from a tip that includes Worker 1's changes
5. After 5 sequential merges, Worker 6's branch starts from a tip with 3000+ lines of
   accumulated changes from all prior workers

The diff `task/TN..origin/main` then shows massive deletions because the new task branch
inherits all prior accumulated changes, while `origin/main` is still at the original clean SHA.

### Secondary vector: `createAgentWorktree` in branch-lock.ts

The legacy `createAgentWorktree` function in `packages/core/src/spawn/branch-lock.ts` contained
the same pattern (lines 147–152) and was also fixed.

### Why cherry-pick was needed

When the orchestrator tried to integrate these polluted branches back via `git merge --no-ff`,
the merge conflicts (from files that were deleted on the branch but existed on main) required
cherry-pick recovery to extract only the worker's actual changes.

---

## Fix

### `packages/worktree/src/git.ts` — New `resolveCleanBaseRef` function

Added `resolveCleanBaseRef(gitRoot, branch?, fallback?)` which uses a priority-ordered
resolution strategy:

1. **`origin/<branch>`** — the remote tracking ref. This is immune to local merge pollution
   because `origin/main` only advances when you push, not when you do local merges.
2. **`refs/heads/<branch>`** — the local branch tip. Fallback when origin is not configured
   (offline / bare clone without remote).
3. **`<fallback>` literal** — last resort, prevents throws.

The old `resolveHeadRef` was deprecated with a JSDoc warning.

### `packages/worktree/src/worktree-create.ts`

Changed line 116 from:
```typescript
const baseRef = options.baseRef ?? resolveHeadRef(gitRoot);
```
to:
```typescript
const baseRef = options.baseRef ?? resolveCleanBaseRef(gitRoot);
```

### `packages/core/src/spawn/branch-lock.ts`

Fixed the `createAgentWorktree` function (lines 147–165) and the `pruneWorktree` function
(lines 438–452) to use the same `origin/main → refs/heads/main → 'main'` resolution order.

---

## Integration Test

Added `packages/worktree/src/__tests__/worktree-clean-base.test.ts` with 3 tests:

1. **`resolveCleanBaseRef returns origin/main SHA over local HEAD`** — creates a local-only
   commit that advances local `main` beyond `origin/main`, then asserts `resolveCleanBaseRef`
   returns the `origin/main` SHA, not the local HEAD.

2. **`5 sequential parallel-batch spawns each produce branches with ONLY their own commits`** —
   the core regression test. Runs 5 sequential `createWorktree` + `git merge --no-ff` cycles
   (exactly the T1910 epic pattern), then spawns a 6th worker and asserts:
   - `result.baseRef === originMainSha` (pinned to remote SHA)
   - `git diff --stat <originMainSha>..task/T9039F` is empty (no pollution)

3. **`falls back to refs/heads/main SHA when no origin is configured`** — verifies the offline
   fallback path works correctly.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/worktree/src/git.ts` | Add `resolveCleanBaseRef`, deprecate `resolveHeadRef` |
| `packages/worktree/src/worktree-create.ts` | Use `resolveCleanBaseRef` for base ref resolution |
| `packages/worktree/src/index.ts` | Export `resolveCleanBaseRef` |
| `packages/core/src/spawn/branch-lock.ts` | Fix both `createAgentWorktree` and `pruneWorktree` base ref resolution |
| `packages/worktree/src/__tests__/worktree-clean-base.test.ts` | New integration test (3 tests) |
| `.cleo/agent-outputs/T9039-worktree-pollution-rca.md` | This document |

---

## Prevention

- `resolveHeadRef` is now marked `@deprecated` — callers should prefer `resolveCleanBaseRef`
- The integration test in `worktree-clean-base.test.ts` serves as a regression guard for the
  5-sequential-spawn pattern
- Future spawning code MUST use `resolveCleanBaseRef` (or pass an explicit `baseRef` SHA)
  when provisioning branches that will be merged back into the target branch
