---
id: spawn-lifecycle-regression-tests
tasks: [T10872, T10873, T10874]
kind: test
summary: "Regression tests pin the spawn path to the @cleocode/worktree facade and the canonical XDG worktree path"
---

Two core test files guard the worktree refactor (T10853). With the facade
stubbed, `spawnWorktree` (orchestrate spawn) and `createAgentWorktree` (the
branch-lock replacement path) must hand `createWorktree` the task, and core must
never run `git worktree add` itself. With the real facade, both paths create the
worktree at `<cleoHome>/worktrees/<projectHash>/<taskId>/`, registered with git
and recorded as CLEO-provisioned.
