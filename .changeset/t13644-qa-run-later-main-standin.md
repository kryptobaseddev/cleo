---
id: t13644-qa-run-later-main-standin
tasks: [T13644]
kind: fix
summary: "qa-run receipts recorded on a main HEAD after the merge, on the current tree and covering the change, stand in for qaPassed whatever the merge CI concluded (the T13673 rule, now for qaPassed)"
---

After a merge, a `qaPassed` that rests on qa-run receipts alone is judged
the way testsPassed is: the receipts carry when the change's files merged
byte for byte, or stand in when recorded on a main HEAD descending from the
merge (and landed on origin's default branch), on the current tree, with a
typecheck and a lint whose roots cover the change. Otherwise `cleo complete`
and `cleo done --plan` say why, and merged CI (`ci:<pr>`) records the gate as
before. A whole-project `tool:` run or `ci:<pr>` in the gate is not re-judged.
