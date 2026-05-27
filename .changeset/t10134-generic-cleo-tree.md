---
id: t10134-generic-cleo-tree
tasks: [T10134]
kind: feat
summary: "B9 generic cleo tree — walks parent + groups edges to full depth, KindIcon + ⊂ relation prefix"
prs: [563]
---

`cleo tree <id>` now walks BOTH `parent_id` AND
`task_relations.relation_type='groups'` edges from any root, recursively
to full depth. `cleo tree T9855` shows all 12 saga members + their
subtree (109 nodes total), not just 2 parent-edge children. Shows
ancestor chain upward from the root for context. `KindIcon` prefix
(🌲/📋/•/◦) per node; `RelationIcon.GROUPS` (⊂) prefix for
saga-membership edges. Derives from typed `TreeResponse<T>` (B1.1) and
uses the `renderTree` primitive from `@cleocode/animations/render` (B3).
Removes `--root`/`--depth`/`--kinds` flags; preserves
`--withDeps`/`--blockers`.
