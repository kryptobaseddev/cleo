---
id: t12802-hlc-reffp
tasks: [T12802]
kind: fix
summary: Row-uid fingerprints of AC history and bindings no longer depend on fill timing, and display-id re-mints use the change journal's HLC (row uids, opt-in)
---

- **Stable fingerprints (recipe v2).** The birth fingerprint of an AC
  history row or an evidence binding used to hash its criterion's
  fingerprint. A binding also hashed the criterion's text hash. Both came
  from the criterion at fill time, so a device that filled after the
  criterion was deleted derived a different value for the same row. They
  now hash the row's own `ac_id`. A store filled with the 9.25 (v1) recipe
  has those two tables' fingerprints re-derived at the next open (never once
  identity is shared).
- **One HLC.** Display-id re-mints and the authority schedule now use the
  change journal's HLC: the `Hlc` wire format in `@cleocode/contracts`,
  `PPPPPPPPPPPPP-CCCCCC-<replica uuid>`, ordered by `store/sync/hlc.ts`. The
  local `<ms15>.<ctr6>.<node>` stand-in is gone.
- **Rows from before the journal.** For rows with no creation HLC, the
  collision HLC is the later of the two births, at counter 0, from the nil
  replica (`collisionHlcFromBirths`).
