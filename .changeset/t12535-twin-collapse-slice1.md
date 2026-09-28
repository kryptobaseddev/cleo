---
id: t12535-twin-collapse-slice1
tasks: [T12535]
kind: fix
summary: schema_meta and sticky_tags are collapsed into their prefixed twins (tasks_schema_meta, brain_sticky_tags) and kept in step with the bare tables an older build still writes; a failed collapse keeps reads working, refuses writes with E_TWIN_COLLAPSE_FAILED, and cleo doctor twin-collapse retries it
---

**Twin collapse of `schema_meta` and `sticky_tags` (T12535).** The project
`cleo.db` ran two tables on bare legacy twins while their prefixed twins held
a frozen copy. This build reads and writes only the twins
(`tasks_schema_meta`, `brain_sticky_tags`) and keeps them in step with the
bare tables, which the previous release still writes:

- The bare row is authoritative. A monotonic counter field (task-id
  sequence counter, snapshot-gate generation, `file_meta.generation`) is
  merged on its own, as the larger of the two values; a whole twin value
  never replaces a bare one.
- On the first open the bare rows are folded into the twin in one
  transaction, after a `VACUUM INTO` snapshot that `cleo backup list` shows
  (free space is checked first). Frozen twin-only rows are dropped, except
  the task-id sequence and snapshot-gate counters.
- Every later open carries only the bare keys (sticky ids) whose hash changed
  since the last merge. When this build changed the same key too, the twin
  value is kept and `cleo doctor` reports the conflict.
- A failed collapse never locks the user out: reads are served from the
  merged view, writes are refused with `E_TWIN_COLLAPSE_FAILED` (cause,
  snapshot path, space needed), `cleo doctor` reports it, and
  `cleo doctor twin-collapse --retry` re-runs it.
