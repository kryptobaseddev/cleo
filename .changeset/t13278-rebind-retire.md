---
id: t13278-rebind-retire
tasks: [T13278, T12763, T12753]
kind: feat
summary: "Sync: the undo-budget rebind runs at the next pull to head - reconcile, signed retire of the old replica, late old segments as history"
---

A store whose undo passed its budget (`sync.undo_budget_exceeded`, D5) now rebinds at the next pull that reaches the stream's
head (T13278). In one transaction with the rebind:

- **What the server holds is pushed:** old segments at or below the pull cursor's replicaSeq are marked pushed, never inherited.
- **The old outbox is inherited:** live captures, sealed transactions, and now also the segments the old replica never pushed with
  the transactions they carry, plus every old transaction the stream has not sequenced.
- **The undo log is emptied**, and the foreign-touch index resets.
- **The reconcile re-emits what was never sent** (journal spec §1.5 N7, T12763): every touched row is written, from its live state,
  as a capture of one `rebind` frame, which the sealer seals as a `repair` transaction with `via: 'rebind'`, ticked at the row's
  last inherited change. A row the stream never saw is re-emitted as an insert, and the ledger forgets the row counts of the
  inherited sealed transactions, so each live row is counted once. The three-way field rule is `decideReconcileField`.
- **A signed `retire` control transaction** (`kind: 'retire'`, `LedgerTxn.retire`) names the old replica, its successor and the
  last replicaSeq the server holds. A replica that never landed a segment retires with none.
- **`sync.undo_budget_exceeded` is cleared** - only by this rebind. A pull that is refused or stops short of the head keeps it.

The server half needs the network, so it is recorded as a pending rebind, and `cleo cloud sync` completes it before the store pushes
or pulls again: it attaches the successor to this device (and records it in the project link), retires the old replica on the
server (E31, contract v2.28, signed over `replicaRetireMessage`), then pushes again in the same run so the retire leaves at once.
A refusal keeps it pending, and nothing is pushed or pulled under a replica the server does not know.

Receivers record every retire at its stream seq (`_sync_retired`). A transaction of a retired replica sequenced after its retire
(a late segment) is inherited history: it applies as an ordinary op, and its merge conflicts are not recorded against the
successor's reconcile (a refused op still is). `liveReplicaHorizon` leaves retired replicas out of the fold horizon, and
`withRetirements` marks them retired for the remint authority.
