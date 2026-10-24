---
id: t13926-declared-root-worktree
tasks: [T13926]
kind: fix
summary: A declared evidence.gitRoot no longer hides the task's worktree, so a test-run report produced there binds
---

When a project declares `evidence.gitRoot` (or `CLEO_EVIDENCE_GIT_ROOT`)
because its CLEO root parents the git repository, the change set and the
`test-run:` binding always used the declared repo's main checkout. A report
from tests run in a linked worktree of that repository was judged against
the main checkout: its test files fell outside it, and the refusal said the
report "covers no test file". The declared root now names the repository.
The checkout is the invocation's own linked worktree of it, else the task's
`task/<id>` worktree, else the declared checkout.
