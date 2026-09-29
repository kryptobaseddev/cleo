---
id: skills-unkeep
tasks: [T12699]
kind: feature
summary: `cleo skills doctor restore --unkeep <name>` hands a restored (kept) skill back to CLEO when it is unchanged
---

A skill restored from quarantine is marked kept, so `cleo skills doctor
prune` and install never take it again. Before this change there was no way
back: restore dropped the skill's ledger hashes, so a kept skill stayed kept
forever.

Restore now records the hashes of the restored copy in the ledger
(`keptFiles`).

`cleo skills doctor restore --unkeep <name>` hands the skill back to CLEO
only when every file of the canonical copy still hashes exactly to that
record. The name then returns to the ownership ledger, so a later prune may
quarantine it again.

`--unkeep` leaves the skill kept, and exits 6 (`E_VALIDATION`) with the
reason, in two cases:

- the copy has been edited since the restore;
- the skill was restored before hashes were recorded.

If the canonical copy is gone, the name simply leaves the kept list.
