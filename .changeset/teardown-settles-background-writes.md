---
id: teardown-settles-background-writes
tasks: [T13630]
kind: fix
summary: closing the store settles in-flight best-effort writes first, so a late write can no longer stall the next writer for 30 s
---

`closeAllDatabases` now settles tracked background writes (graph nodes, hook
dispatches, session manifest mirrors and journal, observation auto-link,
post-checkpoint snapshots) on the open handles before closing, bounded at
5 s. Before, a write that outlived its caller re-opened the store on a fresh
connection and busy-waited the next writer for the full busy_timeout. The
previously untracked sites are now registered with the background ledger, so
a failure is counted in the shutdown receipt instead of being swallowed.
