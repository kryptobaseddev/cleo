---
id: t12344-post-apply
tasks: [T12344]
kind: feat
summary: Apply runs Gate C post-apply checks: a transaction that breaks a multi-row invariant is voided whole with a conflict, and a store that refuses writes applies nothing
---

This is the fifth slice of the apply side (T12344, PR-5 of 6), against journal spec §3.6 (post-apply checks) and §3.5 Rule 3.

- **The transaction is one savepoint.** After its ops apply, the post-apply checks run over its page, meaning the rows it wrote plus each
  check's declared footprint. A violation rolls the whole transaction back: it becomes a revivable void plus one `post-apply` conflict
  per violation.
- **PAC-01 `task.tree.shape`** (`checkTaskTreeShape`): no self-parent, no ancestor cycle, a parent type that may contain the row, and
  every child still allowed under the row's possibly changed type. The parent-type trigger never re-checks children when a parent's type
  changes.
- **PAC-15 `apply.preconditions`** (`checkApplyPreconditions`): a store whose twin collapse failed refuses writes, so the applier applies
  nothing and reports `blocked`; the inbox waits.
- **PAC-03 `task.dependency.graph`** is reclassified as trigger-covered: the T12886 cycle guards enforce it on apply, as a guard conflict.
- The other post-apply families stay pending until their tables join the sync set.
