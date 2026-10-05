---
id: t13141-bump-pr-version-only
tasks: [T13141]
kind: chore
summary: The release bump-PR's dispatched CI runs the version-only set instead of the whole suite
---

The bump-PR's `pull_request` runs come back `action_required` (they are created by GITHUB_TOKEN), so
its only CI is the `workflow_dispatch` run that release-prepare starts on `release/v*`. CI ran the
version-only detector for pull requests only, so that run took the whole ~22 min suite for one-line
version bumps. The `changes` job now runs the detector on a `release/v*` dispatch too, diffing the
branch against its merge-base with the default branch. A bump-only diff skips the heavy jobs, while
lint, typecheck and the Lockfile Check still run. Any other change, a failed fetch or no merge-base
runs everything. The merge-queue runbook is updated: the admin merge still requires that run to be
green on the exact head.
