---
id: train-merge-task-link
tasks: [T14164]
kind: fix
summary: "pr: and ci: evidence link a train PR to a task through a merge commit that names it, crediting only that merge's change"
---

A task whose work reached the default branch only through a release or
train PR, with no component PR, is named only in a merge commit the train
carries (for example `merge: T2206 … @<sha> into release candidate v7`).
`pr:<n>` and `ci:<n>` were refused with "PR #<n> does not establish a
relationship to task <id>".

When the PR does not name the task itself, CLEO now looks for merges on the
PR whose subject names the task, or whose second parent's subject does. The
PR links to the task through them, and the change credited is those merges'
own first-parent diff that the landing commit still carries, never the whole
train's files.

Also fixed: a component merge's change was read with `git diff-tree -m
--first-parent`, which lists a merge's diff against every parent, so a merge
of a branch cut from older history credited files only the other side
lacked. It now reads the first-parent diff only (T14166 tracks the same
pattern elsewhere).
