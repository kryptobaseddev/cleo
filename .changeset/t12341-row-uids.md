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
- **Acceptance criteria** keep their uid when edited (same text, else same
  position). Evidence bindings record the criterion's uid (`ac_uid`) and are
  resolved through it, so editing a criterion no longer orphans its evidence.
- **Display-id collisions**: `store/display-id-alias.ts` re-mints the later
  row of a colliding pair and records the old id in
  `tasks_display_id_aliases`; an id claimed by more than one row resolves as
  ambiguous, never to a guess.
- `CLEO_DISABLE_ROW_UID_FILL=1` skips the fill. Gate B:
  `fingerprint-store.mjs --omit-row-identity` compares a store with its
  pre-migration copy.
