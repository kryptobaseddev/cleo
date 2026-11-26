---
id: brain-drop-edges-unloaded-endpoints
tasks: [T14658]
kind: fix
summary: "@cleocode/brain drops and counts edges whose endpoint failed to load instead of emitting dangling edges or fake observation stubs, and exports StoreErrorSink"
---

When a memory node query failed, the brain adapter still emitted page edges
and memory links from or to nodes of that kind, and the merge pass filled the
missing targets with fake `observation` stubs. Those edges are now dropped and
counted in `errors.brain`. A non-NEXUS substrate whose read failed gets no
query-less stubs: an edge to one of its unloaded nodes is dropped and counted
in that substrate's error. `StoreErrorSink` is exported from the package index.
