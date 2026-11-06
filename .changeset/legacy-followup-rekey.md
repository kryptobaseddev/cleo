---
id: legacy-followup-rekey
tasks: [T14324]
kind: fix
summary: "cleo doctor malformed-ids re-keys task rows with out-of-grammar ids (legacy T-RECONCILE-FOLLOWUP-*, T932EP) to T#### through the sync re-mint path instead of deleting them"
---

Stores that ran a release reconcile before T14271 hold follow-up tasks with
ids like `T-RECONCILE-FOLLOWUP-v2026.5.63-6`, which `cleo show` rejects.

- A row whose id is outside the task grammar but identifier-shaped is a task
  when it is a legacy follow-up, or has a real title (not the synthetic
  `Task <id>`), a description, acceptance criteria or a relation. Such a row
  is re-keyed, never deleted. A row with none of that (the T12128 path row) is
  still deleted by `--fix` only when nothing references it.
- `cleo doctor malformed-ids` (and the new `--dry-run`) lists each such row
  with the `T####` it would take, and writes nothing.
- `--fix` takes a required-mode snapshot first (and refuses without one),
  then re-keys each row through `remintDisplayKey`, the re-mint the sync
  journal runs: the rename and every reference are journaled, the old id
  stays a display-id alias, and another device follows the rename instead of
  keeping a second row. One receipt per row goes to
  `.cleo/audit/malformed-id-rekey.jsonl`.
- `remintDisplayKey` takes an optional alias reason, a null origin, and a
  null stream (every staged stream, for a local re-key); a named stream
  behaves as before.
- New reconcile follow-ups carry one acceptance criterion and sit under the
  original task's epic.
