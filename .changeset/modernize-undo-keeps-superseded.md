---
id: modernize-undo-keeps-superseded
tasks: [T14333]
kind: fix
summary: "A docs modernize rollback no longer puts a superseded doc back to its old status, which other devices refused, so registries stay in agreement"
---

`superseded` is final on every device: no command may move a doc out of it, and
a synced device refuses such a write. A `cleo docs modernize --rollback` used
to put a superseded doc back to its previous status on the rolling-back device
only, so that device disagreed with every other one from then on. The rollback
now keeps a supersession that landed, reports it, and still restores
everything else, including the successor's back pointer.
