---
id: lossless-store-repair
tasks: [T14548]
kind: fix
summary: "Store repair: preserve readable post-snapshot rows and commit recovery atomically"
---

Adds `cleo doctor repair-store` for project and global stores, with immutable
quarantine copies, salvage with and without the original WAL, timestamp-aware
merging, migrations, validation and per-table receipts. Incompatible columns,
conflicts and deletion accounting remain available in a quarantine recovery file. Backup recovery uses the
same lossless path by default; `--no-delta` retains snapshot-only restoration.
Canonical store opens repair corruption only after proving exclusive access;
otherwise `E_DB_CORRUPT` names the one-command fix.
