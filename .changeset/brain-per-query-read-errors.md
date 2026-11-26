---
id: brain-per-query-read-errors
tasks: [T14656]
kind: fix
summary: "@cleocode/brain catches each substrate query on its own, so one failing query no longer skips the adapter's other queries, and reports an unopenable store and a failed nexus stub read in graph.errors"
---

Each adapter ran all its queries in one `try`, so the first failure skipped
the rest. Every query now goes through `tryQuery`, which records
`<table>: <message>` and lets the adapter continue. `readProjectStore` and
`readGlobalStore` take an optional error sink, so a store that exists but
cannot be opened is reported as `store cannot be opened: <message>` instead of
reading as an empty substrate. The stub-node pass reports a failed nexus
lookup under `errors.nexus`.
