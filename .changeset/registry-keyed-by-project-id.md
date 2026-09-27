---
id: registry-keyed-by-project-id
tasks: [T12469]
kind: feat
summary: "The project registry is keyed by project_id alone: no UNIQUE path or path hash, and a new nexus_project_locations table records every checkout on every device, marking vanished paths missing instead of deleting them"
---

ADR-094 made `.cleo/project-id` the portable project identity, but the global
registry still treated a path as an identity: `nexus_project_registry.project_path`
was `UNIQUE`, registration looked owners up by path OR path hash OR id, and the
device-local path map deleted a checkout as soon as its directory vanished.

**Registry.** A cleo-global migration rebuilds `nexus_project_registry` without
the `UNIQUE` on `project_path` (the drizzle schema also drops `.unique()` from
`project_hash`). Every row is copied verbatim; aliases are untouched. The row's
`project_path` names the most recently encountered checkout. `brain_db_path` /
`tasks_db_path` are no longer read: the store path is derived from the project
path at runtime (the columns are still written as a mirror for older binaries
that share the global store).

**Locations.** New `nexus_project_locations(project_id, device_id, path,
first_seen, last_seen, state)` with primary key `(project_id, device_id, path)`
and `state` in `live | missing | superseded`. The device id is the existing
stable `<cleoHome>/device-id`. The migration backfills every path-map and
registry row as a `live` location under the device sentinel `local`, which the
runtime re-keys to the real device id on the next write.

When a checkout is recorded, this device's other live locations of the project
whose directory is gone become `missing`, and another project's location at the
same path becomes `superseded`. Nothing is deleted except by `nexus unregister`
or `nexus projects clean`.

**Ownership by id only.** `nexusRegister`, the per-command encounter and
`nexusReconcile` find the owner by `project_id` alone. A path whose project-id
changed now registers the new project instead of failing with an identity
conflict, and a path-derived alias owned by another project is kept with its
owner and reported instead of aborting registration.

**Behaviour change — `nexusReconcile` scenario 4 removed.** Reconcile used to
throw `Project identity conflict` (`NEXUS_REGISTRY_CORRUPT`, exit 75) when the
current path's hash was registered to a different project id. A path is now a
location, not an identity: reconcile looks up the project id only, and a new
id at a registered path is auto-registered (`status: 'auto_registered'`).

**One registry row per real path (older-binary compatibility).** The column is
no longer UNIQUE, but writers never leave two registry rows naming the same
path, because older binaries sharing the global store still look rows up by
path (`WHERE project_path = ? LIMIT 1` in the id-drift check, and a path OR
hash OR id owner filter) and would pick the stale row. When a path changes
hands, the previous holder's row is re-homed in the same transaction: to its
most recent other live location on this device, or, when it has none, to the
non-path sentinel `superseded:<project_id>` (with a matching hash and null
store paths), which no path lookup can match. Its location at the old path is
marked `superseded`.

**Legacy path map dual-written.** `nexus_project_paths` is still written
(upsert only) and still cleared by unregister/clean, so older binaries keep
reading a current map. It is scheduled for removal in a later release.
