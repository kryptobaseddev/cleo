---
id: t12341-row-uids
tasks: [T12341]
kind: feat
summary: Task-graph rows carry a uid (UUIDv7) as their merge key, filled deterministically for existing rows; an edited acceptance criterion keeps its uid, so its evidence bindings follow it; a colliding T#### can be re-minted with an alias that keeps the old id resolving
---

**Row uids (T12341, spec `t12341-uid-scheme`).** `T####` stays the id people
and agents type, but it is allocated locally, so two offline stores can hand
out the same one for different work. Every row of the synced task-graph
tables now also carries `uid`, the key a merge compares:

- **Tables**: `tasks_tasks`, acceptance criteria and their history, evidence
  bindings, sessions, dependencies, relations and labels. The other syncing
  tables follow as their twin collapses land; a gate test keeps the pending
  list from growing.
- **New rows** get a random UUIDv7. **Existing rows**, and rows an older
  build writes, get a deterministic uid at the next open (from the row's
  table, key and creation time), so two devices holding the same history
  derive the same uids, while the same `T####` created twice gets two.
  Dependencies, relations and labels get a uid derived from the uids at both
  ends. Nothing about the existing columns changes.
- **Collisions are detected, never merged.** Every row with a locally
  allocated key also stores a birth fingerprint (`birth_fp`: its creation
  time at full precision plus facts no edit changes). The same uid with a
  different fingerprint is a collision: the loser gets a new uid and the old
  one is kept in `tasks_uid_aliases`.
- **Acceptance criteria** keep their uid when edited (same text, else same
  position). Each evidence binding records the criterion's uid (`ac_uid`) and
  the hash of the text it was recorded against (`ac_text_hash`). Evidence for
  a different text is shown as stale and does not satisfy a gate until it is
  re-verified. An older build that recreates criteria is repaired at the next
  open (the uid is recovered from a small deletion log).
- **Labels and dependencies** are now written as diffs: saving a task no
  longer deletes and re-inserts the edges it keeps.
- **Display-id collisions**: only one authority (the sync server, or the
  device that created the losing row) gives the loser a new `T####` and
  publishes it; other devices keep it under a provisional id until then. The
  old id stays in `tasks_display_id_aliases`: a live id always wins, one alias
  resolves, several aliases are reported as ambiguous.
- `cleo doctor` gains a `row_identity` check. `CLEO_DISABLE_ROW_UID_FILL=1`
  skips the fill. Gate B: `fingerprint-store.mjs --omit-row-identity`
  compares a store with its pre-migration copy.
