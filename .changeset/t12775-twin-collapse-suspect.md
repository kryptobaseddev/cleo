---
id: t12775-twin-collapse-suspect
tasks: [T12775]
kind: fix
summary: "twin collapse marks the synced twin it wrote suspect (withSuspectAccounting gets its first production caller)"
---

Twin collapse marks the synced twin it wrote suspect, so the sealer's repair diff covers its writes (journal spec §2.3a rule 3, T12775). It runs the merge inside `withSuspectAccounting`, which now has a production caller. In the global store `brain_sticky_tags` syncs, so its collapse is marked suspect now; the project-scope collapse targets do not sync yet, so there it is a no-op until T12535 declares them.
