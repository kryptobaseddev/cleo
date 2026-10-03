---
id: t13104-restore-migration-journal
tasks: [T13104]
kind: fix
summary: A vault restore keeps the snapshot's migration journal, so a restored store opens without stamping migrations it never ran
---

`cleo cloud restore` and `cleo cloud pull` carry this machine's local-only rows into the snapshot before
placing it, so a pull never takes another device's machine state. The migration journal
(`__drizzle_migrations`) is local-only too, so it was carried the same way: a new machine got an empty
journal, and a pull got this machine's old one. The journal describes the database file, not the machine.
On the first open after a restore, the migrator found the snapshot's tables with no journal entries. It
stamped migrations applied without running their SQL (logged as ERROR "Detected partially-applied
migration ... Stamping it applied WITHOUT running its SQL", 17 lines on staging) and re-ran older ones,
which left an extra index on a legacy table.

A restore now keeps the snapshot's own schema state: the migration journal and the conduit and
agent-registry migration ledgers and schema-version sentinels. A restored store has the source's journal
and schema, and its first open has nothing to reconcile. These tables still never sync and the manifest
still never hashes them, so pushes, comparisons and the change journal are unaffected.

`cleo doctor migrations` now reports `rebuilt` for a journal that the migrator rebuilt on a store that
already held its schema (the journal opens with the consolidated baseline stamped, not run). It also gives
the number of stamped rows, so a store restored before this fix is named.
