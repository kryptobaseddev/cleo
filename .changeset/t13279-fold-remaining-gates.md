---
id: t13279-fold-remaining-gates
tasks: [T13279]
kind: fix
summary: Lockfile Check and the path-scoped native, skills and release-matrix workflows now run inside CI, so they block a merge too; the worktree-napi gate calls its prebuild instead of polling it
---

Following T13263, the remaining standalone checks now run as part of the required `CI`
check:

- **Lockfile Check** runs on every change.
- **Path-scoped checks** run only when the `changes` job sees their paths; a skipped
  check counts as a pass. These are: cant-napi build, worktree-napi prebuild,
  cleo-supervisor smoke, Skills Depth Check and Release Pipeline Matrix.
- **Worktree NAPI Prebuild Gate** now calls the prebuild directly instead of polling and
  approving a standalone run.
- **cleo-supervisor prebuild** stays standalone. It needs `contents: write` to attach
  release assets on tag pushes, which a call from `ci.yml` cannot hold. Its build is
  still covered on pull requests by cleo-supervisor smoke.

`Lockfile Check` is removed from the release evidence config
(`release.prRequiredWorkflows`, `evidence.ciChecks.qa`) and from the owner-once
branch-protection commands. No check ever reported under that name (its job is
`Verify pnpm-lock.yaml consistency`), and `CI` now covers it.

The merge-bar lint allows a workflow called from CI to keep `workflow_dispatch` and
tag-only pushes, but not a second pull_request, merge_group or branch-push run.
