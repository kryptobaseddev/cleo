---
"@cleocode/core": patch
---

Twin collapse marks the synced twin it wrote suspect, so the sealer's repair diff covers its writes (journal spec §2.3a rule 3, T12775). It runs the merge inside `withSuspectAccounting`, which now has a production caller. Today no collapse target syncs, so this is a no-op until T12535 declares them.
