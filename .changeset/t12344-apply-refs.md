---
id: t12344-apply-refs
tasks: [T12344]
kind: feat
summary: Apply resolves references, re-keys rows, turns guard-trigger refusals into conflicts, and applies the remote-parent-delete policy
---

This is the fourth slice of the apply side (T12344, PR-4 of 6), against journal spec §3.2 (missing references, guard refusals, FK
actions) and §3.3 G.

- **References.** A reference travels as the target's uid and is stored as its local key.
  - A target re-keyed or re-minted is followed through `tasks_uid_aliases`.
  - A target never seen keeps the transaction pending, with no age limit.
  - A deleted target makes the op a `dangling-ref` conflict and a revivable void.
  - The merge reads references back as uids, so a sequential re-parent is not a false conflict.
- **Guard refusals.** Each op applies in its own savepoint. A guard trigger or constraint that aborts the write rolls back only that op,
  and records a `guard` conflict and a void.
- **Parent deletes.** A remote delete of an FK parent whose `ON DELETE CASCADE` sync-set children remain follows the
  `ON_REMOTE_PARENT_DELETE` registry:
  - `conflict` (tasks, sessions) voids it with a `delete-with-live-children` conflict that lists the children;
  - `cascade-with-ops` deletes the children first, with tombstones;
  - a test fails if a sync-set FK parent has no declared policy;
  - a `SET NULL` child's cleared column is recorded as an apply intent, so the FK action is never re-emitted.
- **Re-keys (K).** `rekeyRow` changes the uid, and the birth fingerprint when the op carries one. It records `*K`, and moves the row's
  meta and its leave and frontier state.
  - `remapPending` first moves local captures and unsent ops onto the new uid.
  - A re-key onto a live uid is a `uid-collision` void.
  - A re-key of a row never seen waits.
