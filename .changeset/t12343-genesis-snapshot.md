---
id: t12343-genesis-snapshot
tasks: [T12343]
kind: feat
summary: Sync genesis cut snapshots its checkpoint bundle at the cut; other cleo processes wait or refuse cleanly
---

The genesis checkpoint's bundle must be the store exactly at the cut (journal spec §2.11 §10). Otherwise a write made after the
cut would travel both in the bundle and in a segment, and restore would apply it twice (T12343 S4-1b).

- **`cutGenesisWithSnapshot(db, {…, dbPath}, snapshot)`** runs `snapshot(cut)` while the cut's `BEGIN IMMEDIATE` is held, before the
  cut commits. A snapshot taken on another connection sees exactly the cut state, because nothing else can commit. A failing snapshot
  rolls the cut back. `cutGenesis` shares the same two phases.
- **A `genesis` store marker.** The export can outlast another writer's 30 s busy timeout, so for its duration the store carries a
  `genesis` marker (the restore-in-progress marker, T13258). Another cleo process:
  - waits at its store open, then refuses with `E_STORE_GENESIS` and a remedy;
  - waits at the write chokepoint too (`assertExodusWriteSafe`, which now calls `awaitStoreWritable`, without blocking the event
    loop), then refuses the same way. A write that waits it out lands after the snapshot.

  The holder itself is exempt, and the marker is always released.
- **The restore-in-progress marker** (`store/restore-marker.ts`, `store/pid-alive.ts` and the open-path checks) comes from #1902
  (T13258), cherry-picked unchanged.
