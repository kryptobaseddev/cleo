---
id: t13183-durable-reconcile-remap
tasks: [T13183]
kind: fix
summary: A legacy task the reconcile recovered stays recovered after you retitle it, and cleo show <legacy id> says where it went
---

`cleo doctor superseded-store --reconcile` recovers a legacy task whose id a newer task took under
a fresh id (T13172). A later run recognised the recovery by its title, so retitling the recovered
task before running the reconcile again recovered it a second time.

Later runs now read the recoveries earlier runs recorded in their receipts
(`.cleo/exodus-reconcile-*/reconcile-receipt.json`) and match on them first, as long as the
recorded task still exists with the legacy task's creation time. `cleo show <legacy id>` shows the
newer task as before and adds a `W_LEGACY_ID_RECOVERED` note naming the id the legacy task carries
now. The record stays in the receipt rather than the synced alias table because aliases name rows
by uid, and row uids stay off until their release gate passes.
