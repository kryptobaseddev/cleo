---
id: t12754-doctor-sync-triggers-repair
tasks: [T12754]
kind: feat
summary: cleo doctor sync-triggers reports triggers that reference a missing table or column, and --repair fixes what CLEO owns
---

A trigger whose body references a dropped table, or inserts into a column its table lacks, makes every write to its table fail, and SQLite only notices when the trigger fires. The `sync_triggers` doctor row now finds these triggers, reads in the WHEN clause included, and reports them as an error. CTE names, table-valued functions, rowid aliases and an FTS5 table's command column are not flagged.

The new `cleo doctor sync-triggers` subcommand shows that row. With `--repair` it runs the open pass's trigger steps on demand and reports the row before and after:
- it recreates `cleo_trigger_suspend`, or clears a committed row;
- it re-runs the owned DDL of every missing, differing or dangling guard and side-effect trigger;
- it makes the capture triggers match `sync.capture`, recreating a missing `_sync_capture`.

A trigger CLEO does not own is reported, never dropped.
