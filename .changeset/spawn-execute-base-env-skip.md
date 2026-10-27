---
id: spawn-execute-base-env-skip
tasks: [T14046, T14057]
kind: fix
summary: "orchestrate spawn-execute takes --base and refuses on a bad base; its auto-complete honours CLEO_NO_AUTO_WORKTREE_COMPLETE"
---

`cleo orchestrate spawn-execute <id> --base <ref>` creates the task branch from
`<ref>`, as `cleo orchestrate spawn --base` does. The ref is threaded through
the CLI, the `orchestrate.spawn.execute` operation (`baseRef`) and
`spawnWorktree`. When provisioning fails under `--base` (a ref that does not
resolve, or a worktree on another base) the spawn is refused instead of running
the agent unisolated in the project root.

After a successful spawn, the auto-complete step now checks
`CLEO_NO_AUTO_WORKTREE_COMPLETE` through the same `integrationDisabledReason`
`cleo complete` uses: the merge is skipped, the worktree and branch are kept,
and a `complete-skip` row with `reason: 'env-override'` is written to the
lifecycle audit log (worktree-lifecycle MUST-19).
