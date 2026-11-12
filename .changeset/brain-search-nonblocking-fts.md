---
id: brain-search-nonblocking-fts
tasks: [T14509]
kind: fix
summary: "BRAIN search: skip FTS repair immediately when another writer holds the store"
---

Disable SQLite busy retries for opportunistic FTS repair during a cold memory
search. A held writer now immediately leaves a stale index in use or sends a
missing index to plain search, while the connection's normal write timeout is
restored. This avoids retry sleeps exceeding the read budget on macOS without
changing the read-only regressions or their timing assertions.
