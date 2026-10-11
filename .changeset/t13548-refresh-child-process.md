---
id: t13548-refresh-child-process
tasks: [T13548]
kind: fix
summary: "A graph query's inline nexus refresh runs in an owned child process, so ending it releases every database lock"
---

The inline refresh moved from a worker thread to the runtime's owned process port (process group, teardown, cgroup sizing) with its own V8 heap limit. Ending the refresh — on its result, its budget plus a margin, an out-of-memory death or a crash — now kills the process, which releases its SQLite handles and write lock. Before, a worker terminated mid-publish kept the nexus write lock for the rest of the command. Its stdout is discarded, so it can never write into the command's JSON envelope.
