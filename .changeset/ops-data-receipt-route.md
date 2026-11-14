---
id: ops-data-receipt-route
tasks: [T14557]
kind: fix
summary: "An ops task's data receipt is refused with its supported route, not a silent base-requirement list"
---

A gate-profiled task (`profile:ops`, `profile:census`, `profile:audit`) proves
`implemented` with its stored document and a note only while every `files:`
path is a document. Citing a raw data receipt (an HTTP readback JSON under
`.capture/`) set the profile aside silently: `cleo verify` listed only the
base combinations, as if the plan's shape had been refused, and once a
decision was added `cleo complete` refused with "a code change owes its
tests".

Both refusals, and `cleo update --add-labels profile:*`, now name the file
that set the profile aside and, for a data receipt, the supported route:
attach it with `cleo docs add <task> <path>`, then record `implemented` again
from `cleo done <task> --plan`, which cites its hash-checked
`.cleo/attachments/` copy and keeps the task non-code. A regression test
records the planned shape for an ops task through the real verify path and
closes one with a decision, a canonical document and a JSON receipt.
