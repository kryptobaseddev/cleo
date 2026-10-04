---
id: t13176-reconcile-stale-plan-row
tasks: [T13176]
kind: fix
summary: cleo release reconcile completes the existing release row for the version instead of failing on UNIQUE tasks_releases.version
---

`cleo release reconcile v2026.10.4` failed with `UNIQUE constraint failed:
tasks_releases.version`. The `planned` row for the version carried another id:
the plan had been run from a worktree, where the project hash (and so the row id
`<hash>:<version>`) derives from the worktree path. Reconcile computed its own
`<hash>:<version>` id from the main checkout and inserted, conflicting on the
UNIQUE version index rather than on the id.

Reconcile now reads the existing row for the version first and updates it under
its own id (`INSERT ... ON CONFLICT (id) DO UPDATE`, never a REPLACE, which
would cascade into the row's children), filling in the plan's scheme, channel,
epic, kind, previous version, bump PR, planned time and the current project
hash. Release commits, changes and artifacts link to that id. A version with no
row yet still gets `<hash>:<version>`.

Such a row keeps its id, so its id prefix no longer equals its `project_hash`
column. Nothing looks a release up by a composed `<hash>:<version>` id (plan,
reconcile and the manifest writers find rows by version), so the mismatch is
cosmetic; an id prefix is not proof of the project hash.
