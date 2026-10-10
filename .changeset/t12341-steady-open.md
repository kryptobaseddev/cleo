---
id: t12341-steady-open
tasks: [T12341]
kind: perf
summary: with row uids on, a store the fill already completed opens as fast as with them off
---

With `CLEO_ROW_UID_FILL=1`, every store open re-ran the whole identity fill pass. It recounted
NULLs and recomputed findings over every declared table, and loaded the chokepoint writers
(`sqlite-data-accessor`) even when nothing was left to fill. On a 6,118-task store that cost
~170 ms and ~15 MB per open. The flag is still off by default; this is the precondition for
turning it on (C2).

- **Index probes decide whether to run the pass.** `rowIdentityFillPending` reports pending work
  without scanning, and returns nothing when the identity is complete. Pending work is:
  - part of the identity schema is missing;
  - the recipe marker is stale;
  - the AC graveyard is non-empty;
  - a row has no uid (found through the unique uid index);
  - a minted row has no birth fingerprint (found through a new partial index,
    `idx_<table>_birth_fp WHERE birth_fp IS NULL`). The fill pass creates it, and only that
    pass: a store the fill never ran on keeps the migration's schema, and its opens heal nothing
    new. The spec §13 rollback drops it with the other identity indexes;
  - a NULL stored reference now resolves.
  The probes look for the rows themselves, so a row an older build inserts into a reused rowid
  is still found.
- **The steady path only arms the connection.** When nothing is pending, `prepareRowIdentity`
  installs this connection's uid triggers and returns without writing.
- **The writers load only when needed.** The open loads `sqlite-data-accessor` only when there
  is pending work, and the schema pass loads it only to heal.

Measured on a filled copy of cleocode, with the fill on vs off:

| Open | Fill on | Fill off |
|---|---|---|
| Steady open (was 225 ms with the fill on) | 44–59 ms | 49–70 ms |

Peak RSS is equal. Real-store Gate B still passes on all five stores. Gate 39 gains three probes
(`show-existing` with the fill off; `show-fill-first` and `show-filled` with it on). The filled
probe may load no more modules than the fill-off one.
