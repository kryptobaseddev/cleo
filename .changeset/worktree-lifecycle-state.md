---
id: worktree-lifecycle-state
tasks: [T10871]
kind: refactor
summary: "Worktree completion reads the task's worktree through one typed lifecycle state"
---

`readWorktreeLifecycleState(projectRoot, taskId)` (core, lifecycle module)
returns the contract `WorktreeLifecycleState`: the worktree git has registered
for the task (path, checked-out branch, lock) or the canonical path, how CLEO
provisioned it (`create`, `adopt` or `null`, from the new facade reader
`readWorktreeProvisioning`), and whether it is dirty.
`completeWorktreeForTask` reads it once, names that path in its audit rows and
recovery steps, and returns it as `state` on every outcome.
