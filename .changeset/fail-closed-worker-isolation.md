---
id: fail-closed-worker-isolation
tasks: [T14358]
kind: feat
summary: "with orchestrate.leadWorker.v1 on, a spawn whose worktree provision fails is refused instead of running the agent in the project root"
---

`orchestrateSpawn` and `orchestrateSpawnExecute` now share one
`resolveIsolation()` (`packages/core/src/orchestrate/isolation-policy.ts`) that
decides what a failed worktree provision means. With `orchestrate.leadWorker.v1`
on, `orchestrateSpawnExecute` refuses the spawn with
`E_WORKTREE_PROVISION_FAILED` and hands the claim back; no agent runs in the
project root. With the flag off (the default) it still falls back to the
project root. `orchestrateSpawn` already refused a failed provision and is
unchanged. A worktree held by a live holder is always refused.
