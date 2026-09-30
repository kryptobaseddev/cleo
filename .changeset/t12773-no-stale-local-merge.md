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
(`assessUpstreamIntegration`). The check never creates a commit and never
moves the operator's checkout — syncing is hint-only:

- task branch already on origin (ancestor, or its changes fully contained,
  e.g. a squash merge): no merge. The result carries `landedUpstream: true`,
  and when local `<default>` is behind, `syncCommand` / `hint` name the exact
  `git merge --ff-only origin/<default>` to run. A clean worktree is pruned.
- task branch with no commits beyond local `<default>`: `nothingToIntegrate`,
  not reported as landed.
- local default branch behind origin: the merge is refused (`staleTarget:
  true`) and the worktree and branch are kept. When local `<default>` also has
  unpushed commits (diverged), the hint says to `git pull --rebase origin
  <default>` first. `cleo orchestrate worktree-complete` reports its own
  recovery steps for this case instead of the rebase/`--resolve` ones.
- no remote, or a current default branch: the local integration runs as before.

The upstream fetch is non-interactive (`GIT_TERMINAL_PROMPT=0`, ssh
`BatchMode`) and bounded to 20s; offline, the last-known `origin/<default>` is
used. The Rust integration no longer fetches a second time.
