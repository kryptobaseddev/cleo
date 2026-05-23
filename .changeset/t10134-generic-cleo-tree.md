---
"@cleocode/cleo": minor
"@cleocode/core": minor
"@cleocode/animations": patch
---

feat(T10134): generic `cleo tree <id>` — walks parent + groups edges to full depth, KindIcon + RelationIcon prefixes (B9)

`cleo tree T9855` now shows the full saga membership tree (12 members + their subtrees), not just the 2 parent-edge children. Walks `task_relations.relation_type='groups'` AND `parent_id` edges recursively to full depth. Shows ancestor chain upward from root. KindIcon (🌲/📋/•/◦) before each node, RelationIcon.GROUPS (⊂) prefix on saga members. Derives from typed `TreeResponse<T>` contract; uses `renderTree` primitive from `@cleocode/animations/render`. NO `--root`/`--depth`/`--kinds` flags. `--withDeps` and `--blockers` preserved.

Closes T10134. Epic: T10114. ADR: adr-077-human-render-contract.
