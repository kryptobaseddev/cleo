---
id: table-classification-gate-a
tasks: [T12332]
kind: feat
summary: Every table in the project and global cleo.db carries a replication class, and an unclassified table fails a gate
---

**Gate A (T12332, epic T12322).** Before any byte leaves a device, every
physical table has to say whether it syncs, stays local, is derived, or is a
secret. Otherwise a new table either never reaches another device or leaks to
it, and nothing reports either outcome.

- **Contracts** (`table-classification.ts`, types only): `TableClass`
  (`portable-project`, `portable-personal`, `portable-secret`, `local-only`,
  `derived`), per-column overrides (`portable-secret`, `local-only`, `strip`,
  with an optional JSONPath), a per-row router, and the registry entry and
  scope shapes.
- **Registry** (`core/src/store/table-classification.ts`): project and global
  scopes keyed on PHYSICAL names from `sqlite_master`. It covers both halves
  of every twin pair, marks the 31 frozen bare twins `frozen-legacy`
  (dropped in T12535), and adds pattern rules for FTS5/vec shadows and exodus
  scratch tables. `classifyTable(scope, name)` is pure.
- **Gate test** (`store/__tests__/table-classification-gate.test.ts`): builds
  fresh project and global stores through the chokepoint plus every
  lineage-running domain binder, then fails on any unclassified table. It
  runs the same check against the committed `sqlite_master` name dump of a
  live project store (frozen twins, lazily created FTS). It also fails on a
  stale entry, a pending table that no longer exists, or a column override
  that names a column that is not there.
- **Raw-writer ratchet** (`scripts/lint-no-raw-table-writes.mjs`, arch gate
  27): at introduction there are 249 raw `INSERT`/`UPDATE`/`DELETE`/`REPLACE`
  sites on classified tables across 76 files, all baselined. A new site
  fails. A removed site also fails until the baseline drops it.

Four tables are pending an owner ruling and carry no class:
`brain_v2_candidate` and `session_terminal_bindings` (project),
`nexus_devices` and `nexus_project_locations` (global).
