---
id: retire-branch-lock-wrappers
tasks: [T10875, T10876, T10877]
kind: refactor
summary: "Branch-lock no longer re-exports the facade's getGitRoot; worktree lifecycle ownership is documented"
---

After the T10853 refactor, `packages/core/src/spawn/branch-lock.ts` holds only
lifecycle policy over the `@cleocode/worktree` facade, with no raw
`git worktree` call (lint-enforced). Its leftover re-export of the facade's
`getGitRoot` is removed; the core barrels (`internal`, `spawn`) export
`getGitRoot` straight from `@cleocode/worktree`, so the public name is
unchanged. The worktree-lifecycle spec now names `branch-integration.ts` as the
home of the integration decision and audit log.

Migration: import branch integration (`getDefaultBranch`,
`planWorktreeIntegration`, `completeAgentWorktreeViaMerge`,
`completeAgentWorktreeIntegration`, `integrationOutcome`) from
`spawn/branch-integration.js`, lifecycle (`createAgentWorktree`, now async,
`pruneWorktree`, `readWorktreeLifecycleState`) from `spawn/branch-lock.js`, and
git worktree primitives from `@cleocode/worktree`.
