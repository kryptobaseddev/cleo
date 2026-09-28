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
`cleo nexus register` / `cleo doctor project-identity --resolve`, or by a
PROVEN move: the row's previous path on this device is gone and this checkout
carries the same per-checkout nonce. The nonce is random, lives in the
checkout's untracked `.cleo/project-info.json` (`checkoutNonce`), and is
recorded on each confirmed location — a real `mv` or a restore of `.cleo/` from
a backup carries it, a clone cannot. Git root commit and remote are recorded
for display only (they are forgeable) and are read with `--no-replace-objects`.
Migration `20260928010000_t12470-location-candidates` adds `checkout_nonce`,
`git_root_commit` and `git_remote` with `ADD COLUMN` (so a store already
migrated by T12469 is detected as needing it) and rebuilds the table to allow
the `candidate` state.

`cleo nexus reconcile` and `cleo init` no longer repoint a row while its
previous location still exists on this device; they record a candidate unless
given `--force-rebind`. `cleo upgrade` / `self-update` register through the
encounter and never move a row.

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
