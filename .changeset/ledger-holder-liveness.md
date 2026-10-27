---
id: ledger-holder-liveness
tasks: [T14066, T13046]
kind: fix
summary: "admission wait reports say why each holder still counts; dead holders stop holding the budget through reused group ids, and a dead runner's live child keeps its charge"
---

- **Holder lines (T14066).** The wait report, refusals and `cleo doctor tool-locks`
  now show each holder's host, heartbeat age, child, tool groups and a liveness
  verdict with its reason (`pid-alive`, `heartbeat-fresh`, `child-alive:<pid>`,
  `group-alive:<pgid>`, `group-unknown:<pgid>`, `unidentifiable`,
  `other-host:<host>`), so a stale holder can be told from a real one.
- **Finished tool groups are dropped (T14066).** A holder record listed every
  process group it ever started. Once the holder died, any of those ids reused
  by an unrelated group (EPERM counts as alive) kept its charge for up to 10
  minutes. A group now leaves the record when its tool finishes.
- **Orphans are stopped while queued (T14066).** `cleo run` waiters stop a dead
  runner's orphaned children on every admission pass, not only when a run
  starts, so a SIGKILLed runner's child does not hold the queue.
- **Child record (T13046).** The ledger entry records the spawned child's pid
  and start time right after the spawn, and the child's group is tracked
  before anything else runs. A dead runner's live foreground or nested child
  keeps the charge, so `cleo verify tool:test` cannot admit beside it.
