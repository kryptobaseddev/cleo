---
id: t13539-refresh-worker-no-hang
tasks: [T13539]
kind: fix
summary: "The nexus refresh worker cannot hang a read query: it resolves on its result and a hard timer ends a stall"
---

The inline refresh resolves on the worker's result message and then terminates the worker, so a handle left open in it no longer holds the query. A hard timer terminates a worker still running after its budget plus a margin (10 %, at least 1 s), which ends stalls the phase-boundary abort cannot reach; the query answers from the stale index and says why.
