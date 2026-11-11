---
id: dispose-owned-worktree-export
tasks: [T14489]
kind: fix
summary: "@cleocode/worktree exports disposeOwnedWorktree; a failed createWorktree removes its worktree only while its lock token still holds the task lock"
---

`disposeOwnedWorktree` is now part of the `@cleocode/worktree` public API. It
checks the caller's lock token, the exact worktree path and branch, and removes
the worktree under the lock's mutex before releasing the lock with that token.

`createWorktree`'s failed-provision cleanup goes through it, so a same-holder
re-entry or a successor lock never loses the worktree it now owns.
