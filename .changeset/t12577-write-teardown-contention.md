---
id: t12577-write-teardown-contention
tasks: [T12577]
kind: fix
summary: "Finish ordinary writes under contention: commit task graph nodes atomically, avoid blocking routine WAL snapshots, and remove obsolete operation-envelope evaluation."
---
