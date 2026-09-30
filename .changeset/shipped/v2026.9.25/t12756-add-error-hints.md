---
id: t12756-add-error-hints
tasks: [T12756]
kind: fix
summary: cleo add parent-refusal errors now name the exact command that works
---

Two `cleo add` refusals told the operator what was wrong but not what to type.

- `--type task` under a task failed with "Use Saga→Epic, Epic→Task, and
  Task→Subtask containment." The fix now says `Use --type subtask` and gives the
  full `cleo add "<title>" --type subtask --parent <task> --acceptance "<criteria>"`
  command (also in `alternatives[]`). The suggestion comes from
  `childTypeForParentType`, so it is right for every parent tier and is omitted
  when no tier fits (a subtask parent).
- Adding a child under a task with its own free-text ACs (PM-Core V2
  design-point 3) now leads with the sibling path, resolved against the task's
  own parent: `cleo add "<title>" --parent <epic> --relates <task> --acceptance
  "<criteria>"` then `cleo update <task> --add-depends <new>`. The decompose
  route stays as the second option. `alternatives[]` carries all three commands
  and `details.siblingContainerId` names the resolved container.
