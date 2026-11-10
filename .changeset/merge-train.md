---
id: merge-train
tasks: [T14371]
kind: feat
summary: "cleo merge train merges each open PR that is green on its exact head, reviewed per AC and whose Closes: lines resolve, one at a time, then runs the merge sweep; dry run by default, --execute merges"
---

`cleo merge train` works in any project with a GitHub remote. For each open
PR it prints merge or skip with the reason. With `--execute` it merges pinned
to the reviewed head (`--match-head-commit`), reruns failed jobs of an
infra-only red (runner shutdown or cancel) at most 3 times per head, reports a
real red once per head, holds every PR while main's latest push run is red
(except one labelled `main-fix`), honours `Merge-After: #<n>`, and runs the
merge sweep once the merge commit has a completed push run. One train runs
per repository; a train that stops reports it.
