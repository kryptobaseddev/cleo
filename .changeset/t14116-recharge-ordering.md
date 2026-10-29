---
id: t14116-recharge-ordering
tasks: [T14116]
kind: fix
summary: "a run's ledger charge no longer races its own writes: a climb measured while a lowering is still being written restores the plan instead of lowering again"
---

The charge a run's grant compared measurements against was updated only after
its ledger write finished, and the writes were not ordered. A climb measured
while a lowering was still in flight was judged against the stale plan-sized
charge and lowered the charge again (3.75 GiB instead of the 12 GiB plan), and
the two writes could land in either order. Decisions now take effect at once,
writes run one after another, and a failed write falls back to the charge the
ledger holds.
