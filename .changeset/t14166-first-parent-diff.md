---
id: t14166-first-parent-diff
tasks: [T14166]
kind: fix
summary: "A merge of a branch cut from older history no longer credits a task with what the base gained after the cut: change sets, carry scope, own-work paths and commit: atoms read the merge's first-parent diff only"
---

`git diff-tree -m --first-parent <merge>` prints the merge's diff against
EVERY parent: `--first-parent` limits a revision walk, not diff-tree. A merge
of a branch cut from older history therefore also listed every file the base
changed after the cut. The PR change set, the scoped-run carry scope, a
task's own-work paths, a `commit:` atom's files and a component commit's
paths now use `--diff-merges=first-parent` (git 2.31+), which lists the
first-parent diff alone.

New git floor: `--diff-merges` needs git 2.31 or later, so `cleo doctor`'s
git check now reports git below 2.31 as unhealthy, with an upgrade fix.
