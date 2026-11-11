---
id: failed-provision-cleanup-under-lock
tasks: [T14407]
kind: fix
summary: "a failed spawn removes the worktree it created before releasing the task lock, so a concurrent re-spawn's worktree is never removed"
---

`createWorktree` used to release the per-task lock and leave the cleanup of a
worktree its failed call created to the caller. A re-spawn of the same task
could take the lock in between and re-attach that worktree, and the caller's
cleanup then removed it.

`createWorktree` now removes the fresh worktree itself, while it still holds
the lock, and reports the outcome on the error it rethrows (`cleanup`, typed
by `CreateWorktreeFailure`). `orchestrateSpawn` and `orchestrateSpawnExecute`
report that outcome and no longer remove anything after a failed provision.
A re-spawn that arrives during the cleanup is refused with `E_WORKTREE_LOCKED`
and succeeds on retry with its own worktree.
