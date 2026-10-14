---
id: t12942-sticky-status-one-way
tasks: [T12942]
kind: feat
summary: "Sync merges keep sticky notes one-way: converted or archived never returns to active"
---

When two devices sync sticky notes, a sticky that one device archived or
converted never returns to active, and a conversion wins over a concurrent
archive on every device, so the note's status always matches its conversion
target. A second conversion of the same sticky to a different target is
refused and recorded as a conflict instead of silently replacing the first.
