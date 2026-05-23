---
id: t10203-napi-step-exports
tasks: [T10203]
kind: feat
summary: napi exports for worktrunk-core SDK step primitives (SAGA T10176)
---

Wraps each worktrunk_core step + lifecycle primitive (pruneWorktrees, promoteBranch, relocateWorktree, copyIgnored, removeDir, syncWorktree, runStep) as a thin napi binding. Unblocks T10204 (TS rewire of packages/worktree/src/worktree-prune.ts).
