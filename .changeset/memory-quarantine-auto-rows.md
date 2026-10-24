---
id: memory-quarantine-auto-rows
tasks: [T13951]
kind: feat
summary: "`cleo memory quarantine-auto-rows` reversibly quarantines auto-generated BRAIN rows (dispatch traces, Doc attached records, task stubs) in the project and global brains"
---

Owner decision D11179. Dispatch traces, "Doc attached" records and
content-free task stubs were written by machinery, not by anyone recording
knowledge. Recall already ignores them; this command retires them from the
active store by setting `invalid_at` only. Nothing is deleted.

- Default is a dry run: counts per store (project, global) and table, per
  rule, a short digest of the exact id set, and the exact SQL predicates.
- `--apply --expect project:patterns=N,project:observations=N,global:patterns=N,global:observations=N`
  `--expect-digest <digest>` refuses unless every count and the id-set digest
  still match the approved dry run. Each batch re-checks the full predicate,
  so a row verified mid-apply is skipped and recorded in the receipt. A failed
  apply names its receipt path for `--restore`. `--restore` cannot be combined
  with `--apply`, and `--expect` needs `--apply`.
- The receipt (ids per store and table, the `invalid_at` timestamp,
  predicates, counts) is written to `.cleo/backups/quarantine/` before the
  first write; rows change in batches through the canonical accessors.
- `--restore <receipt>` clears `invalid_at` only where it still equals the
  receipt's timestamp; it is idempotent and works on a receipt an interrupted
  apply left `started`.
- Verified rows and a human note titled "Doc attached: ..." without the
  writer's payload are never matched.
