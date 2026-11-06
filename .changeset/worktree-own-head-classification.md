---
id: worktree-own-head-classification
tasks: [T14236]
kind: fix
summary: "cleo worktree list/prune classify each worktree by its own HEAD; a fresh or detached worktree is never merged, and fix/test/chore branches name their task (T14236)"
---

Worktree classification could offer live work to `cleo worktree prune
--orphaned --yes`:

- A detached worktree reported branch `HEAD`, and its last activity and merge
  test ran from the project root, so they read the primary checkout's HEAD. A
  detached worktree carrying unmerged commits could be classified `merged`.
- A freshly provisioned branch with no commits is an ancestor of main, so it
  counted as `merged`.
- Only `task/` and `feat/` branches named a task, so `fix/` and `test/`
  worktrees never got a task id.

Each worktree's own HEAD (from `git worktree list --porcelain`) now drives its
last activity and merge test. A worktree is `merged` only when its HEAD is
reachable from main and is not a commit on main's first-parent line, so it had
commits of its own that were merged; a fresh branch, or a detached checkout of
a main commit, stays active. Fast-forwarded branches are therefore kept, the
safe side. `fix/`, `test/` and `chore/` branches, and a `T####[-slug]`
directory, now name their task.
