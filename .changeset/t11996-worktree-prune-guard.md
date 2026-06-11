---
id: t11996-worktree-prune-guard
tasks: [T11996]
kind: fix
summary: "worktree auto-prune dirty/unpushed guard — quarantine instead of delete, fail-closed, non-terminal preserve"
---

Fixes the highest-risk silent data-loss vector in the CLEO worktree subsystem:
both automatic prune paths (`worktree-prune.ts` sentient-tick + `gc/cleanup.ts`
orphan path) previously deleted worktrees with `force:true` and NO dirty or
unpushed-commit check. 154 worktrees / 257 GB live on this host.

**Root cause**: `classifyPruneCandidate` was mtime-only (no git state check);
`pruneOrphanWorktrees` called `rmSync({ force: true })` unconditionally;
`runWorktreePrune` built the preserve set from `status: 'active'` only —
silently removing worktrees for `pending`, `blocked`, and `proposed` tasks.

**Changes:**

- `packages/contracts/src/operations/worktree.ts` — added `'quarantine'` to
  `WorktreeLifecycleAction`; added `quarantined`, `quarantinedPaths`, and
  `skippedFailClosed` to `PruneWorktreesResult`.
- `packages/contracts/src/branch-lock.ts` — added `quarantined` /
  `quarantinedPaths` to `WorktreeCleanupResult`.
- `packages/worktree/src/worktree-prune.ts` — added `isWorktreeDirty()` (git
  status --porcelain -uall) and `hasUnpushedCommits()` (upstream ahead-count +
  remote-ref reachability for no-upstream / detached-HEAD branches); added
  `quarantineWorktreeDir()` (tar -czf --dereference, NO exclusions so .env /
  ignored files are captured); fixed `classifyPruneCandidate` so entries in the
  preserve set are NEVER pruned regardless of idle age (Amendment 1 PREDICATE
  BLOCKER); added fail-closed guard in `pruneWorktrees` (empty preserve set +
  existing worktrees → skip + audit warning); updated `pruneSingleEntry` to
  check dirty/unpushed before deletion.
- `packages/core/src/gc/cleanup.ts` — added same `isWorktreeDirty`,
  `hasUnpushedCommits`, `quarantineWorktreeDir` helpers; rewrote
  `pruneOrphanWorktrees` with fail-closed per-project guard and dirty/unpushed
  quarantine path; updated `CleanupResult` with `quarantined`,
  `quarantinedPaths`, `skippedFailClosed`.
- `packages/core/src/sentient/cross-project-hygiene.ts` — fixed
  `runWorktreePrune` to query ALL non-terminal statuses (`pending`, `active`,
  `blocked`, `proposed`) instead of `status: 'active'` only; added
  fail-closed per-project skip when task store is unreadable or preserve set
  is empty (Amendment 2).
- `packages/core/src/sentient/worktree-dispatch.ts` — updated `_syncPruneWorktrees`
  fallback to include new quarantine fields.
- `packages/core/src/spawn/branch-lock.ts` — `pruneOrphanedWorktrees` propagates
  quarantine fields from `pruneWorktrees` result.
- `packages/cleo/src/cli/commands/gc.ts` — human message includes quarantine count.

**Test coverage** (new files):
- `packages/worktree/src/__tests__/worktree-prune-guard.test.ts` — 10 cases:
  dirty guard, staged changes, untracked .env capture, preserve+idle invariant,
  fail-closed + audit write, empty-dir no-trigger, idempotency.
- `packages/core/src/__tests__/gc-prune-guard.test.ts` — 6 cases:
  dirty quarantine, .env capture in archive, fail-closed, empty-dir no-trigger,
  idempotency.
