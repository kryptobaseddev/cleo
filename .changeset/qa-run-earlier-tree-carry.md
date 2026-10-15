---
id: qa-run-earlier-tree-carry
tasks: [T13644]
kind: fix
summary: A qa-run receipt recorded on an earlier tree carries while the files it checked are byte-identical; a refusal names the checked paths that changed
---

`cleo done --plan` and `cleo complete` refused every `qa-run:` receipt as soon
as the whole tree moved, before comparing anything, so an unrelated later
commit (a docs edit, another PR on main) voided a typecheck or lint receipt
whose checked files never changed. The refusal named no file.

The moved-tree check now compares the receipt's checked `roots` between the
tree it ran on and the current tree with `git diff`, the comparison scoped runs
carry across a merge by. Identical: the receipt stands, and the existing
after-merge rules (byte-identical carry, or the later-main stand-in) still
apply. Different: the refusal lists the checked paths that differ. When git
cannot compare the trees, it refuses as before.
