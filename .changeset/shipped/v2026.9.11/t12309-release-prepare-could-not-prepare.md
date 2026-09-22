---
id: t12309-release-prepare-could-not-prepare
tasks: [T12309]
kind: fix
summary: The release pipeline can prepare a release, and says so before spending a preflight on one it cannot
---

Dispatching a release preparation no longer defaults to a mode that cannot succeed. The workflow resolves the release plan from a committed plan file, which the dispatching verb now produces and verifies on the branch the workflow will check out. The alternative — rebuilding the plan on the runner — cannot resolve a task or epic scope there, because the task store is deliberately absent from version control, so it is an explicit opt-out rather than the default.

A dispatch that cannot succeed is rejected in seconds by a precondition job that runs before any preflight, naming the input that is missing and the command that supplies it. Previously the same failure arrived after lint, typecheck, two test shards and a build had all completed, so the full cost of an impossible dispatch was paid before its impossibility was visible.

The preflight test step is allotted the same budget as the equivalent continuous-integration job, and its enclosing job is allotted more than the step, so a slow suite is reported as a slow suite rather than pre-empted by the job ceiling. The release runbook states that the plan must be committed and pushed, what the opt-out is for, and why the runner cannot rebuild one.

Two test suites that drive real subprocesses — a process-group cancellation and a package-inventory command — no longer race default timeouts written for in-process assertions. Both failed on loaded machines while passing everywhere else, and a timing flake is indistinguishable from a defect in a log.

Code placed in packages/core/ for the release engine and packages/cleo/ for thin dispatch per Package-Boundary Check — verified against AGENTS.md.
