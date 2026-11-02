---
id: done-plan-records-profile
tasks: [T14180]
kind: fix
summary: "cleo done --plan names a code-class task's attached documents and linked decisions and the gate profile that makes them count"
---

A task with no PR, branch or commit that is classed as code (kind work,
no gate profile) had its attached documents and linked decisions ignored,
and `cleo done --plan` told it to "attach its record or link a decision",
which it already had (T14175, a live-data repair).

The planner now finds those records for a code-class task too, lists them
on the change set, and its no-change-set blocker says why they do not
prove a code task and gives the remedy: `cleo update <id> --add-labels
profile:ops` (or profile:decision, profile:census, profile:audit, T13474).
With the profile, the same records plan `implemented` as `decision:<id>`
with its document, and no test, lint or typecheck is owed. A code-class
task is never closed on a decision alone.
