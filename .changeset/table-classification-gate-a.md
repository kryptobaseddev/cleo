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
  (dropped in T12535), and adds pattern rules for FTS5/vec shadows (by their
  explicit base and shadow names, never a bare `_fts` suffix or
  `brain_embeddings_` prefix) and exodus scratch tables.
  `classifyTable(scope, name)` is pure.
- **Gate test** (`store/__tests__/table-classification-gate.test.ts`): builds
  fresh project and global stores through the chokepoint plus every
  lineage-running domain binder, then fails on any unclassified table. It
  runs the same check against the committed `sqlite_master` name dump of a
  live project store (frozen twins, lazily created FTS). It also fails on a
  stale entry, ANY pending table (the allowed count is zero), an
  `optional-transient` entry outside a pinned list, or a column override
  that names a column that is not there.
- **Column gate**: a committed per-table column snapshot
  (`fixtures/table-classification-columns.json`, from `PRAGMA table_info` of
  both fresh stores) fails on any added or removed column until it is
  regenerated. A column whose name looks like a credential
  (`/key|token|secret|passw|credential|oauth|_enc$/i`) in a syncing table fails
  outright unless the registry gives it its own class; reviewed
  non-credentials (token counts, idempotency keys, keywords) are pinned in the
  test. The registry's `portable-secret` column overrides and the bundle's
  `CREDENTIAL_COLUMNS` must agree (`accounts.refresh_enc` was missing from
  both and is added).
- **Raw-writer ratchet** (`scripts/lint-no-raw-table-writes.mjs`, arch gate
  28): 227 raw `INSERT`/`UPDATE`/`DELETE`/`REPLACE` sites on classified
  tables across 73 files, all baselined. The canonical accessors are the
  chokepoint and are exempt rather than baselined. Matching is
  case-insensitive and spans lines, and a string-aware lexer blanks comments.
  A new site fails. A removed site also fails until the baseline drops it.

**Two tiers (core owner ruling, 2026-09-28).** Every table in both stores is
backed up whatever its class (tier 1, asserted: `TABLE_CLASS_POLICY` maps
every class to `backup: true`). The class decides only whether a table also
syncs (tier 2). `derived` is deliberately narrow, only FTS5/vec shadows and the
nexus code graph, and a test asserts it. Embeddings, sleep-cycle output and
LLM output sync instead.

No table is pending. `nexus_devices`, `nexus_project_locations` and
`nexus_project_git_state` (T12511, `remote_url` stripped) are
`portable-personal`.
