---
id: docs-migrate-noop-dry-run
tasks: [T14331]
kind: fix
summary: "cleo docs migrate writes no snapshot when nothing is left to migrate, and --dry-run prints the plan without writing"
---

Each `cleo docs migrate` run took a full pre-step copy of the store, even when
the store was already migrated: about 1.4 GB per no-op run here. A run whose
plan touches no doc now runs no step and writes no snapshot, and
`cleo docs migrate --dry-run` reports what a run would capture without writing
anything.
