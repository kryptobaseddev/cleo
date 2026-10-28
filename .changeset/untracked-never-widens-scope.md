---
id: untracked-never-widens-scope
tasks: [T14125]
kind: fix
summary: "Behaviour change: an untracked file no longer counts as part of a task's change; stage it (git add, or git add -N) to make it count (T14125)"
---

`cleo done --plan` counted every untracked file in the checkout as part of the
change, so pre-existing stubs such as `.worktrees/<name>/.npmrc` (no nested
`.git`) sat outside every package and demanded the whole suite.

A task's change is now its commits against the default branch plus its
uncommitted tracked edits, including staged and `git add -N` intent-to-add
files. Every other untracked file is set aside on every evidence path: the
plan names them under `untrackedSetAside` with a warning, test-run, qa-run and
scoped `tool:test`/`tool:test-affected` results record them, and
`cleo complete` refuses such a result once one of them is committed.

Behaviour change: a new test file the task wrote counts only once staged. A
run recorded while it was untracked is refused after it is committed, and the
refusal says to stage it (or `git add -N` it) and re-run. This replaces the
T14052 and T14000 rules, under which an untracked file counted (T14000: when
it sat in a directory the change touched).
