---
id: retained-snapshot-recovery
tasks: [T14572]
kind: fix
summary: "Recover missing rows and newer versions from retained divergent store histories after a stale session backup; record bounded snapshot ancestry, protect recovery sources during project and global rotation, preserve deliberate pruning and ID reuse, and reject corrupt recovery sources."
---
