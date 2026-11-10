---
id: ci-current-head-stand-in-scoped
tasks: [T14434, T14433]
kind: feat
summary: "ci:<pr> accepts green required CI on the current default-branch HEAD for a scoped change whose merge-commit run failed or was cancelled for a reason that is not the PR's"
---

A merged PR whose merge-commit CI run on main failed for an infra reason, or
was cancelled, could only be stood in for by one of the next 20 main commits,
and never past a later red commit or a change to `ci.yml`. CI definitions
change often, so such tasks had no supported way to close.

Owner decision D11241 extends D11192 to every change. A green `push` run of
every required check, and of the gates' jobs, on the default branch's current
HEAD now stands in for a scoped change too, when:

- the merge commit's run is not the PR's failure (cancelled or skipped,
  inherited from main, red only on the flaky-quarantine budget, or failed with
  no test run);
- the PR's final head had green `pull_request` CI;
- every hunk the PR added is still present at the stand-in commit.

A failure that is the PR's, a red PR head or a rewritten hunk still refuses.
The stand-in runs today's CI definition: a later change that weakens a check
also releases the tasks waiting behind it, which the owner accepted. The atom
records `currentHead`, and `cleo complete` re-checks the HEAD run and the PR
head run.

Refusal texts were corrected:

- a `ci:` refusal ends its first line with what closes the task: wait for a
  green HEAD run, or record a targeted test-run and qa-run on the default
  branch. It no longer says "wait for it to finish" for a failed run because
  another required check never started.
- the merge sweep keeps a failed merge waiting while a green HEAD run will
  stand in, and otherwise names the `cleo verify` and `cleo complete` commands.
  It no longer points at `cleo done --plan`, which offered the refused
  `ci:<pr>` again.
- the sweep no longer says reruns are off "until T14136", which shipped.
  Reruns stay opt-in (`CLEO_MERGE_SWEEP_RERUN=1`).
