---
id: t13193-held-rows
tasks: [T13193, T13269]
kind: feat
summary: Held rows for the sync rebase - a refused replay stays rewound and accounted, and cleo show reports E_SYNC_HELD
---

This is the third slice of the scoped rebase (T13193 R-3), against journal spec §3.5 Rule 5.

- **Held ops.** A local op that the rebase replay refuses stays rewound and is held until its echo is decided. The refusal can be a
  dangling reference, a typed rule, a guard, or a post-apply check (in which case the whole transaction is held).
  - Its row meta carries `held = 1`. For an insert, the meta is the one the op left, so the repair diff and the ledger check skip it
    instead of emitting a spurious D.
  - `_sync_ledger.live` and `.held` move by the op's row-count effect.
  - Its row undo records when it was held and why.
- **Holds are decided again on every rebase.** A rebase that rewinds a held op lifts its hold and replays it again. If the replay now
  applies, for example because the blocking parent came back, the hold clears. A held transaction's echo never takes the own-echo fast
  path, so its echo is always decided inside a rebase.
- **What a held insert kept survives across frames (T13269).** The rewind's snapshot (the insert's local-only columns and its FK
  children outside the sync set) is persisted with the hold. It is restored if the insert applies in a later frame.
- **The ledger stays balanced across a rebase.** Rewind and replay write with capture suspended, so they now account their own row-count
  changes to `_sync_ledger`. Before this fix, a rebased own insert was counted twice once its echo applied.
- **`cleo show` of a held task** returns `E_SYNC_HELD` instead of `E_NOT_FOUND`, with the held values and a conflict preview.
- **New sync-journal migration** `t13193-held-rows`, local-only: `_sync_row_undo.held_at`, `held_reason`, `held_effect`, `kept_json`,
  and a partial index over held rows. Undo still turns on only with S4's genesis cut, so all of this stays inert on real stores until
  then.
