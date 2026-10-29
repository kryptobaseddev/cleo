---
id: nexus-analyze-cross-project
tasks: [T14153]
kind: fix
summary: "cleo nexus analyze refuses a path whose graph would land in another project's store; trait ids read one store"
---

The code graph lives in the project's own `cleo.db`, opened through the
store resolver. Under a `CLEO_DIR` pin that is the pinned store, whatever
path is passed, so `cleo nexus analyze <other-project>` wrote another
project's graph into the pinned project's store under the wrong identity.

- **The refusal.** `cleo nexus analyze` now compares the store it would write
  with the path's own project store, and refuses a mismatch with the same
  message `cleo nexus status` already uses (`E_NEXUS_CROSS_PROJECT_ANALYZE`,
  fix `cd <path> && cleo nexus analyze`). Without a pin, a project path
  resolves its own store, so it keeps working.
- **One store for trait ids.** `resolveTraitProjectId` read the tracked id
  from the root and its fallback through the pin. It now reads both from the
  same store.
