---
id: impl-commits-in-tested-tree
tasks: [T13003]
kind: fix
summary: "tool: runs are judged against the task's implemented commits like test-run reports, and a rebased copy of a commit counts"
---

`testsPassed` could be satisfied by a `tool:test` run on a checkout that
lacked the task's fix commit: only `test-run:`/`qa-run:` results recorded the
HEAD they were bound to (T14004). A `tool:` atom now records the HEAD it
measured (`headSha`, next to its `treeHash`), and verify and complete refuse
it when that HEAD never saw the task's `implemented` commits, the same way.

A run on a rebased checkout was refused too, because the implemented commit's
SHA changed. A HEAD that carries a patch-equivalent commit (`git cherry`: a
rebase, a cherry-pick or a message-only amend) now counts as having seen it.
A commit whose patch changed still asks for implemented to be re-recorded.
Tool atoms recorded before this change carry no `headSha` and are not judged.
