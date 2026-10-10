---
id: t13245-db-inventory-live-store
tasks: [T13245]
kind: fix
summary: the database inventory names .cleo/cleo.db as the live store of tasks, brain and conduit; doctor never quarantines or rewrites it
---

`db-inventory.json` still named `.cleo/tasks.db`, `.cleo/brain.db` and `.cleo/conduit.db`, files nothing reads since consolidation, as the live stores of the `tasks`, `brain` and `conduit` roles. They now name `.cleo/cleo.db` (migrations `drizzle-cleo-project`), with the old file kept as `legacyFilePathTemplate`.

- `cleo doctor db-substrate` inspects the shared file once, never auto-quarantines the live project store (a slow integrity check alone used to trigger it; it suggests `cleo backup recover tasks`), reads the prefixed `tasks_tasks`/`tasks_sessions` tables in its cross-DB checks, and accepts `cleo.db` as the mark of a project root.
- `cleo doctor repair` probes the project store once and points a malformed one at the guarded `cleo backup recover` instead of the plain rename-and-copy pipeline, which now refuses the project-store roles.
- The bundle export's legacy-file list comes from `legacyFilePathTemplate`, so legacy-only projects still export.
