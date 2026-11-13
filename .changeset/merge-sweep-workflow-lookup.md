---
id: merge-sweep-workflow-lookup
tasks: [T14535]
kind: fix
summary: "Merge sweep finds the merge commit's CI run by the required check's workflow, not the check name"
---

The merge sweep looked up the merge commit's run with `gh run list --workflow`
set to the required CHECK name. A repo whose required check `PR checks` is a job
of workflow `CI` got "could not find any workflows named PR checks", which the
sweep read as "no run yet" and waited on forever.

The lookup now uses the `workflow` file of the check's
`release.prRequiredWorkflows` entry (falling back to the check name), and a
"no such workflow" answer from `gh` refuses with the config fix instead of
waiting. Other `gh` failures wait and say the lookup failed.
