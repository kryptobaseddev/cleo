---
id: ci-evidence-runner-cancel-identity
tasks: [T14049, T13017, T14042]
kind: fix
summary: "ci: evidence treats a runner-cancelled job as cancelled, judges a run with incomplete app/workflow identity as pending, and leads its refusal with the decisive reason"
---

`cleo verify --evidence ci:<pr>` blamed the PR for a merge-commit CI failure
that was only a runner cancellation (run 40216344634: the Build job ended
"The operation was canceled.", GitHub reported the job and CI as `failure`).
A failing job whose log shows only GitHub's cancellation errors and no failed
test is now a cancelled verdict, so a later green main run stands in, and the
refusal never says the PR introduced it.

A check run that GitHub returned without the app or workflow its pin names
(a job listed before its workflow run) is no longer reported as posted by a
foreign app: the checks are fetched once more, and a run still incomplete is
judged pending. A genuine mismatch still refuses, showing both values.

The CI refusal now starts with the failing check and the next step (or, for a
PR that edits a pinned workflow, the wait instruction), with the detail after.
