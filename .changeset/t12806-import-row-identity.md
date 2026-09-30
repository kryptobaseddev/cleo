---
id: t12806-import-row-identity
tasks: [T12806]
kind: fix
summary: With row uids on, imports and snapshot restores keep a task's row identity and never stamp an import-time uid; with them off, nothing changes
---

Everything here applies only with row uids on (`CLEO_ROW_UID_FILL=1`,
off by default). With the flag off, snapshots carry no identity, and
restores and overwrite imports neither write nor clear one.

- **Snapshots** (format 1.1.0) carry each task's `uid` and `birthFp`. A
  restore writes them back. A carried uid that was re-keyed here follows its
  alias.
- **A row that is already here** is skipped and reported, never written
  again. That covers a row with the same uid and birth fingerprint under
  another id after a re-mint, and a row held for sync.
- **Id mismatch.** When a snapshot task and a local task share an id but are
  different rows (different uids), the conflict is reported and the local
  task is not overwritten.
- **Other imports**, and snapshots without identity, derive the uid from the
  task's own id and creation time. A source with no creation time gets the
  recipe's unknown-birth identity, never one stamped with the import time.
- **Overwrite imports** (`--on-duplicate overwrite`):
  - Replacing a task with the same task (same birth fingerprint) keeps its
    identity.
  - Replacing it with different work clears the task's identity and
    everything derived from it: its edges, its criteria, and their history
    and bindings. The next open re-derives them.
  - Once identity has been shared with other devices, the overwrite is
    refused.
