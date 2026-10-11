---
id: worktree-lock-follows-session
tasks: [T13425]
kind: fix
summary: the spawn worktree lock is released at session end and follows the holder session, not a harness pid shared across sessions
---

The per-task worktree lock records the long-lived agent harness (codex,
claude) as its owner process. That process outlives every session it hosts, so
after `cleo session end` the lock still read as live, and a successor's
`cleo orchestrate spawn <task> --resume` was refused with E_WORKTREE_LOCKED
(exit 25).

- `cleo session end` releases every worktree lock held by the ending session,
  and records a `lock-release` audit entry for each.
- Before acquiring a lock, spawn and `--resume` look up the current holder's
  session. If that session has ended, was orphaned by the idle sweep, or is
  missing (for example after `cleo restore backup` to an older snapshot), the
  lock is reclaimed on this device even while the harness pid is alive. The
  reclaim is recorded as a `lock-reclaim` audit entry naming the previous
  holder and the reason (`session-ended`).
- A holder whose session is active or suspended is still refused.

`cleo worktree force-unlock` is unchanged: it clears `.git/index.lock` and runs
`git worktree unlock`, but never touches this lock.
