---
id: legacy-followup-rekey
tasks: [T14324]
kind: fix
summary: "cleo doctor malformed-ids re-keys legacy T-RECONCILE-FOLLOWUP-* tasks to T#### through the sync re-mint path, keeping the old id as an alias"
---

Stores that ran a release reconcile before T14271 hold follow-up tasks with
ids like `T-RECONCILE-FOLLOWUP-v2026.5.63-6`, which `cleo show` rejects.

- `cleo doctor malformed-ids` (and the new `--dry-run`) lists each such row
  with the `T####` it would take, and writes nothing.
- `--fix` takes a required-mode snapshot first (and refuses without one),
  then re-keys each row through `remintDisplayKey`, the re-mint the sync
  journal runs: the rename and every reference are journaled, the old id
  stays a display-id alias, and another device follows the rename instead of
  keeping a second row. One receipt per row goes to
  `.cleo/audit/followup-rekey.jsonl`.
- `remintDisplayKey` takes an optional alias reason, a null origin, and a
  null stream (every staged stream, for a local re-key); a named stream
  behaves as before.
- New reconcile follow-ups carry one acceptance criterion and sit under the
  original task's epic.
