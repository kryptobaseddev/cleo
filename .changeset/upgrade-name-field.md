---
id: upgrade-name-field
tasks: [T12716]
kind: fix
summary: "`cleo upgrade --name` now changes the project name: it wrote `projectName`, a field nothing reads"
---

`updateProjectName` (behind `cleo upgrade --name`) wrote `projectName` into
`.cleo/project-info.json`. Every reader uses `name`, so the command reported
success and changed nothing visible. It now writes `name` and removes the
stray `projectName` the bug left behind.
