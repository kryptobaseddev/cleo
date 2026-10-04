---
id: t12753-inherited-outbox
tasks: [T12753]
kind: fix
summary: A copied, restored or rolled-back store no longer seals or re-sends the original replica's outbox; its captures and sealed transactions are marked inherited on rebind
---

When a store rebinds to a new replica, the old replica's live captures and sealed transactions are now marked `inherited` in the rebind transaction (journal spec §1.5 H3). The sealer reads only live captures and never seals or sends inherited rows. Only what the store writes after the rebind is sealed, under the new replica's id. The rebind record (`rebind:last` in `_sync_meta`) now counts what it inherited.

This is the local half of H3. The S4 reconcile restores a checkpoint and re-emits what a copy changed and never sent. That reconcile, plus marking unpushed segments, the pull cursor and the signed retire transaction, arrives with S4.
