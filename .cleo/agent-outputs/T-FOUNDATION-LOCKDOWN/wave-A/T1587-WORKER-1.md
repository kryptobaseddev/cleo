# T1587 — Worktree Merge Doctrine (Foundation-Worker-1)

**Date:** 2026-04-29
**Parent:** T1586 (T-FOUNDATION-LOCKDOWN)
**Worker:** Foundation-Worker-1, Wave A

## ADR

`/mnt/projects/cleocode/docs/adr/ADR-062-worktree-merge-not-cherry-pick.md`

Status: Accepted (2026-04-29). Replaces cherry-pick guidance in
CLEO-INJECTION.md, branch-lock.ts (legacy `completeAgentWorktree`),
worktree-destroy.ts, and the corrected memory note. Mandates
`git merge --no-ff <task-branch>` with a task-ID-bearing merge commit
subject so `git log --grep "T<id>"` recovers full provenance. Stale-base
concerns resolved by rebase-INSIDE-worktree before merge — never
cherry-pick. References ADR-055, ADR-041, ADR-061.

## Memory file status

`~/.claude/projects/-mnt-projects-cleocode/memory/feedback_cherry_pick_worktrees.md`
— **verified correct as of 2026-04-29**. Operator-corrected version
already states "use `git merge --no-ff` not cherry-pick" with the full
rationale matching ADR-062.

## Files updated to remove or qualify cherry-pick references

| File | Change |
|------|--------|
| `docs/adr/ADR-062-worktree-merge-not-cherry-pick.md` | New ADR (created) |
| `packages/core/templates/CLEO-INJECTION.md` (line 91) | Replaced cherry-pick prose with merge doctrine + ADR-062 reference |
| `packages/cleo/src/dispatch/registry.ts` (line 6477) | Operation description points to merge path; legacy cherry-pick flagged for back-compat only |
| `packages/contracts/src/branch-lock.ts` | Added `WorktreeMergeResult` contract |
| `packages/contracts/src/index.ts` | Exported `WorktreeMergeResult` |
| `packages/core/src/spawn/branch-lock.ts` | Added `getDefaultBranch()` + `completeAgentWorktreeViaMerge()` |
| `packages/core/src/spawn/__tests__/worktree-merge.test.ts` | New test suite (8 tests, all passing) |

## Files NOT touched (intentional)

| File | Reason |
|------|--------|
| `packages/core/src/spawn/branch-lock.ts::completeAgentWorktree` | Legacy cherry-pick path retained per ADR-062 §Migration. Switchover is a follow-up task. |
| `packages/worktree/src/worktree-destroy.ts` | Same — legacy back-compat. Migration filed in ADR-062. |
| `packages/core/src/sentient/kill-switch.ts` | "cherry-pick" refers to Tier-2 proposal *selection*, NOT git cherry-pick. |
| `packages/cleo/src/cli/commands/docs.ts`, `packages/core/src/docs/docs-ops.ts*` | "cherry-pick" is a docs-merge strategy *string literal*. Different feature. |
| `packages/core/src/store/migration-manager.ts`, `*/migration-*.test.ts` | Historical recovery comments referring to T417 incident. Updating would falsify the historical record. |
| `docs/adr/ADR-057-contracts-core-ssot.md` | Historical record of T1435/T1436 events. Don't rewrite history. |
| `~/.local/share/cleo/templates/CLEO-INJECTION.md` | Out-of-repo global install (operator constraint). Will be republished in next CLEO release. |

## New function signatures (project-agnostic, in `@cleocode/core`)

```ts
// packages/core/src/spawn/branch-lock.ts
export function getDefaultBranch(projectRoot: string): string;

export function completeAgentWorktreeViaMerge(
  taskId: string,
  projectRoot: string,
  opts?: {
    targetBranch?: string;
    taskTitle?: string;
    skipFetch?: boolean;
  },
): WorktreeMergeResult;
```

```ts
// packages/contracts/src/branch-lock.ts
export interface WorktreeMergeResult {
  taskId: string;
  targetBranch: string;          // project-agnostic — `main`/`master`/etc.
  merged: boolean;
  mergeCommit: string;            // SHA of the merge commit (preserved)
  commitCount: number;            // agent commits preserved by the merge
  rebased: boolean;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  error?: string;
}
```

Test: `packages/core/src/spawn/__tests__/worktree-merge.test.ts` —
8 tests, including the critical SHA-preservation contract:

```
✓ preserves agent commit SHAs in target branch history (provenance contract)
✓ does not hardcode `main` — works against an arbitrary target branch
✓ returns merged: true with empty mergeCommit when no commits ahead
✓ returns error when the task branch does not exist
✓ getDefaultBranch — reads .cleo/config.json::git.defaultBranch
✓ getDefaultBranch — falls back to local branch probing
✓ getDefaultBranch — does not hardcode main; discovers `master` correctly
✓ getDefaultBranch — returns "main" as last-resort fallback
```

All 28 tests in `packages/core/src/spawn/__tests__/` pass (zero
regressions in `worktree-prune.test.ts` or `adapter-registry.test.ts`).

## Cherry-pick reference counts

| When | `grep -rn "cherry-pick" packages/cleo packages/core docs/ \| wc -l` |
|------|---------------------------------------------------------------------|
| Pre-fix | 45 |
| Post-fix | 45 |

The count is unchanged because:

- New ADR-062 mentions "cherry-pick" 11 times (deliberately — explaining
  why it is wrong).
- New `worktree-merge.test.ts` mentions "cherry-pick" twice in
  comments asserting the new contract (provenance contract that
  cherry-pick would have broken).
- Legacy code paths (`completeAgentWorktree`, `worktree-destroy.ts`)
  retained per ADR-062 §Migration plan.
- Historical references (ADR-057, migration-manager comments,
  kill-switch unrelated usage, docs-ops feature strings) intentionally
  preserved.

The substantive doctrine has flipped: the only *prescriptive* mention
of cherry-pick in active CLEO doctrine (CLEO-INJECTION.md line 91 and
the registry operation description) now points to the merge path with
ADR-062 reference; cherry-pick is described only as the legacy path or
as a forbidden anti-pattern.

## Project-agnostic verification

- No hardcoded `"cleocode"` anywhere in new code.
- `getDefaultBranch()` resolves via 4-step fallback chain: config →
  origin/HEAD → probe (main, master, develop, trunk) → fallback `main`.
- Test suite proves project-agnosticism: tests use repos with default
  branches `main`, `master`, `develop`, `trunk`, and `feature-x`.
- `completeAgentWorktreeViaMerge` accepts `opts.targetBranch` for
  callers who want explicit control; otherwise delegates to
  `getDefaultBranch`.
- Last-resort fallback to `'main'` is the only hardcoded branch literal,
  matches industry default, and is documented in ADR-062.

## Follow-up tasks recommended (NOT done in this task)

1. Switch `cleo orchestrate worktree.complete` dispatch handler to call
   `completeAgentWorktreeViaMerge` (currently routes to legacy cherry-pick).
2. Rename `WorktreeCompleteResult.cherryPicked` → `merged` (breaking
   contract change — needs a release boundary).
3. Republish `CLEO-INJECTION.md` template to `~/.local/share/cleo/` in
   next CLEO release so installed agents pick up new doctrine.
4. Add `git.defaultBranch` field to `CleoConfig` contract in
   `packages/contracts/src/config.ts` for typed configuration support.
