---
id: worktree-dispose-keeps-dependents
tasks: [T13696]
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
message saying why. `cleo complete` logs that message as a warning, and the
audit log records it. Evidence is kept in place rather than moved, because
re-validation reads only the recorded path or the project root.
