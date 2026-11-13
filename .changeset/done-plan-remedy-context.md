---
id: done-plan-remedy-context
tasks: [T14518]
kind: fix
summary: "Done-plan checkout remedies enter the named tree and worktree redirects retain --pr and --run-typed"
---

Branch and commit checkout remedies now enter the checkout before retrying
`cleo done`. Worktree redirects preserve an explicitly supplied `--pr` and
`--run-typed`, while automatic PR discovery stays automatic.
