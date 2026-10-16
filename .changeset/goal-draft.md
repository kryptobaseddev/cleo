---
id: goal-draft
tasks: [T13793]
kind: feat
summary: "cleo goal draft <taskId> [--tasks …] [--out <path>] writes a goal/v1 goal.yaml from task acceptance criteria"
---

Each acceptance criterion becomes a goal criterion whose `proves` names it
(`T123#AC2`):
- typed test, command and lint gates become host `command` checks;
- file gates become `file` or `contains` checks;
- manual gates become `human` checks;
- free text becomes a `verifier` check.

The project's lint and typecheck commands become invariants. The budget follows
the largest task size, `.cleo/**` is protected and `cleo.tasks` lists the tasks.
The default path is `.opencode/goals/<slug>/goal.yaml`. The command never starts
a run and refuses to overwrite an existing file.
