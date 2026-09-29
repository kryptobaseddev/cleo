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
  never migrate. A conflict re-key keeps the old id as an alias, and
  credentials sealed under it are re-wrapped on their next open.
- **Name.** `getProjectDisplayName(root)` is the single accessor
  (`project.json`, then the legacy cache, then the basename). The doctor
  reports registry-label drift and `--resolve` syncs it. Rename reports
  `relink-required` for a Nexus-linked project.
- **Root marker** accepts `project.json` / `project-id` at a git toplevel.
- **Portable `projectHash`:** a new hash derives from the id, so every clone
  shares it; stored hashes never change.
