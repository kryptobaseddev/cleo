---
id: pr-declares-task
tasks: [T14087]
kind: fix
summary: "done --plan no longer takes a merged PR that only mentions a task as that task's implementation"
---

`cleo done <id> --plan` derived a task's change set from any merged PR whose
title, body or branch named the id, so a PR that merely listed the task as a
case it unblocks (#2191 for T13287) became its implementation and `ci:<pr>`
was planned from it. A PR now counts when its title or branch names the task,
a body line declares it (`Closes`/`Fixes`/`Resolves`/`Implements`/`Task:`), a
changeset it adds lists it in `tasks:`, or it cites one of the task's done
children (T13785). A mention-only PR is dropped with a warning naming it and
the `--pr` route; an explicit `--pr` keeps the existing linkage check.
