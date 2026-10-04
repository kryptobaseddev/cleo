---
id: t12785-exodus-capture-bracket
tasks: [T12785, T12774]
kind: fix
summary: Exodus copies each legacy source inside a rule-1 capture bracket and marks the sync set suspect; the bracket applies rule 2 to declared rebuilds, so a parent rebuild no longer cascade-deletes its children
---

Journal spec §2.3a, rules 1–3.

**Exodus.** Each legacy source's copy is one stage, run in `withSyncTriggersSuspended`. When the target
has sync capture on, its capture triggers are dropped, the source is copied, and the triggers are
reinstalled for the schema, all in the stage's single transaction. Before, the copy ran under live
capture triggers and produced one capture per copied row. Once a scope has written anything, every
sync-set table is marked `suspect:`, and the sealer's repair diff emits the copied rows. Foreign keys
still go off once per scope. They are now asserted to be set outside any transaction, where the pragma
takes effect.

**The bracket.** `withSyncTriggersSuspended` takes `{ rebuilds: [...] }`. Inside a transaction
`PRAGMA foreign_keys` is a no-op, so an undeclared rebuild's `DROP TABLE` cascade-deletes child rows,
uncaptured. With a declaration, the bracket:
- turns foreign keys off before its BEGIN;
- snapshots the violations of the rebuilt tables and their FK children;
- refuses only new violations (`E_SYNC_BRACKET_FK_VIOLATION`, rolled back);
- restores and re-reads the FK mode afterwards, even after a throw.
