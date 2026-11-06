---
id: t14268-derive-active
tasks: [T14268]
kind: feat
summary: "a task reads active exactly while its claim lease is live; list, counts and worktree protection derive it, and a lapsed lease reads pending with no write"
---

Owner decision D11230 retires stored `active`. This change is the read side.

- One claim clock (`claimClockNow`, injectable through `setClaimClock`) and
  one predicate (`isLiveClaim`, with `LIVE_CLAIM_SQL` and `DERIVED_STATUS_SQL`
  as its SQL forms).
- `rowToTask` derives `active` / `pending` from the lease. A written `active`
  is stored as `pending`.
- `cleo list --status active`, `queryTasks`, `countTasks`, `countByStatus`,
  child in-progress counts and the worktree listing's owning-task status all
  read the derived status.
- Worktree protection (`inProgressTaskIds`) counts a task as in progress when
  it holds a live lease or is an active session's focus.
