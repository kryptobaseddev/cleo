---
id: t11528-e6-l8-migration-manager-hash-drift
tasks: [T11528]
kind: refactor
summary: remove obsolete migration-manager hash-drift Sub-case B (E6-L8) now that all DDL is owned by immutable Drizzle forward migrations
---

E6-L8 of the SG-DB-SUBSTRATE-V2 store rewrite (saga T11242, epic T11249). Removes the post-hoc hash-drift repair sub-case in reconcileJournal that UPDATEd a journal entry hash in place when its name matched a local migration but its hash differed. Migration files are immutable post-release (Drizzle v1.0.0-rc.3 contract, E6 L1-L7), so name-matched hash drift can no longer occur. reconcileJournal now has exactly two Scenario-2 sub-cases: A (DB-ahead skip) and B (true-orphan delete + re-probe). Tests rewritten to pin the two-sub-case contract.
