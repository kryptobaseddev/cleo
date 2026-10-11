---
id: t13495-scoped-run-carries-merge
tasks: [T13495]
kind: fix
summary: a tree-pinned scoped testsPassed (targeted test-run or affected tool run) still stands after the merge when the change's files are byte-identical at the merge commit; otherwise done --plan and complete say why it does not carry
---

After a PR merged, `cleo done --plan` and `cleo complete` dropped a scoped
`testsPassed` (a targeted `test-run:` report or an affected `tool:test` run),
even at the exact recorded tree, and proposed a whole-suite `tool:test`.

- A scoped result now still stands after the merge when it is pinned to a tree
  whose copy of every file the change touched (added, edited or deleted)
  equals the merge commit's. The merged change is then exactly the change the
  scoped run tested. Other PRs that landed on main in between do not matter.
- Otherwise the reason says why it does not carry: the files differ at the
  merge commit, the result has no recorded tree, or the merge commit is not
  known. It names the supported paths: `ci:<pr>` (with `evidence.ciSatisfies`)
  or `tool:test`.

One shared function decides this for `cleo done --plan` and `cleo complete`.
