---
id: dedupe-change-set-files
tasks: [T14040]
kind: fix
summary: "cleo done --plan lists each changed path once for a merge commit"
---

`git diff-tree -m` lists a merge commit's diff against every parent, so a
path that both sides of a true merge changed appeared twice in
`changeSet.files` and in the `files:` of `implementedEvidence` (escapeplan
T740 listed `app.css` twice). The name-status parser now keeps each kept and
deleted path once.
