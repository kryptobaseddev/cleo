---
id: narrow-storable-task-id
tasks: [T14324, T14271]
kind: fix
summary: "a stored task id is T followed by digits: isStorableTaskId no longer admits the structured reconcile follow-up ids"
---

`isStorableTaskId` admitted any letter-led identifier so that the release
reconciler's `T-RECONCILE-FOLLOWUP-…` ids could be stored, ids `cleo show`
then rejected. Follow-ups are allocated `T####` ids now (T14271) and the
stored ones are re-keyed by `cleo doctor malformed-ids --fix` (T14324), so the
exception is gone:

- `isStorableTaskId` is the task grammar (`T` and digits), the check the task
  insert chokepoint runs.
- A manifest linked task id is the task grammar too.
- `cleo doctor malformed-ids` now reports any other stored id outside the
  grammar; `--fix` deletes such a row only when nothing references it, as
  before, and re-keys the legacy follow-ups.
- Test fixtures that inserted ids outside the grammar use `T####` ids.
