---
id: goal-close-commit
tasks: [T13794, T13796]
kind: fix
summary: "cleo goal close completes landed work from the run's head commit; the Stop dispatcher's goal-workspace search stops at the repository"
---

When a goal's work landed on the default branch with no PR, task branch or
document citing a task, `cleo goal close` now completes that task through
`cleo done --commit <headCommit>` (T13799). It does so only when the head
commit has landed and nothing else gives the task a change set. Otherwise the
done path derives the change set as before.

The `--commit` help text now says that a declared directory accepts any commit
under it, and that a glob ties a commit to the task only through its message.

The Stop dispatcher looks for `.opencode/goals/` only up to the repository: the
git top level, or the first directory holding `.git` or `.cleo`. A stray
`~/.opencode/goals` no longer turns the tick on for every project under it.
