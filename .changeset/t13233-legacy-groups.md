---
id: t13233-legacy-groups
tasks: [T13233]
kind: fix
summary: Partial merge groups recorded or sealed before T13222 are completed at seal time instead of being refused, with their whole transactions, by every receiver
---

The pre-T13222 capture trigger recorded only the changed columns of the status group, and a pre-fix sealer sealed them that way. The
merge engine now refuses a partial-group U as malformed. Every receiver would therefore refuse those transactions permanently.

- **Captures still in `_sync_capture`.** At seal time, each missing group member is added unchanged (before equals after). Its value is
  what the member held at that capture: the before-image of the row's next live capture that recorded it, else the live row.
- **Sealed-but-unsent ops** (`_sync_op`, before push). They are completed once per store, in the same way: the before-image of the row's
  next sealed op that carries the member, else the live row. `_sync_meta` key `sealer.group_whole_v1` records that the pass ran.
- **Tests.** A capture shaped like the old trigger's output, and a partial op shaped like pre-fix sealer output, both seal whole and
  apply on a receiving store with nothing refused. The value comes from the next write, not the live row, where that matters.
