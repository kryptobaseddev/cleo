---
id: modernize-delete-without-survivor
tasks: [T14212]
kind: fix
summary: "cleo docs modernize accepts a delete override with no survivor: the doc is stored under its own slug and removed, with no supersede edge"
---

A `delete` override may now omit `target` or set it to `null`, as
`DocsModernizeRow.target` already documented ("the survivor's slug, or null
when there is none"). The plan row carries `target: null`; apply stores the
doc under its own slug, removes the file and records no supersession. A
`delete` that names a target, and every `merge-into`, must still name a
survivor in the plan, and a delete with a survivor still writes the
supersede edge.
