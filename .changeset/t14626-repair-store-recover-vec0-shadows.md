---
id: t14626-repair-store-recover-vec0-shadows
tasks: [T14626]
kind: fix
summary: "repair-store keeps vec0 vector tables when sqlite3 3.46 (Ubuntu 26.04) recovers the damaged store"
---

`cleo doctor repair-store` hands each damaged store view to the system `sqlite3`
CLI's `.recover`. sqlite3 3.46.1, the version Ubuntu 26.04 ships, leaves out the
`.dbconfig defensive off` line that 3.47 and later emit. Its defensive shell then
refused the `sqlite_schema` row of each vec0 virtual table, so the recovered copy
held `<table>_info` and the other vec0 shadow tables with no virtual parent.
Salvage copied those orphans into the repaired store's module-owned shadow tables,
and SQLite refused the write (`table vectors_info may not be modified`), so the
repair failed with `E_DB_CORRUPT`. Ubuntu 24.04's sqlite3 3.45.1 is built without
`sqlite_dbpage`, so `.recover` never ran there and the bug stayed hidden.

The recovered SQL is now applied with defensive mode off, so the virtual parent
is restored, and salvage never copies a table the destination's module owns,
whatever the recovery tool produced.
