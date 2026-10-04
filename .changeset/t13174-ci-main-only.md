---
id: t13174-ci-main-only
tasks: [T13174]
kind: fix
summary: A merged PR that edits a CI workflow is attested by main's push CI; cleo done no longer plans a local whole-suite run for it
---

A PR that edits a pinned workflow file cannot vouch for itself: its own
`pull_request` runs executed the edited workflow. `ci:<pr>` used to refuse it
outright and tell the agent to record local results, so `cleo done` planned a
whole-workspace `tool:test` plus `tool:lint` and `tool:typecheck`, which is the
redundant local run the P0 fix removes.

Such a PR is now attested by default-branch `push` runs only: the merge
commit's, or a later main commit's under the existing stand-in rule (the
merge-commit run was cancelled or skipped, nothing in between touched the PR's
files or a CI definition, the first decisive candidate decides). The PR's own
runs, including a tree-equal head, are never consulted, so the atom records
`mainOnly` and no PR head, and `cleo complete` re-checks only the main run. A
run whose required jobs were skipped or cancelled still never counts. Until
main's push run finishes, `ci:<pr>` refuses with a message naming the merge
commit and saying to wait; `cleo done` plans `ci:<pr>` for these PRs and never
falls back to a local whole-suite run.
