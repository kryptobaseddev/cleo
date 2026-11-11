---
id: late-spawn-timeout-cleanup-ownership
tasks: [T14483]
kind: fix
summary: "a spawn that times out late removes its worktree only while it still holds the task lock it took, so a re-spawn's checkout is never removed"
---

A spawn that blew its budget ran `destroyWorktree` on the task id. If its
session had been abandoned or its lock reclaimed in the meantime, a newer spawn
of the same task owned that lock and worked in that checkout, and the late
cleanup removed it.

`runTimeoutCleanup` now takes the exact worktree path and lock token the spawn
created. It removes nothing, and reports `notOwned`, unless the task lock still
carries that token and git still has the task's worktree at that path. A spawn
holding no lock token removes nothing either.
