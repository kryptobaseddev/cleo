---
id: t13337-retire-on-open-rebind
tasks: [T13337]
kind: fix
summary: "Sync: a rollback or cross-filesystem-move rebind retires the old replica; a copy retires nothing"
---

Only the undo-budget rebind at head used to announce the old replica's end. Now an open-pass rebind does too, when it
retires the old id (journal spec §1.5 "Retirement", T13337):

- **Rollback** of the same file (rule 3), or a **cross-filesystem move** (rule 1 with the registry's old path gone):
  the rebind records `sync.retire_due` in its own transaction. `settleRetireDue` turns it into a signed `retire`
  transaction under the successor and the pending server rebind. The canonical open runs it at once, and `cloud sync`
  runs it before it pushes or pulls, then completes the server half: attach, link, signed E31.
- The retire names the highest replicaSeq of the old replica persisted on the stream, by the store or the device
  registry (which outlives a rollback), so the server never refuses it as `retire-below-head`. A replica that
  persisted nothing retires with no journal transaction.
- **A copy**, a nonce mismatch or another device's store rebinds and retires nothing: the original replica is still
  live.
