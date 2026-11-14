---
id: retained-snapshot-recovery
tasks: [T14572]
kind: fix
summary: "Recover missing rows and newer versions from every retained store snapshot, even after a stale session backup; protect recovery sources from count, time-spread and byte-cap rotation, preserve deliberate pruning through durable delete receipts, and reject corrupt recovery sources."
---
