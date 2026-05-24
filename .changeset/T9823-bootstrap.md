---
"@cleocode/cleo": patch
"@cleocode/core": patch
"@cleocode/worktree": patch
---

fix(orchestrate): bump spawn timeout 60s→180s + wire --orchestrator-defer CLI flag

T9823: large-repo `git worktree add` (10k files, ~95s) exceeded both
`DEFAULT_GIT_TIMEOUT_MS` and `SPAWN_BUDGET_MS` (60s each). Bumped both
to 180s — still bounds wedged children, accommodates real workloads.

T10430: error hint for `E_ATOMICITY_NO_SCOPE` instructed orchestrators to use
`--scope orchestrator-defer`, but `--scope` maps to sparse-checkout
(`spawnScope`), not atomicity. Added a new `--orchestrator-defer` boolean
flag that flows through `atomicityScope` → `composeSpawnPayload` scope →
`checkAtomicity` waiver. Error hint updated to reference the real flag.

Saga: T9862
