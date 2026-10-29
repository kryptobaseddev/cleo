---
id: docs-modernize-store
tasks: [T14118]
kind: feat
summary: "cleo docs modernize --store re-kinds and re-slugs the docs already in the store, keeps every old slug resolvable as an alias, and renumbers colliding ADRs, with a receipt and rollback"
---

`cleo docs modernize --store` works on the store instead of a folder:

- **Kind.** Untyped rows, and rows the legacy `docs import` typed `spec`
  wholesale, are re-classified with the same rules as tree mode. System One
  judges the unsure ones, up to 200 asks per run.
- **Slug.** A slug carrying task, session or date tokens gets its stable slug.
  The old slug becomes an alias in `conduit_doc_slug_aliases`, so
  `cleo docs fetch <old-slug>` and the ADR decision links still resolve. Task
  ids the old slug named become task refs on the doc.
- **ADR numbers.** When several ADRs share a number, the earliest keeps it and
  each later one is renumbered past the highest number in use. The old slug
  stays as an alias.

The new `renameDocSlug` primitive is the core of this: it adopts the doc into
the conduit family, moves the live slug and records the alias. The receipt
records `rekind`, `reslug` and `link-task` ops and `durationMs`, and
`--rollback <runId>` reverses them.
