---
id: flag-checker-inline-registry-args
tasks: [T14671]
kind: fix
summary: "The command-existence gates check flags on commands with inline registry args, such as cleo check schema"
---
- The shared flag checker now reads `args: paramsToCittyArgs(getOperationParams(...))`
  written inline, so `cleo check schema --bogus` is reported.
- Its message for an unknown sub-command flag now says the CLI rejects it with
  `E_UNKNOWN_FLAG`; the runtime checks flags along the whole command path, so
  no flag is accepted and discarded.
- The `{{TASK_TREE_CMD}}` token is now `cleo tree`, followed by the root task id,
  instead of the removed `cleo list --tree`.
- The ct-documentor `--allow-similar` sample includes the `--new-because` reason
  the CLI now requires.
