---
id: evidence-tree-one-resolver
tasks: [T14058]
kind: fix
summary: "Typed gates and change-set binding resolve the evidence tree through one resolver; the invocation's worktree of the declared repo wins"
---

Typed-gate execution (`resolveTypedGateRoot`) and change-set binding
(`resolveChangeSetRoot`) chose their trees separately and disagreed: with the
evidence root declared as a separate clean verification worktree and `cleo`
run from it, binding swapped to the task's `task/<id>` worktree, and with the
main checkout declared and `cleo` run from a linked worktree, typed gates ran
in the main checkout. No single invocation kept both in one checkout.

Both now call `resolveEvidenceTree`. With a declaration, the invocation's own
linked worktree of the declared repository wins, then a declared linked
worktree, then the task's `task/<id>` worktree (invoked from the main
checkout, T13926 kept), then the declared tree. Typed gates still accept only
this project's checkouts. `cleo verify` reports the chosen root and its
source as `evidenceRoot` when it stores evidence.
