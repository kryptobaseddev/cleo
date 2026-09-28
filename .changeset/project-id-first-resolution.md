---
id: project-id-first-resolution
tasks: [T12470]
kind: feat
summary: "Projects resolve by the id they declare (.cleo/project-id, then project-info.json), never by a hash of their path; a checkout that merely declares a registered id is recorded as an unconfirmed candidate location"
---

`resolveProjectByCwd` (`@cleocode/paths`) now returns the declared project id —
the tracked `.cleo/project-id`, then `project-info.json`'s `projectId` — instead
of `sha256(gitRoot|name|remote)`. Moving or re-cloning a project keeps its id.
The former path fingerprint survives as `computePathFingerprintId` /
`projectPathFingerprint` (the old names are deprecated aliases) and is used only
as a key into `nexus_project_id_aliases`, so old path-derived ids still resolve.
`ResolvedProject` gains an optional `source` (`tracked` | `project-info`).

Because `.cleo/project-id` is committed, any directory can declare any id. The
per-command encounter therefore never repoints an existing registry row (or its
permissions) to a new path: the path is recorded in `nexus_project_locations`
with the new state `candidate`. It is promoted only by `cleo init` /
`cleo nexus register` / `cleo doctor project-identity --resolve`, or when the
row's previous path on this device is gone and its recorded git root commit or
remote matches. Migration `20260928000000_t12470-location-candidates` adds the
`candidate` state and the `git_root_commit` / `git_remote` evidence columns.

`nexus analyze` and the startup health check no longer call `nexusRegister` /
`nexusReconcile`; they record an encounter, which never mints an id or writes
`.cleo/project-id`. `nexusReconcile` refuses a project that declares no id.

A `.cleo/` holding only `project-id` counts as a project root only at a git
toplevel, so a monorepo subdirectory does not shadow its parent. Brain's
`getCleoProjectDir` uses the registry path only when it names the caller's own
checkout.

**Telemetry key change:** `skills_usage_log.project_id` (usage recorder) and the
session manifest `project_id` now carry the declared project id instead of the
12-hex path fingerprint. Rows written before this change keep the fingerprint;
join them through `nexus_project_id_aliases`.
