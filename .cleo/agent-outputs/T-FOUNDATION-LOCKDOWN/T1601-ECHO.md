# T1601 (T-FOUND-1B) — Wire `completeAgentWorktreeViaMerge` Into Production Dispatch (Echo)

**Status:** SHIPPED — merge wired, cherry-pick removed from production path, full build + tests green.
**ADR:** ADR-062 (worktree merge, not cherry-pick).
**Predecessor:** T1587 (added `completeAgentWorktreeViaMerge` + `getDefaultBranch`).
**Followup task:** ADR-062 §Migration step 2 (rename `cherryPicked` → `merged` in `WorktreeCompleteResult`) NOT in scope here — separate contract change.

---

## Pre-fix grep state (the defect)

The merge function was added in T1587 but never wired into dispatch. Production CLI still routed through cherry-pick:

```text
packages/cleo/src/dispatch/domains/orchestrate.ts:1431:    const { completeAgentWorktree } = await import('@cleocode/core/internal');
packages/cleo/src/dispatch/domains/orchestrate.ts:1432:    const result = completeAgentWorktree(taskId, projectRoot);
packages/core/src/internal.ts:1446:  completeAgentWorktree,
packages/core/src/spawn/index.ts:25:  completeAgentWorktree,
packages/core/src/spawn/branch-lock.ts:250:export function completeAgentWorktree(taskId: string, projectRoot: string): WorktreeCompleteResult {
```

`completeAgentWorktreeViaMerge` existed (T1587) and had test coverage in `packages/core/src/spawn/__tests__/worktree-merge.test.ts` (8 tests) — but **zero** production callsites. Dead code at the production boundary.

---

## Files modified

| File | Change |
|------|--------|
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | `handleWorktreeComplete()` now imports + calls `completeAgentWorktreeViaMerge`; surfaces `result.error` (rebase/conflict/missing-branch) as `E_WORKTREE_COMPLETE_FAILED` instead of silently returning `success: true`. TSDoc cites ADR-062 / T1601. |
| `packages/core/src/internal.ts` | Added `completeAgentWorktreeViaMerge` and `getDefaultBranch` to the internal export barrel. |
| `packages/core/src/spawn/index.ts` | Same two exports added to the spawn barrel for direct importers. |
| `packages/core/src/spawn/branch-lock.ts` | Legacy `completeAgentWorktree` marked `@deprecated` (kept for one release per ADR-062 §Migration step 3 — no production callers remain in this repo). |
| `packages/cleo/src/dispatch/registry.ts` | `worktree.complete` operation description rewritten — was "cherry-pick commits to main", now "merge (--no-ff) into project default branch (preserves agent commit SHAs per ADR-062)". |
| `packages/cleo/src/dispatch/domains/__tests__/orchestrate.test.ts` | Added 3 tests: (1) dispatch invokes `completeAgentWorktreeViaMerge` and NOT `completeAgentWorktree`, (2) merge failure surfaces `E_WORKTREE_COMPLETE_FAILED`, (3) missing `taskId` returns `E_INVALID_INPUT`. |

### Architectural decisions

- **Option A (replace) over Option B (dual-path):** No production callers reference the legacy function and ADR-062 §Migration explicitly mandates the switch. Keeping a dual path would extend the dead-code surface and dilute the provenance contract.
- **Legacy retained behind `@deprecated`** (not deleted) per ADR-062 §Migration step 3 — "Mark cherry-pick path deprecated for one release, then remove." Removal is a separate task in a future release window.
- **Dispatch-level error surfacing** added intentionally: previously `success: true, data: { merged: false, error: '...' }` was silent. Now non-fatal merge failures (rebase conflicts, missing branch) become `success: false, error.code = E_WORKTREE_COMPLETE_FAILED` so orchestrators can react. This matches the existing pattern for `worktree.cleanup` / `worktree.prune` failures.
- **No signature adapter required:** the merge variant accepts an optional `opts` object whose defaults (`getDefaultBranch` resolution, `skipFetch=false`, no taskTitle) match what the dispatch path needs. Future enhancement: pass `opts.taskTitle` after a task lookup to enrich the merge commit subject — explicitly NOT in scope.

---

## Post-fix grep state

```text
=== merge wired in dispatch ===
packages/cleo/src/dispatch/domains/orchestrate.ts:1442:    const { completeAgentWorktreeViaMerge } = await import('@cleocode/core/internal');
packages/cleo/src/dispatch/domains/orchestrate.ts:1443:    const result = completeAgentWorktreeViaMerge(taskId, projectRoot);

=== legacy cherry-pick gone from dispatch ===
(none — clean)

=== legacy production callsites in packages/ (excluding tests/dist/md/internal.ts/spawn barrels/branch-lock.ts) ===
(none)
```

The only remaining references to the legacy `completeAgentWorktree` are: (a) its `@deprecated` definition in `branch-lock.ts`, (b) re-exports from `internal.ts` and `spawn/index.ts` (kept for one release window per ADR-062), (c) `@link` JSDoc cross-references, (d) ADR-062 itself.

---

## Test pass count

| Suite | Pass / Total |
|-------|---------------|
| `packages/core/src/spawn/__tests__/worktree-merge.test.ts` (T1587 baseline) | 8 / 8 |
| `packages/cleo/src/dispatch/domains/__tests__/orchestrate.test.ts` (3 new + 3 existing) | 6 / 6 |
| `packages/core/src/spawn/__tests__/` (full directory: adapter-registry, worktree-merge, worktree-prune) + `orchestrate-approval.test.ts` + `orchestrate-handoff.test.ts` | 46 / 46 |

No new failures introduced; no existing tests modified.

---

## Build + biome status

- `pnpm --filter @cleocode/core run build` — exit 0 (tsc clean).
- `pnpm --filter cleo run build` — exit 0 (tsc + shebang assert clean).
- `pnpm run build` (full repo) — exit 0 ("Build complete.").
- `pnpm biome ci` on all 6 modified files — `Checked 6 files. No fixes applied.` (clean).

---

## Project-agnostic verification

- No `'main'`, `'master'`, or other branch literals introduced in this change.
- The merge handler delegates target-branch resolution to `getDefaultBranch(projectRoot)`, which honours `.cleo/config.json::git.defaultBranch` → `origin/HEAD` → local probe order (`main`, `master`, `develop`, `trunk`) → fallback `'main'`. Confirmed by T1587's `worktree-merge.test.ts` (4 `getDefaultBranch` cases including `release`, `trunk`, `master`, fallback).

---

## Followups (NOT done by Echo — out of scope)

1. ADR-062 §Migration step 2: rename `WorktreeCompleteResult.cherryPicked` → `merged`, add `mergeCommit: string`. Touches `packages/contracts/src/branch-lock.ts` + every consumer of the legacy result shape. File as a separate task.
2. Removal of legacy `completeAgentWorktree` after one release window (ADR-062 §Migration step 3 final clause).
3. Optional enrichment: pass `opts.taskTitle` to `completeAgentWorktreeViaMerge` from dispatch by looking up the task — would yield `Merge T1601: <title>` instead of `Merge T1601: worktree integration` in commit history.
