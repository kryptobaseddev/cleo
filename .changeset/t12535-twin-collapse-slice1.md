---
id: t12535-twin-collapse-slice1
tasks: [T12535]
kind: fix
summary: schema_meta and sticky_tags are collapsed into their prefixed twins (tasks_schema_meta, brain_sticky_tags) in one atomic, snapshotted migration, and the runtime reads and writes only the twins
---

**Atomic twin collapse, PR 1 (T12535).** The project `cleo.db` still ran two
tables on bare legacy twins while their prefixed twins held a frozen copy. On
the first open after the upgrade, each domain bind now folds the bare rows
into the twin once, in one transaction, after a `VACUUM INTO` snapshot, and
the runtime binds only the twin:

- `schema_meta` → `tasks_schema_meta`, key-aware: monotonic counters (the
  task-id sequence, the snapshot-gate generation, `file_meta.generation`) take
  the larger value, never summed or reset; every other key keeps the bare
  (last-written) value; the `t877` migration guard keys are not carried.
- `sticky_tags` → `brain_sticky_tags`: union on `(sticky_id, tag)`; tags of a
  deleted note are not carried.

A marker row makes the collapse run once; a failure rolls back, leaves both
tables unchanged, and fails the open. The bare tables are left in place.
