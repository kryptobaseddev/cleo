---
id: spawn-execute-refusal-cleanup
tasks: [T14396]
kind: fix
summary: "a refused orchestrateSpawnExecute removes the worktree its own failed provision created, as orchestrateSpawn does"
---

When `orchestrateSpawnExecute` refuses a failed worktree provision (with
`orchestrate.leadWorker.v1` on, or a `--base` asked for), it now runs the same
`shouldCleanUpFailedProvision` cleanup as `orchestrateSpawn`: a worktree the
failing call freshly created is removed, and the result is reported under
`details.cleanup`. Any other failure, including a lock refusal, leaves the
existing worktree untouched.
