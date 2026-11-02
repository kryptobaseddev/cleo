---
id: docs-doctor-scoped-apply
tasks: [T14174]
kind: feat
summary: "cleo docs doctor --only <class> scopes the repair plan and --apply to chosen repair classes, and reports per-class counts"
---

`cleo docs doctor --apply` ran every repair class at once. On this repo the
dry run planned 507 repairs across six classes. That meant a task that owns
one class, such as the publication-ledger prune (T14117), could not apply just
that class to the live shared store.

- `--only <class,…>` scopes the plan, and with `--apply` the writes, to the
  named repair classes. The classes are `dangling-pointers`,
  `doc-version-skew`, `empty-provenance`, `wikilinks-drift`,
  `legacy-blob-coverage`, `conduit-history-gaps` and
  `publication-ledger-drift`. Every other class is left untouched, while
  diagnostics still report all classes. The wikilinks rebuild also runs for
  `empty-provenance`, because a provenance backfill changes the derived edges.
- The automatic backup is still taken before any scoped apply.
- The report gains `repairCounts`, the planned and applied repairs per class,
  and `only`, the classes a run was scoped to.
- An unknown class is refused with `E_DOCS_DOCTOR_UNKNOWN_CLASS` and the list
  of valid classes. `--only` with `--repair` is refused; use
  `--apply --only legacy-blob-coverage` instead.
