---
id: stale-store-freshness
tasks: [T14556]
kind: fix
summary: "Store recovery: detect and merge history hidden by a stale main file"
---

Doctor compares task, session, decision, audit and observation keys and each
row's own timestamp against validated snapshots. A current session or audit
write cannot hide rows lost after checkout. Rejected WAL commits are named
without opening live stores.

Repair preserves newer snapshot rows, live-only rows and every losing version
in recovery.json. It supports older pinned bases and external snapshots, and
refuses unreadable WAL recovery without a newer source.

Snapshot-only restores record durable intent and the exact superseded backup
images. Doctor still reports those backups without reapplying them; snapshots
created after the rollback remain authoritative.
