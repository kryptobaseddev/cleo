---
id: sweep-directive-verdict-linkage
tasks: [T14259]
kind: feat
summary: "the merge sweep links a PR to a task by its Closes or Refs line plus non-author verdicts, and a verdict binds the criterion text it judged"
---

Two gaps in ADR-099's merge closure are closed.

A verdict now stores `acTextSha256`, the sha256 of the criterion's text as
the review packet showed it (whitespace collapsed, ends trimmed; the packet
shows that form too). When the criterion is edited after the verdict, the
sweep and `cleo review check` report the verdict as `edited` and it no
longer counts. A whitespace-only rewrite changes nothing, and verdicts
recorded before this change carry no hash and are judged as before.

On the merge sweep's path only, a `pr:` or `ci:<pr>` atom now links to a
task when the PR's body names it on a `Closes:`/`Refs:` line and a
non-author `met` verdict covers every criterion that line names on the PR
head. The task-id mention, the declared-files intersection and the
names-a-file credit rule no longer apply there, so a child task its parent's
PR delivers (the #1062/T11791 shape) closes. `cleo done --pr` keeps the
older checks.
