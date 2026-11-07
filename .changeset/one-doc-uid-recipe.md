---
id: one-doc-uid-recipe
tasks: [T14332]
kind: fix
summary: "docs migrate, the first docs update and docs add now give a legacy doc the same identity, so devices that took different paths converge on one doc"
---

`cleo docs migrate` minted a legacy doc's identity from its slug alone, while
the first `cleo docs update` (and `cleo docs add`) minted it from the slug and
the doc's creation time. A doc migrated on one device and updated on another
before they synced became two identities for one slug. All three paths now
mint one identity row from synced facts only, so the second device's copy
arrives as a duplicate of the first.
