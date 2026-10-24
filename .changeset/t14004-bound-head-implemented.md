---
id: t14004-bound-head-implemented
tasks: [T14004]
kind: fix
summary: A test-run or qa-run bound in another task's checkout is refused as this task's evidence
---

A `test-run:`/`qa-run:` binding records the HEAD it was bound to. That HEAD
must now be related to the task's recorded `implemented` commit: it either
contains that commit, or that commit (a PR's merge commit) contains it. A
run that fits neither is refused at `cleo verify` and again at
`cleo complete`, even when complete runs from the same other checkout. The
check is skipped while no implemented commit is recorded.
