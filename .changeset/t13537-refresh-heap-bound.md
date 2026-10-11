---
id: t13537-refresh-heap-bound
tasks: [T13537]
kind: fix
summary: "A graph query's inline nexus refresh runs in a heap-limited worker, so it can never abort the CLI at its heap cap"
---

An incremental refresh still re-resolves the whole graph, Leiden included, so its heap peak is close to a full run's. The inline refresh that `cleo nexus impact` / `context` (and every graph-answering query) may run now executes in a worker thread with its own V8 heap limit. A refresh that outgrows it ends only the worker; the query answers from the stale index, says why, and leaves the previous graph intact.
