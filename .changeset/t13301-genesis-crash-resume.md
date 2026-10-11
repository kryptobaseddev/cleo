---
id: t13301-genesis-crash-resume
tasks: [T13301]
kind: fix
summary: A genesis cut that crashed before its snapshot resumes on the next run; undoing a cut un-folds only its own transactions
---

The genesis cut commits before its snapshot (T13296), so a crash, kill or sleep mid-export used to leave the stream cut and
`genesis_pending` set with no snapshot, and the next run returned `already` without ever producing the checkpoint.

- **`cutGenesisWithSnapshot` now resumes such a cut.**
  - With no capture since the crash, the store is still exactly the cut, and the snapshot runs at it (`resumed: true`).
  - Otherwise the stale cut is undone and the store is cut again.
  - A stored cut (`genesis_pending` cleared) is still `already`, and no snapshot runs.
- **Undoing a cut reverts only the transactions that cut folded** (`genesis_folded_from` to `genesis_folded_upto`). A store feeding
  two streams no longer un-folds the other stream's earlier fold.
