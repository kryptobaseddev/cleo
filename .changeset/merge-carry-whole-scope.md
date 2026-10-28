---
id: merge-carry-whole-scope
tasks: [T14071]
kind: fix
summary: "A pre-merge scoped run carries across the merge only while its whole scope is unchanged (D11205)"
---

A tree-pinned scoped run recorded before merge (`test-run:`, `qa-run:`,
`tool:test-affected`) carried across the merge when the change's own files were
byte-identical at the merge commit (T13495). Another PR landing in between could
still change what the run tested: a dependent package it ran, a test file, the
lockfile or a root config. Per owner decision D11205 (amends D11150), the carry
now compares the run's whole scope between the tree it tested and the merge
commit, using the same per-result scope as the earlier-tree check (T13784): a
test-run's change, test files and their test inputs; a qa-run's roots, the
change and the shared tool configs; a `tool:test-affected` run's change, tested
package directories and test inputs. When the scope moved, the refusal names
the first changed file and the routes that still prove the change: a test-run
on the default branch after the merge that covers it (T13673), or `tool:test`.
Projects with `evidence.ciSatisfies` still record merged CI as before.
