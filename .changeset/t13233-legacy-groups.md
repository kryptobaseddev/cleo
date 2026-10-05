---
id: t13233-legacy-groups
tasks: [T13233]
kind: fix
summary: Partial merge groups recorded or sealed before T13222 are completed at seal time instead of being refused, with their whole transactions, by every receiver
---

The pre-T13222 capture trigger recorded only the changed columns of the status group, and a pre-fix sealer sealed them that way. The
merge engine now refuses a partial-group U as malformed. Every receiver would therefore refuse those transactions permanently.

- **Captures still in `_sync_capture`.** At seal time, each missing group member is added unchanged (before equals after). Its value is
  what the member held at that capture:
  - the before-image of the row's next live U that recorded it;
  - at the row's next I or D, that image, which omits NULL columns, so an absent member was NULL;
  - else the live row, or NULL when the row is gone.
- **Sealed-but-unsent ops** (`_sync_op` of `state = 'sealed'` transactions only). They are rewritten in place, once per store, in the
  same way: the row's next sealed U carrying the member, or its next D, else the live row, or NULL. `_sync_meta` key
  `sealer.group_whole_v1` is set only when every op came out whole. The completed members travel at the op's HLC while the origin's meta
  keeps their older field HLC; group LWW uses the group's newest HLC, so merges agree.
- **Tests.** A capture shaped like the old trigger's output, and a partial op shaped like pre-fix sealer output, both seal whole and
  apply on a receiving store with nothing refused. The value comes from the next write, not the live row, where that matters.
