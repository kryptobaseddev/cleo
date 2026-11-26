---
id: brain-substrate-read-errors
tasks: [T14647]
kind: fix
summary: "@cleocode/brain substrate adapters report a failed SQL read in their result (error) and getAllSubstrates() names it per substrate in graph.errors, instead of returning a silently empty substrate"
---

Each adapter wrapped its reads in one `try` that swallowed every error, so a
broken query returned an empty substrate with no sign of failure (how the dead
`agent_connections` query went unnoticed). The adapters still keep whatever
they read before the failure, but now return it with `error`, and
`getAllSubstrates()` collects those into the new optional `BrainGraph.errors`.
