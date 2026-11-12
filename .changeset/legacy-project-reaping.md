---
id: legacy-project-reaping
tasks: [T14506]
kind: fix
summary: "Worktree cleanup: recognize own projects with legacy identity files"
---

Own-project checks use the shared portable identity reader, accepting a valid
`.cleo/project-id` when `.cleo/project.json` is absent. Realpaths, store paths
and both identity reads must still agree; missing or invalid identity stays
foreign, including a malformed canonical manifest beside a valid legacy file.

Foreign task snapshots reject main-file changes on close, so a checkpoint that
truncates the WAL between the reaper's checks cannot validate a stale worker
read. Census status reads discard changed snapshots through the same opener.
