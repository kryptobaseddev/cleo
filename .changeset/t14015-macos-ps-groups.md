---
id: t14015-macos-ps-groups
tasks: [T14015]
kind: fix
summary: Process-group lookup works on macOS when one pid is out of range
---

`processGroupsOf` batches its pids into one `ps` call. On macOS, `ps` prints
nothing when any pid is out of range ("process id too large"), so every
group came back unknown. A failed call that printed nothing now falls back
to one `ps` per pid.
