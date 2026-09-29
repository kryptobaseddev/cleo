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
(against `--if-match`, or else the version it read) and fails with a retryable
`E_CONFLICT` instead; a plain retry completes on top of the concurrent edit.

The guarded `updateTaskFields` chokepoint is a single SQL compare-and-set
(`UPDATE … WHERE id = ? AND updated_at = ?`). No schema change: the version is
the strictly-advancing `updatedAt`.
