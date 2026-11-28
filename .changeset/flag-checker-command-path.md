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
- Skill and subagent prompt injection refuses `{{TASK_TREE_CMD}}` with no root
  id after it (a token with a value, a `<placeholder>` or a task id): it throws
  `VALIDATION_ERROR` instead of handing an agent a bare `cleo tree`, which the
  CLI refuses without its root id.
- `cleo tree` takes `--with-deps`, the kebab-case spelling the CHANGELOG
  documents; `--withDeps` keeps working as an alias.
