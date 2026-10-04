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

A record is trusted only when the recovered task still exists with the legacy task's creation
time and type, so a hand-edited receipt cannot aim a legacy id at an unrelated task created at the
same instant, and `cleo show` never points at a deleted id. Receipts are read from the resolved
`.cleo` the reconcile writes them to, so a `CLEO_DIR` override cannot split the two.

Known limits:
- Receipts are local files and do not sync: a second device that receives the store through Nexus
  sync has no record and falls back to the title match (a synced alias record is T13189, after row
  uids ship).
- Renaming the recovered task's display id (not its title) also misses the record.

