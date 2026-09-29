---
id: project-json-identity
tasks: [T12716]
kind: feat
summary: "One committed `.cleo/project.json` {schemaVersion, id, name} holds the project identity; the tracked id always wins, and a legacy project migrates only through `cleo doctor project-identity --resolve` (ADR-096, amends ADR-094)"
---

The project id was stored three times (`.cleo/project-id`, the gitignored
`project-info.json`, the registry), and `decideProjectIdentity` kept the local
id on conflict while every reader preferred the tracked one. The name had no
committed home.

- **`.cleo/project.json`** is the canonical tracked identity: a write-once id
  and a display name that only `cleo project rename` (and
  `cleo upgrade --name`) change. New projects get it at `cleo init`, with
  `.cleo/project-id` kept as a legacy mirror so older builds read the same id.
- **One resolver, tracked id wins.** `readPortableProjectId` reads
  `project.json`, then `project-id`; `decideProjectIdentity`,
  `readDeclaredProjectIdentity`, `getProjectInfo` and the registry agree.
  `project-info.json` is device-local; its `projectId` is a cache.
- **Migration only through the doctor.** `cleo doctor project-identity`
  reports `legacy`; `--resolve --dry-run` prints the plan and `--resolve`
  writes `project.json` from `project-id` and the cached name (and allows it
  in a pre-T12716 `.cleo/.gitignore`). No id changes; init, upgrade and open
  never migrate. A conflict re-key keeps the old id as an alias; when both
  ids are registered, the cached-id row is folded into the tracked row with a
  `merge-identity` audit receipt (never unregistered). Credentials sealed
  under an old id (cache, receipts or alias table) are re-wrapped during the
  re-key.
- **Name.** `getProjectDisplayName(root)` is the single accessor
  (`project.json`, then the legacy cache, then the basename), also used by
  Studio. The doctor
  reports registry-label drift and `--resolve` syncs it. Rename reports
  `relink-required` for a Nexus-linked project.
- **Root marker** accepts `project.json` / `project-id` at a git toplevel.
- **`projectHash` (AC8, decided: path-derived):** a fresh init keeps the
  realpath hash. A hash stays stable across the loss of the untracked
  project-info.json only if it can be re-derived from disk, so no project's
  hash ever changes. The id-derived formula stays only where T12558 already
  used it (`--new-identity`).
- **Legacy renames** write `project-info.json` `displayName`, so the path
  fingerprint alias key never moves.
