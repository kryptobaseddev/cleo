---
id: t12512-registry-read-errors-remaining
tasks: [T12512]
kind: fix
summary: "The remaining project-registry readers now fail with the typed E_NEXUS_REGISTRY_READ error (exit 75, with a fix hint) instead of an empty result: `cleo doctor --all-projects`, `cleo nexus projects scan` (which marked every project unregistered and could re-register them all), `cleo nexus projects clean`, `cleo doctor projects`, the `--refresh` git probe, cross-project search/discover/resolve/deps, the fleet-root default and the nightly hygiene digest"
---

PR #1699 made `nexusList`, `readRegistry` and `nexusGetProject` throw
`NexusRegistryReadError` and separated `last_probed_at` from `last_opened_at`.
This change covers the readers that still turned that error into an empty
result, or into a generic `E_INTERNAL`:

- **`cleo doctor --all-projects` / `cleo doctor-projects`** exit 75 with an
  `E_NEXUS_REGISTRY_READ` envelope and its fix. They no longer print "No
  projects registered" and exit 0.
- **`cleo nexus projects scan`** fails typed. It used to treat an unreadable
  registry as empty, which reported every project as unregistered, and with
  `--auto-register` it tried to register all of them again.
- **Registry-derived roots** (`listRegistryParentRoots`: the scan default and
  `cleo doctor db-substrate --fleet`) throw instead of falling back to guessed
  roots. An empty registry still gives `[]`.
- **`cleo nexus projects clean`**, **`cleo doctor projects`** and the
  **`cleo nexus projects status --refresh`** probe return the typed error
  instead of `E_INTERNAL` / `E_DOCTOR_PROJECTS_FAILED`.
- **Cross-project search, discover, resolve, deps, graph, critical path,
  blockers and orphans** keep the typed code, exit code and fix through one
  shared `nexusCaughtToEngineError`.
- **The nightly hygiene digest** records `nexusIntegrity.registryError` and
  reports "registry unreadable", not "0/0 projects healthy".
- `FullHealthReport.registryError` now carries `exitCode` and `fix` as well.

All of these stay read-only. An empty but readable registry is still an
empty result, not an error.
