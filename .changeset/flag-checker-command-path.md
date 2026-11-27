---
id: flag-checker-command-path
tasks: [T14673]
kind: fix
summary: "The command-existence gates resolve a command by its path, so cleo tree flags are checked against cleo tree"
---
- The shared flag checker reads a root verb from the export the command
  manifest loads and a sub-verb from its group's `subCommands` binding, not the
  first command in the module with that `meta.name`. `cleo tree` no longer reads
  the args of `cleo deps tree`; `cleo nexus export` and `cleo orchestrator tail`
  are resolved the same way.
- `{{TASK_TREE_CMD}}` renders only when a root id follows it (a token, a
  `<placeholder>` or a task id); a bare token stays unresolved and is reported,
  because `cleo tree` refuses to run without its root id.
