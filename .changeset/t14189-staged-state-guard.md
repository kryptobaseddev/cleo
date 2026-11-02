---
id: t14189-staged-state-guard
tasks: [T14189]
kind: fix
summary: "the managed pre-commit hook and cleo doctor refuse CLEO runtime state staged at any path, naming the paths and the git reset that unstages them"
---

The managed pre-commit hook refused `.cleo/tasks.db`, `.cleo/brain.db`,
`.cleo/config.json` and `.cleo/project-info.json` only at those exact paths,
so `.cleo` state leaked into an index as ROOT paths (T14189) passed, and
`cleo.db` was not covered at all.

The hook now refuses, at any path:

- `cleo.db`, `brain.db`, `tasks.db` and their `-wal`/`-shm`/`-journal` files;
- a `project-info.json` whose staged content names a `"projectId"`;
- `.cleo/config.json`, or any `config.json` byte-identical to it.

A project's own `config.json` and other files pass. The refusal lists the
paths and the fix (`git reset -q -- <paths>`). `cleo doctor` runs the same rule
as the `staged_cleo_state` check. The previous template is recorded as a
released version, so `cleo upgrade` refreshes an unmodified installed hook.
