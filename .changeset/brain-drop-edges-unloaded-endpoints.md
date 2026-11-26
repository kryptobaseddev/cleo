---
id: brain-drop-edges-unloaded-endpoints
tasks: [T14658, T14659]
kind: fix
summary: "@cleocode/brain drops and counts edges whose endpoint is of a node kind whose query failed, instead of emitting dangling edges or fake observation stubs, and exports StoreErrorSink"
---

When a memory node query failed, the brain adapter still emitted page edges
and memory links from or to nodes of that kind, and the merge pass filled the
missing targets with fake `observation` stubs. Each adapter now reports the
node kinds whose query failed in `BrainSubstrateResult.failedKinds`. An edge
whose unloaded endpoint is of a failed kind is dropped and counted in that
substrate's error. An edge to an absent node of a kind that loaded keeps the
old behaviour (a stub), even when another query of the same substrate failed.
When a store cannot be opened or its read throws, every node kind the adapter
owns counts as failed.
`StoreErrorSink` is exported from the package index.
