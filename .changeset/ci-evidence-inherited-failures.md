---
id: ci-evidence-inherited-failures
tasks: [T13453]
kind: fix
summary: ci evidence accepts a green later main run when the merge commit only inherited main's failures; workflow-file changes have a covering rule
---

A PR that merged while main was red could never close its tasks with
`ci:<pr>`. Its merge commit's own run failed on the shared breakage, and a
later green main run could stand in only for a cancelled or skipped run.

Now a later green main run may also stand in for a FAILED merge-commit run,
but only when every failing job had already failed on the nearest decided
first-parent ancestor (cancelled, skipped and missing ancestor runs are looked
past, up to 10 commits). That shows the PR introduced no failure of its own.

The atom records `inheritedFailures`: each job's failing merge-commit run id,
the ancestor it inherited from and that ancestor's run id. `cleo complete`
re-checks that each ancestor run is still red. A job that passed on its base
was introduced by the PR and is still refused. All the existing stand-in
conditions still hold: the PR head's own CI was green, and no later commit
touched the PR's files or a CI definition.

`evidence.ciChecks.covering` also maps `.github/workflows/**` to the jobs that
check workflow files: Deployed Template Parity, Injection Command Existence
and Merge-Bar Aggregate Gate Lint.
