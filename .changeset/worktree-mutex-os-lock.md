---
id: worktree-mutex-os-lock
tasks: [T14491]
kind: fix
summary: "the worktree task-lock mutex is now an OS lock on an open file, which the OS frees when its holder dies, so no stale-mutex break can ever remove a live holder's mutex"
---

The per-task worktree lock serialised every lock-file write through an
`O_EXCL` mutex file (`<lock>.reclaim`). A crashed holder left that file
behind, so contenders had to judge it stale (pid, start time, age) and
delete it, and a path cannot be compared and deleted atomically: each fix
for the break race (six review rounds on #2798) moved the race one level up.

The mutex is now an exclusive advisory lock (`flock` on Unix, `LockFileEx`
on Windows) held on an open descriptor of `<lock>.flock`, through a new
`tryLockFile` binding in worktree-napi. The OS releases it when the holder
exits, so the stale break, the breaker lock and the pid and start-time
staleness test are gone, along with the unbounded hold of a mutex whose
holder's start time could not be read. A missing binding refuses the lock
instead of proceeding unlocked.

While CLEO v2026.11.1 and older may still run on the same machine, the new
release also takes their `<lock>.reclaim` mutex under the OS lock, the same
way they do, so an old-release dispose and a new-release reclaim never
overlap. A live old-release holder is never removed; a dead one is removed
only by the old release's own rule (stale, pid gone or recycled).
