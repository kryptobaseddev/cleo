---
id: ci-satisfies-remedy
tasks: [T13096]
kind: fix
summary: "The post-merge testsPassed refusal and cleo doctor name the evidence.ciSatisfies block a project with GitHub workflows should add"
---

After a PR merged, a scoped `testsPassed` (an affected `tool:test` or a
targeted `test-run:`) that did not carry across the merge was refused with
"needs merged CI (ci:<pr>, with evidence.ciSatisfies) or a full run". In a
project with GitHub workflows that never set `evidence.ciSatisfies`, that left
a full local suite as the only way to complete. The refusal now adds a
ready-to-paste block for `.cleo/project-context.json`,
`"evidence": {"ciSatisfies":true,"ciChecks":{"tests":[…],"qa":[…]}}`, built
from the default branch's required checks (branch protection, read-only), or a
`<required check>` placeholder when none can be found. `cleo doctor` reports
the same state as the `ci_satisfies` warning, with the block as its fix.
Projects that already set `evidence.ciSatisfies`, or have no workflows, see no
change.
