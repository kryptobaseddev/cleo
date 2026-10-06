---
id: t12343-genesis-snapshot
tasks: [T12343, T13296, T13297]
kind: feat
summary: Sync genesis cut commits, then snapshots its checkpoint bundle under a genesis marker; writers wait or refuse cleanly
---

The genesis checkpoint's bundle must be the store exactly as the cut left it (journal spec §2.11 §10; T12343 S4-1b). Otherwise a
write made after the cut would travel both in the bundle and in a segment, and restore would apply it twice.

- **`cutGenesisWithSnapshot(db, {…, dbPath}, snapshot)`** commits the cut FIRST, then runs `snapshot(cut)` (T13296). The bundle
  therefore carries everything the cut wrote: genesis row meta, the genesis keys, `undo_enabled`, `sync.push` and the folded
  transactions. A device restored from it has full row meta and never pushes a folded transaction again.
- **A failed snapshot undoes the cut.** It drops the stream's genesis keys, turns push off, returns the folded transactions to
  `sealed`, and turns undo off (dropping undo written since) when no other stream is cut. The same happens when a write reached the
  store during the snapshot (the capture position moved past the cut): `GenesisRacedError` (`E_SYNC_GENESIS_RACED`) is thrown, so no
  bundle holding a post-cut write is ever pushed.
- **A `genesis` store marker** (the restore-in-progress marker, T13258) covers the whole run:
  - another process waits at its store open, then refuses with `E_STORE_GENESIS` and a remedy;
  - every writer, in this process too (T13297), waits at the write chokepoint without blocking the event loop, then refuses the same
    way. A write that waits it out lands after the snapshot.

  The write chokepoint is `assertExodusWriteSafe`, which now calls `awaitStoreWritable`. Its callers are the task accessor's write
  transactions, session creation, `insertIdempotent` and `upsertIdempotent`. A writer that bypasses those is not paused; the race
  check above catches its write instead. The marker is always released.
- **The restore-in-progress marker** (`store/restore-marker.ts`, `store/pid-alive.ts` and the open-path checks) comes from #1902
  (T13258), cherry-picked unchanged.
