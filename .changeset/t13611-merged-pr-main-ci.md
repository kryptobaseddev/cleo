---
id: t13611-merged-pr-main-ci
tasks: [T13611]
kind: fix
summary: "A merged PR whose own check is stale-red is accepted when its merge commit's CI is green"
---

`pr:` and `ci:` evidence refused a merged PR whose head's last required-check
run was red, even when that run was stale (re-run on an outdated merge ref) and
the merge commit's own CI on the default branch was green. When the PR's
checks are not green, the atom now evaluates the same required checks on the
merge commit's check runs: all green accepts the PR; red, missing or unreadable
keeps the refusal, and the refusal says why the merge commit did not prove it.
