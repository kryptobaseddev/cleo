---
id: affected-scope-nested-checkouts
tasks: [T14052, T14047]
kind: fix
summary: "Affected-package scope ignores files inside nested worktrees and repos, and applies workspace ! exclusions"
---

Untracked files inside a nested git worktree or repository (`.worktrees/x/.npmrc`
under a checkout whose linked worktrees live in the tree) were counted as the
task's own change, so a scoped change became workspace-wide and demanded a full
test run. Git lists a nested checkout it recognises as one `dir/` entry and
descends into one whose `.git` file it cannot resolve; both are now dropped,
along with any path below a directory holding a `.git` file or directory.
Untracked files of the task's own checkout still count as before.

`listWorkspacePackages` now applies `!` exclusions from `pnpm-workspace.yaml`
and `package.json#workspaces`, so a standalone app the workspace excludes is no
longer treated as a workspace package.
