---
id: t12729-rotation-sidecar
tasks: [T12729]
kind: fix
summary: backup rotation removes the rotated backup's sidecar and sweeps orphan sidecars, so cleo backup list stops listing deleted backups
---

Rotation deleted `<file>.<backupId>.meta.json`, a name no sidecar has (they are written as `<backupId>.meta.json`), so every rotated backup left its sidecar behind and `cleo backup list` kept listing it. Rotation now removes a sidecar of its backup type once none of the files it lists is left, which also cleans up the orphans earlier builds left. A pinned sidecar, a malformed one, and one listing no files are never removed.
