---
id: t12503-task-optimistic-concurrency
tasks: [T12503]
kind: fix
summary: task updates no longer lose concurrent writes; --expected-updated-at fails with E_CONFLICT on a stale version
---

`cleo update` computed the whole row from a read taken before its write
transaction, so two processes running `cleo update <id> --add-labels …` could
each commit and one label would vanish (measured: 12 parallel adds kept 7).
The update is now rebased onto the row re-read inside the `BEGIN IMMEDIATE`
transaction: `--add/--remove-labels`, `--add/--remove-depends`,
`--add/--remove-files`, relates and notes are set operations on the current
row, and fields the caller did not touch keep their current values.

New optimistic-concurrency guard: `--expected-updated-at <updatedAt>` (wire
param `expectedUpdatedAt`, accessor `updateTaskFields(id, fields,
{ expectedUpdatedAt })`) fails with `E_CONFLICT` (exit 23,
`ExitCode.VERSION_CONFLICT`) carrying the current version when the task changed
since it was read. Writers now advance `updatedAt` strictly, so the timestamp
is a usable version even for same-millisecond writes.
