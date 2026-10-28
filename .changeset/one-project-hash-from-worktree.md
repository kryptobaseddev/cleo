---
id: one-project-hash-from-worktree
tasks: [T14126]
kind: fix
summary: "cleo done --plan run inside a task worktree names that worktree, and spawn --resume returns the full worktree environment (T14126)"
---

`computeProjectHash` hashed whatever path it was given, so a command run from
inside a task worktree hashed the worktree path itself. `cleo done --plan`
then named `<cleoHome>/worktrees/<hash of the worktree>/<task>`, a directory
that does not exist, while the spawn that created the worktree used the owning
project's hash. A linked git worktree now hashes as the main checkout that owns
it, so `done --plan`, `spawn --resume` and the worktree registry agree.

The completion integration plan also names the worktree git has registered
for the task (the recomputed path only when there is none), and decides from
the owning project when run from inside the worktree.

`cleo orchestrate spawn --resume` returned a `worktreeEnv` with only the
session and agent ids. It now carries the same variables a fresh worktree
gets: `CLEO_WORKTREE_ROOT`, `CLEO_AGENT_CWD`, `CLEO_WORKTREE_BRANCH`,
`CLEO_PROJECT_HASH`, `CLEO_AGENT_ROLE`, `CLEO_BRANCH_PROTECTION` and the git
shim on `PATH` when it is installed.
