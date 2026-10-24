---
id: project-lesson-dedup
tasks: [T13989]
kind: fix
summary: "A project-scope lesson is no longer merged into a plain observation with the same text"
---

`cleo memory observe --type lesson --scope project` used to be merged into an
existing plain observation with the same text. The project extraction gate's
content-hash dedup ignored the observation type, so the lesson was never stored
and `cleo memory lessons --scope project` never listed it.

The project gate now treats the type as the main brain does (T13988):

- A lesson deduplicates only against lessons, so an identical lesson still
  merges.
- Any other observation deduplicates only against non-lessons, so plain
  observations and lessons never merge into each other.
