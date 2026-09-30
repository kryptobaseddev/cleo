---
id: t12806-import-row-identity
tasks: [T12806]
kind: fix
summary: Imports and snapshot restores keep a task's row identity instead of stamping a new uid at import time (row uids, opt-in)
---

With row uids on (`CLEO_ROW_UID_FILL=1`), every task written by an import
or a snapshot restore went through the "new task" path and got a random
UUIDv7 stamped with the import time. A restored task that was still live on
another device became a second identity for the same work.

- **Snapshots** now carry each task's `uid` and `birthFp`, and a restore
  writes them back.
- **Other imports**, and snapshots without identity, leave the uid empty, so
  it is derived from the task's own id and creation time, exactly as for a
  task an older build wrote. A carried uid that another row already holds is
  derived instead.
- **Overwrite imports** (`--on-duplicate overwrite`) replace a stored task
  with a different one. They clear its uid and fingerprint so the next open
  re-derives them. Once identity has been shared with other devices, the
  overwrite is refused.

Nothing changes while row uids are off (the default).
