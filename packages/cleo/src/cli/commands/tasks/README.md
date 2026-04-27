# Task CLI Command Layout

There is intentionally no `packages/cleo/src/cli/commands/tasks.ts` router today.
The CLI uses flat citty root commands for task operations:

- `add.ts` owns `cleo add` and dispatches `tasks.add`.
- `update.ts` owns `cleo update` and dispatches `tasks.update`.
- `list.ts` owns `cleo list` and `cleo ls`, dispatching `tasks.list`.
- Task import/export helpers stay in `import-tasks.ts` and `export-tasks.ts`.

Compatibility aliases belong in the command file that owns the user-facing flag,
before dispatch. The wire params sent to the dispatch layer stay canonical:
`parent`, `role`, and `notes`, not legacy `parentId`, `kind`, or `note`.

Create a `tasks.ts` command group only if the CLI adds a real
`cleo tasks <subcommand>` surface. Until then, split files are the canonical task
CLI layer.
