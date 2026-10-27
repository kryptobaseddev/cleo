---
id: killed-run-marker
tasks: [T13014]
kind: fix
summary: "evidence tool runs queued on a key whose run was just killed for resources report that kill instead of rerunning into it at the same limits"
---

When the holder of a tool-cache key (`cleo verify tool:test`) was killed for
resources (an OOM, a heap limit, exit 137), nothing was cached, so each waiter
on that key reran the same heavy command in turn, under the same heap and
worker limits, into the same kill.

The holder now leaves a `<key>.killed.json` marker under the lock. A waiter on
that key, whose call started before the kill, reports it (`resourceKill` names
the original reason and says it was not rerun) instead of running. The cache key carries the heap
and worker limits, so a caller with a larger heap or fewer workers uses another
key and runs. A call that starts after the kill also runs.
