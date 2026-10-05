---
id: t13146-proc-stat-comm
tasks: [T13146]
kind: fix
summary: The janitor reads a process's start time correctly when its name contains spaces, so an MCP server titled by npm keeps its grace period
---

`cleo` janitor's orphan reaper (Linux) estimated a process's age from `/proc/<pid>/stat`
by splitting the whole line on spaces. Field 2 is the parenthesised process name, which
Node and npm set from `process.title` and which may contain spaces (`(npm exec @playw)`),
so every later field shifted and a wrong number was read as the start time: a young MCP
server could look hours old and lose its grace period. The fields after the name are now
read from after its last `)`.
