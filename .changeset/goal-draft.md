---
id: goal-draft
tasks: [T13793]
kind: feat
summary: "cleo goal draft <taskId> [--tasks …] [--out <path>] writes a goal/v1 goal.yaml from task acceptance criteria"
---

Each acceptance criterion becomes goal criteria whose `proves` names it by its
canonical uuid (`T123#<uuid>`), and a drafted criterion is never weaker than the
gate it proves:
- A typed gate that goal/v1 expresses exactly becomes host checks. These use
  the gate runner's own executable and default arguments (lint included), with
  the gate's cwd, env and deadline.
- Any other typed gate runs as itself:
  `cleo verify <id> --run --req <REQ> --field /data/passed`. This covers test
  `expect: pass`, `minCount`, `stderrMatches`, regex flags, sizes, sha256 and
  http.
- A gate with neither form becomes a verifier question, which never satisfies
  a gate at close.
- Manual gates become `human` checks; `advisory` gates become non-essential.
- Statements are the gate descriptions.

The project's lint and typecheck commands become invariants. The budget follows
the largest task size, `.cleo/**` is protected and `cleo.tasks` lists the tasks.

The default path is `.opencode/goals/<slug>/goal.yaml`. `--out` must name
`<id>/goal.yaml`, and `<id>` becomes the goal id. Writes stay inside the
project, even through a symlinked parent. The command never starts a run and
refuses to overwrite an existing file.
