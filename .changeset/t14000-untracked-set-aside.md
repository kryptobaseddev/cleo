---
id: t14000-untracked-set-aside
tasks: [T14000]
kind: fix
summary: test-run and qa-run bindings set aside untracked files outside the change, and refuse at complete once one is committed
---

A shared dirty checkout no longer makes `cleo verify` refuse a test-run or
qa-run that `cleo done --plan` asked for. An untracked file outside every
directory the change touches is another agent's work. It is now set aside
instead of judged as the change, and the atom records it as
`untrackedSetAside`. An untracked file inside a directory the change touches
still counts.

The tree hash includes untracked files, so committing one moves nothing the
tree check sees. `cleo complete` and `cleo done --plan` (the superseded check)
now refuse the run as stale once any set-aside file is tracked. This keeps
the review-of-#2302 guarantee.
