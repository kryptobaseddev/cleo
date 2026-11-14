---
id: docs-update-reuse-pointers
tasks: [T14584]
kind: fix
summary: "Preserve incoming document lineage when updates reuse retired content and suppress yielded version rows and neighbour warnings"
---

Docs update and add share the same incoming supersession protection before
reassigning a content row, with an actionable refusal for live or ambiguous
ownership. Wikilinks omit yielded version rows, and provenance graph traversal
warns only for a legacy root, keeping neighbour resolution quiet.
