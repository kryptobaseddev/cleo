---
id: worktree-dispose-keeps-dependents
tasks: [T13696, T13700, T13701]
kind: fix
summary: cleo complete and cleo cancel no longer delete a task worktree that other worktrees symlink into, or that holds the only copy of the task's evidence
---

`cleo complete` prunes the task's worktree, and `cleo cancel` destroys it. Both
deleted the whole directory without checking anything. That lost the physical
`node_modules` that sibling worktrees symlinked into, plus raw evidence
receipts that existed only inside the worktree.

Before deleting anything, `pruneWorktree` (complete), `destroyWorktree` (cancel)
and the batch `pruneWorktrees` now look for two blockers:

- **Dependents.** Symlinks in other checkouts that resolve into the worktree.
  The scan covers every registered git worktree and every sibling under the
  worktree root, and checks `node_modules`, its top-level and `.pnpm` entries,
  and `packages/*/node_modules`.
- **Evidence.** Files that the task's `files:`, `test-run:` and `qa-run:` atoms
  hashed inside the worktree and that have no byte-identical copy under the
  project root. Re-validation falls back to the project root, so a merged,
  committed file is not a blocker.

When either blocker is found, the worktree and its branch are kept. The result
carries `kept: {dependents, evidence}` (`worktreeKept` on merge results) plus a
message saying why, and the audit log records it. Evidence is kept in place
rather than moved, because re-validation reads only the recorded path or the
project root.

Every path that deletes a worktree now runs this same guard:
`cleo complete`, `cleo cancel`, `cleo worktree prune`, `cleo gc --worktrees`,
`cleo orchestrate worktree.prune`, the sentient batch prune, and spawn-timeout
cleanup.

A keep is durable. The guard writes `<worktree>.keep.json` beside the checkout,
holding `{taskId, reason, projectRoot, dependents, evidence, keptAt}`, with
each evidence file's sha256. Batch prunes that have no task store re-check the
marker and skip the worktree, reporting why. The marker is removed and the
worktree disposed once no link resolves into it and every evidence file has a
byte-identical copy under the project root.

A kept worktree is visible. `cleo complete` and `cleo cancel` add a
`W_WORKTREE_KEPT` warning to the envelope, naming the path and the blockers.
`cleo cancel` now awaits its teardown and returns `worktreeKept`. `cleo worktree
list` shows `kept` for each kept worktree, read from its marker.
