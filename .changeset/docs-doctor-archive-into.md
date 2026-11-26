---
id: docs-doctor-archive-into
tasks: [T14651]
kind: fix
summary: "cleo docs doctor --publication <path> --archive-into <slug> repairs a ledger row cleo docs modernize kept"
---
- `cleo docs doctor --only publication-ledger-drift --apply --publication <path>
  --archive-into <slug>` archives the only-held blob of a gone ledger row into a
  named, adopted doc. A merged or deleted mirror has no in-sync sibling row the
  doctor could find its doc by, so its row used to stay forever. The next run
  prunes the row. The row must still be proven gone (committed removal).
- `W_DOCS_MODERNIZE_PUBLICATION_KEPT` now prints that exact command with the
  row's path and the doc its content went to (a `SLUG` placeholder when no doc
  holds it), plus why the archive failed (doc not adopted, or bytes not local).
- An `--archive-into` path with no gone row is refused with
  `E_DOCS_DOCTOR_ARCHIVE_ROW_NOT_FOUND`; a half-given pair with
  `E_DOCS_DOCTOR_ARCHIVE_INTO_INVALID` (checked before the pre-repair backup).
- The named doc may belong to another owner than the row (a merge folds one
  doc's mirror into another's). An alias resolves to the doc's live slug; a
  superseded doc is refused with the successor's command, and an unknown slug
  as `no doc named '<slug>'`.
