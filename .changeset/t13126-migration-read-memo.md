---
id: t13126-migration-read-memo
tasks: [T13126]
kind: fix
summary: Opening a store reads and hashes each migration lineage once, not about a dozen times
---

Every command that opens a store reconciles the migration journal. The reconciliation
helpers each called drizzle's `readMigrationFiles`, which reads every `migration.sql` in a
lineage and hashes it. They did so on the same lineage and its sibling lineage, several
times per open and twice per command. The result was about 12 MB of throwaway strings and
the matching hashing CPU on every command, read verbs included.

`store/migration-files.ts` now memoizes `readMigrationFiles` per folder. The cache key
includes each migration's name, size and mtime, so a rewritten or added migration is
always re-read. Each caller gets its own array. A failed read is never cached.

Migrations, journal reconciliation and their results are unchanged. With the other
startup changes in place, `cleo show` runs in about 0.38 s instead of about 0.43 s.
