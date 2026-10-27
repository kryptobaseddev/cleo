---
id: core-worktree-facade
tasks: [T10858, T10859, T10860, T10861]
kind: refactor
summary: "Core creates and removes agent worktrees through the @cleocode/worktree facade"
---

`createAgentWorktree` no longer runs `git worktree add`/`lock` itself: it
delegates to the `@cleocode/worktree` `createWorktree` facade (no include copy
or dependency install, as before) and is now async. `pruneWorktree`'s last-resort
removal goes through the new facade helper `forceRemoveWorktreeDir` instead of
raw `git worktree unlock`/`prune`. Core now has no raw `git worktree`
lifecycle call outside the allowlisted list/prune/force-unlock primitives.

Lifecycle audit rows written by the facade now also carry the contract fields
`timestamp`, `actor` and `target` beside the legacy `ts`, `agentId` and
`xdgPath`, so every row in `.cleo/audit/worktree-lifecycle.jsonl` matches
`WorktreeLifecycleAuditEntry`.
