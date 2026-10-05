---
id: t12987-sync-repair-diff
tasks: [T12987]
kind: feat
summary: Sync journal S3d: the repair diff re-checks every row of each suspect table, emits I/U/D repair ops in a repair frame (via repair), and clears the suspect mark only after verification; cleo doctor sync-journal plans it, --repair runs it.
---

Rows written uncaptured (a bracketed rewriter, a quarantined capture, rows a migration changed while their table was suspect) are found by comparing every live row with its row meta content hash. A U carries the full after-image and no before-image (only the hash was kept). A held row is never repaired. A table whose row meta was never baselined is baselined (genesis HLC from its modification column, no op) instead of journaling every pre-sync row. The suspect mark clears only when no capture is waiting, a rescan is clean and the ledger equals count plus held.
