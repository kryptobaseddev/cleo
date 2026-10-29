---
id: merged-work-cleanup
tasks: [T14142]
kind: feat
summary: "cleanupMergedWork removes the worktrees, task branches and nested repo copies that merged work left behind, each only after it is proven redundant"
---

`cleanupMergedWork({ projectRoot, taskIds?, dryRun, remote })` in core cleans
up after merged work. It dry-runs by default and lists everything first. It
handles three kinds of leftovers:

- **Canonical task worktrees** are removed only when all of these hold:
  - their commits are in `origin/<default>` after a fresh fetch;
  - the checkout is clean (any git error keeps it);
  - the worktree is not git-locked and holds no CLEO task lock;
  - no other checkout links into it, and no evidence lives only there.

  Removal goes through the existing guarded path (`removeWorktreeFromDisk`).
- **`task/*` branches** are deleted locally and on `origin` only when merged.
  A branch that is checked out somewhere, or that heads an open pull request,
  is kept. When open pull requests cannot be read, nothing on `origin` is
  deleted.
- **Repository copies nested inside worktrees** are removed only when they
  are clean and every commit they hold is on `origin`.

Every item is reported as removed or kept, with a reason, and the result
totals the bytes reclaimed. The merge sweep and `cleo release cut` call it.
`cleo worktree prune --orphaned` now also keeps a worktree with uncommitted or
untracked changes instead of force-removing it.
