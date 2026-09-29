---
id: worktree-build-migration-guard
tasks: [T12687]
kind: fix
summary: A CLI built inside a linked git worktree can no longer change the schema of a store outside that worktree unless CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS=1 is set, and older builds keep journal rows written by newer builds
---

Incident, 2026-09-29. cleo-nexus's slice-2 build, which lives inside a linked
worktree, wrote `__drizzle_migrations` row 114 into the live cleocode store.
Path resolution maps a worktree to its parent project's store, so any
worktree-built CLI run changed the live store's schema. The released
9.20/9.21 builds then deleted the unknown row as an orphan, and the next
slice-2 open re-ran `ADD COLUMN` and failed.

- **One decision per store, enforced on the handle.**
  `installSchemaWriteGuard` runs on every writable open: the dual-scope
  chokepoint, `openCleoDb`, and every raw writable open. When the build may
  not change the store's schema, it installs a SQLite authorizer that denies
  `ALTER`, `DROP` and any `CREATE` of an object that does not exist yet. That
  covers every DDL site on the handle at once: drizzle migrations,
  `ensureColumns`, the raw `attachments` ALTERs, table rebuilds, twin
  collapse and exodus. A no-op `CREATE … IF NOT EXISTS` and data writes stay
  allowed. A coverage test fails on any writable open that neither installs
  the guard nor carries a `schema-guard-exempt:` reason.
- **Fail fast, not later.** With pending migrations, `reconcileJournal` and
  `migrateSanitized` throw `E_WORKTREE_BUILD_SCHEMA`. The error names the
  build worktree, the store, the pending migrations and the opt-in. A denied
  DDL elsewhere is reported with the same error instead of a bare `not
  authorized`. A store the build is compatible with (nothing pending, no DDL
  needed) opens and reads normally.
- **Dev builds carry a stamp.** The build writes
  `dist/build-provenance.json` naming the linked worktree it was made in, or
  null for a main checkout or CI clone, which is how releases are built. The
  stamp travels with `npm pack` and with copies, so a packed worktree build
  installed globally is still recognised. Without a stamp, the build's own
  path decides, and `node_modules` counts as installed.
- **Narrow exemptions.** Only stores inside the build's own worktree and the
  test harness are exempt. The harness is identified by `VITEST`, or by the
  `.cleo-test-sandbox` marker `vitest.setup.ts` writes at each fork sandbox,
  for CLI children that tests spawn. A temp directory alone is not exempt.
- **Older builds keep newer journal rows.** `reconcileJournal` no longer
  deletes a journal row stamped later than every migration the install
  knows, across the lineages sharing the journal. Such a row came from a
  newer build. True (older) orphans are still pruned.
