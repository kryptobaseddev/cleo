---
id: t12503-if-match-conflict-summary
tasks: [T12503]
kind: fix
summary: cleo update/complete --if-match; E_CONFLICT names the changed fields; complete never overwrites a concurrent edit
---

`cleo update` and `cleo complete` accept `--if-match <updatedAt>` (the version
from `cleo show <id> --field /data/task/updatedAt`; `--expected-updated-at`
remains an alias on update). A stale version fails with `E_CONFLICT` (exit 23)
instead of overwriting the newer write.

The conflict now carries what an agent needs to merge: `details.currentVersion`,
`details.changedFields` and per-field `details.changes` (`was`/`now`, diffed
against the row the command read), `details.current` (title, status, priority,
labels, depends, parentId as stored), and a fix hint to re-read, merge and retry
with `--if-match <currentVersion>`.

`cleo complete` used to write the whole row from a read taken before its write
transaction, so a label or field added by another process in between was
silently reverted. Completion now compares the version inside the transaction
(the version it read, and `--if-match` too when given) and fails with a
retryable `E_CONFLICT` instead; a plain retry completes on top of the
concurrent edit. The task `cleo complete` returns carries the final version,
so it can be passed straight to a follow-up `--if-match`.

`cleo done --if-match` checks the version before recording any gate (and again
right before the gate write); recording advances the version, so the
completion that follows uses its own read. `--if-match` with several task ids
is refused.

`E_CONFLICT` details are bounded: `current.title` is cut at 200 characters and
`current.labels` / `current.depends` hold the first 50 entries with
`labelsTotal` / `dependsTotal` counts.

The guarded `updateTaskFields` chokepoint is a single SQL compare-and-set
(`UPDATE … WHERE id = ? AND updated_at = ?`). No schema change: the version is
`updatedAt`. The update, complete and field-update paths advance it strictly
(`nextTaskVersion`); some other writers (parent/saga roll-ups, gate records,
raw `new Date()` stamps) still set it from the clock, leaving a narrow
same-millisecond window tracked in T12720.
