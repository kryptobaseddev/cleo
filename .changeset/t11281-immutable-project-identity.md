---
id: t11281-immutable-project-identity
tasks: [T11281]
kind: fix
summary: Project identity is now immutable for life — registerProjectOnEncounter registers the stored project-info id (not the path-derived canonical id), updating only projectPath + projectHash on move/rename/export-import; canonical id recorded as alias. Idempotent under the fire-and-forget race. Fixes the canonical-id-vs-stored-id reconcile conflict (reconcile 5/5, nexus-e2e 25/25, nexus suite 372 pass, 0 regressions)
---
