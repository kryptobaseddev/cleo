---
id: t10160-doc-body-schema
tasks: [T10160]
kind: feat
summary: doc body schema validation per DocKind (requiredSections[]) with --strict gate — absorbs T10154
---

Adds requiredSections[] to DocKindMetadata in the canonical doc-kind taxonomy. Built-in kinds adr/spec/research/handoff/release-note/plan/rcasd ship with sensible defaults; note/llm-readme/changeset have empty arrays (no schema). New validateDocBody(kind, body) parses H2 sections (case-insensitive, hyphen/space tolerant). Wired into cleo docs add as advisory by default; --strict flag fails the write with E_DOC_SCHEMA_MISMATCH and details.missing. Extensions in .cleo/docs-config.json can declare their own requiredSections. Saga T9855 / E12 (T10157).
