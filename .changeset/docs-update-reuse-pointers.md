---
id: docs-update-reuse-pointers
tasks: [T14584]
kind: fix
summary: "Preserve incoming document lineage when updates reuse retired content and suppress yielded version rows and neighbour warnings"
---

Docs update and add share the same incoming supersession protection before
reassigning a content row, with an actionable refusal for live or ambiguous
ownership. The refusal code and recovery fix survive the dispatch envelope.
Updates to a doc's own historical bytes keep its live row, preserving other
incoming pointers. Migration and listing omit yielded version rows before and
after adoption, including the migration run by upgrade; the manual ADR backfill
uses the same transactional reuse guard. Provenance graph traversal warns only
for a legacy root, keeping neighbour resolution quiet.
