---
id: t13309-bare-strands-reconcile
tasks: [T13309]
kind: feat
summary: doctor superseded-store --reconcile --bare-strands recovers stranded bare rows in a populated cleo.db
---

For a project already running on cleo.db whose own bare legacy tables still hold rows its prefixed tables lack. Plans by default; --apply writes after a VACUUM INTO snapshot, under the exodus lock, and verifies that no live row changed (reverting otherwise). Copies only rows whose key the prefixed table lacks and never overwrites a live row; a bare task whose id a newer task took (T001) is recovered under a new id with its references re-pointed; a row that is, or points at, a task recorded as deleted, or a task that exists nowhere, is skipped and listed. The receipt accounts for each bare table, which lifts the sync refusal for stranded bare rows (T13225). --rollback <run dir> reverts a reconciled run, refusing if any row it inserted has changed. Runs only after the legacy files are reconciled.
