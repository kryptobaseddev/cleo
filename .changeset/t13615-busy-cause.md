---
id: t13615-busy-cause
tasks: [T13615]
kind: fix
summary: "Busy-database retries now recognise a lock error wrapped by the query layer"
---

CLEO retries a write when SQLite reports the database is busy. The check only
read the error's own message, but the query layer (drizzle) wraps a failed
query as "Failed query: …" and keeps the real "database is locked" error
underneath, so those writes were never retried. The check now also looks a
few levels into the wrapped cause and recognises SQLite's busy result code.
