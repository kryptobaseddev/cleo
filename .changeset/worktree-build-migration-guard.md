---
id: worktree-build-migration-guard
tasks: [T12687]
kind: fix
summary: A CLI built inside a linked git worktree no longer migrates stores outside that worktree unless CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS=1 is set, and older builds keep journal rows written by newer builds instead of deleting them as orphans
---

Incident, 2026-09-29. cleo-nexus's slice-2 build, which lives inside a linked
worktree, wrote `__drizzle_migrations` row 114 into the live cleocode store.
Path resolution maps a worktree to its parent project's store, so any
worktree-built CLI run migrated the live store with unreleased migrations:
`cleo check arch`, an unsandboxed CLI test, or a reviewer trying a PR build.
The released 9.20 and 9.21 builds then deleted the unknown row as an orphan,
and the next slice-2 open re-ran `ADD COLUMN` and failed.

- `reconcileJournal` and `migrateSanitized` skip a lineage with pending
  migrations when the running code is inside a linked worktree and the store
  is outside that worktree. A message naming both paths and the opt-in goes
  to stderr. The store still opens, so read-only commands keep working
  against the owning store.
- Not affected:
  - installed builds (any path with a `node_modules` segment);
  - builds in a main checkout;
  - stores inside the build's own worktree;
  - scratch stores under a temp dir or a declared test sandbox;
  - stores with nothing pending.
- `reconcileJournal` no longer deletes a journal row stamped later than
  every migration the install knows, across all lineages sharing the
  journal. Such a row came from a newer build and is not an orphan. True
  orphans, which are older, are still pruned. This half protects stores
  from the next release onward.
