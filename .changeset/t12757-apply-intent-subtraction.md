---
id: t12757-apply-intent-subtraction
tasks: [T12757]
kind: feat
summary: The sealer subtracts apply intents field by field, so an apply frame seals only what the apply did not write (journal S3 intent subtraction)
---

Journal spec §3.3 (H1, N1). An apply frame's captures used to wait forever. They are now sealed only for their residual. A new local-only table, `_sync_apply_intent` (sync-journal folder `20261004120000_t12757-apply-intent`), holds what the apply wrote per (frame, tbl, uid, col), with the exact `enc()` of the stored value. The apply records it through `recordApplyIntents` in the same transaction as the write. The sealer then subtracts:
- U: changed columns whose after-value equals the intent (a reference compares its local key, a secret its marker);
- I: the whole insert when no column differs from an intent; otherwise the residual columns remain as an update;
- D: removed on a `*D` intent;
- K: removed when `*K` names the same new uid.

Residual fields are sealed as local writes with new HLCs, so an interleaved writer or a side effect in the frame still travels. Removed captures are consumed, the ledger still counts applied inserts and deletes, and a frame's intents are deleted with it. Rebase frames keep waiting for S5's scoped rebase. Vault snapshots clear `_sync_apply_intent` with the rest of the local journal. `sync.seal` stays unreleased.
