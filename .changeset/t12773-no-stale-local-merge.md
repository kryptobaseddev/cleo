---
id: t12773-no-stale-local-merge
tasks: [T12773]
kind: fix
summary: cleo done/complete no longer creates a local "merge task/<id>" commit when the task already landed upstream or local main is behind origin
---

Completing a task that had an agent worktree ran the ADR-062 integration
(`git checkout <default>` + `git merge --no-ff task/<id>`) in the project
checkout, even when the task's PR had already merged on origin. From a local
`main` 199 commits behind `origin/main`, `cleo done --pr 1706` created a merge
commit that forked local `main` from origin.

`completeAgentWorktreeViaMerge` now checks `origin/<default>` first
(`assessUpstreamIntegration`):

- task branch already on origin (ancestor, or its changes fully contained,
  e.g. a squash merge): no merge; the checked-out default branch is
  fast-forwarded to origin only when that is a clean fast-forward, otherwise a
  hint names the `git merge --ff-only` to run. The result carries
  `landedUpstream: true` and a clean worktree is pruned.
- local default branch behind origin: the merge is refused with a hint, and
  the worktree and branch are kept.
- no remote, or a current default branch: the local integration runs as before.
