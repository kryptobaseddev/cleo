---
id: t12535-twin-collapse-slice1
tasks: [T12535]
kind: fix
summary: schema_meta and sticky_tags are collapsed into their prefixed twins (tasks_schema_meta, brain_sticky_tags) and kept in step with the bare tables an older build still writes; a failed collapse reports E_TWIN_COLLAPSE_FAILED and cleo doctor twin-collapse retries it
---

**Twin collapse of `schema_meta` and `sticky_tags` (T12535).** The project
`cleo.db` ran two tables on bare legacy twins while their prefixed twins held
a frozen copy. This build reads and writes only the twins
(`tasks_schema_meta`, `brain_sticky_tags`) and keeps them in step with the
bare tables, which the previous release still writes:

- On the first open the bare rows are folded into the twin in one
  transaction, after a `VACUUM INTO` snapshot that `cleo backup list` shows
  (free space is checked first). The bare table is authoritative: frozen
  twin-only rows are dropped, except the task-id sequence and snapshot-gate
  counters.
- Every later open carries what the bare table changed since (keys, tag
  additions and removals), without a snapshot. Monotonic counters (task-id
  sequence, snapshot-gate generation, `file_meta.generation`) take the larger
  value, never summed or reset; other keys take the bare value.
- A failure rolls back, leaves both tables unchanged and fails the open with
  `E_TWIN_COLLAPSE_FAILED` (cause, snapshot path, space needed).
  `cleo doctor` reports it, and `cleo doctor twin-collapse --retry` re-runs it.
