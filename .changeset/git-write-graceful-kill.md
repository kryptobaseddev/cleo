---
id: git-write-graceful-kill
tasks: [T14676]
kind: fix
summary: "a timed-out git write no longer leaves a stale .git/index.lock that fails the next git call"
---

`boundedExecOptions` SIGKILLs a sync exec at its timeout, which skips git's
own signal handler that removes `.git/index.lock` and ref locks. The next git
call in that repository then failed with "File exists".

Git writes now run through `gracefulKillExec` from `@cleocode/paths`: a small
`node` supervisor sends SIGTERM at the timeout, so git removes its locks, and
SIGKILL after a 5-second grace period if git ignores it. The worktree
package's `worktree add`, `worktree remove`, `branch -D`, `branch -m` and
`sparse-checkout` calls and the release rollback's `tag -d` and `revert` use
it. Reads keep the plain bounded exec, because the supervisor costs one `node`
start.

`isGhTimeout` now keys on `ETIMEDOUT` only, since the kill signal is SIGKILL
and a bare SIGKILL or SIGTERM comes from some other killer.
