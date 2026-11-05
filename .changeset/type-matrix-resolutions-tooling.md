---
id: type-matrix-resolutions-tooling
tasks: [T14140]
kind: fix
summary: "cleo doctor type-matrix: one task may take a re-type and a reparent, a reparent may go to the root, and --apply can be held to a reviewed --plan (T14140)"
---

Resolving the remaining type-matrix violations needed operations the first
version could not express. A resolutions file may now give one task both a
re-type and a reparent (applied as one write, so the trigger only sees the
final shape), and `"toParentId": null` moves a task to the root.

`--apply --plan <file>` takes the reviewed dry run (the command's JSON
output) and applies only its operations, on rows unchanged since it read
them; anything else is `E_CONFLICT` with nothing written.

A reparent now notes "Reopened by reparent of ..." on each done ancestor it
reopens, as `cleo update --parent` does. A rollback leaves those ancestors
open and lists them as `stillReopened`.

Fix: the depth limit for a reparent counted one level too many (a root was
depth 1, not 0 as `cleo add` counts it), so a legal move to a subtask's depth
was refused.
