---
id: not-found-in-cancelled-run
tasks: [T14144]
kind: fix
summary: "a required check that never ran in a cancelled CI run on the merge commit counts as cancelled, so a later green main run stands in for it"
---

The `ci:` stand-in refused a merge whose CI run was cancelled part-way:
"Contracts Dep Lint: not found on merge commit … only a cancelled or skipped
run is stood in for by a later run". A cancelled run never starts the jobs it
had not reached, so GitHub records no check run for them. Now, when the
pinned workflow's run on the merge commit was cancelled or skipped, a
required check of that workflow that never ran there counts as cancelled.
The nearest later green main push run that contains the merge then stands
in for it, under the same guards as before: no change to the PR's files or
to a CI definition in range. A check that ran and failed is still refused,
as is a check missing from a run that finished any other way.
