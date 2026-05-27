# Worktree Legacy API Migration (T1624)

Per ADR-062, the legacy cherry-pick worktree integration was outright deleted
in T1624 with **zero backwards-compat shims**. Cherry-pick rewrote commit SHAs
and destroyed git provenance; merge --no-ff preserves the full agent commit
graph so `git log --grep "T<id>"` returns originating commits with original
authorship.

> **TL;DR**: Replace `completeAgentWorktree(id, root)` with
> `completeAgentWorktreeViaMerge(id, root)`, and `WorktreeCompleteResult` with
> `WorktreeMergeResult`.

## What was removed

| Legacy API                                         | Package            | Removed in |
|----------------------------------------------------|--------------------|------------|
| `completeAgentWorktree(taskId, projectRoot)`        | `@cleocode/core`   | T1624      |
| `WorktreeCompleteResult` (type)                     | `@cleocode/contracts` | T1624   |
| `E_CHERRY_PICK_FAILED` (error code)                 | `@cleocode/contracts` | T1624   |
| `cherryPickFirst` option in `DestroyWorktreeOptions`| `@cleocode/contracts` | T1624   |
| `cherryPicked` / `commitCount` in `DestroyWorktreeResult` | `@cleocode/contracts` | T1624 |

## API mapping

| Old API                                    | Replacement                                         |
|--------------------------------------------|-----------------------------------------------------|
| `completeAgentWorktree(taskId, root)`      | `completeAgentWorktreeViaMerge(taskId, root)`       |
| `completeAgentWorktree(taskId, root)` (orchestrator-level) | `completeAgentWorktreeIntegration(taskId, root)` |
| `WorktreeCompleteResult.cherryPicked`      | `WorktreeMergeResult.merged`                        |
| `WorktreeCompleteResult.commitCount`       | `WorktreeMergeResult.commitCount` (preserved)       |
| `WorktreeCompleteResult.error`             | `WorktreeMergeResult.error` (preserved)             |
| `E_CHERRY_PICK_FAILED`                     | `E_MERGE_FAILED`                                    |
| `DestroyWorktreeOptions.cherryPickFirst`   | *removed — integration is separate via merge*       |
| `DestroyWorktreeResult.cherryPicked`       | *removed — integration is separate via merge*       |
| `DestroyWorktreeResult.commitCount`        | *removed — integration is separate via merge*       |

### Return type differences

`WorktreeMergeResult` adds fields not present in the legacy
`WorktreeCompleteResult`:

| Field             | Type    | Description                                        |
|-------------------|---------|----------------------------------------------------|
| `targetBranch`    | string  | Branch merged into (project-agnostic)              |
| `mergeCommit`     | string  | SHA of the merge commit (empty if no commits)      |
| `rebased`         | boolean | Whether rebase onto target succeeded               |
| `branchDeleted`   | boolean | Whether `task/<taskId>` was deleted post-merge     |

## Code migration examples

### Basic: complete a task worktree

```typescript
// BEFORE (legacy — deleted in T1624)
import { completeAgentWorktree } from '@cleocode/core/spawn/branch-lock';

const result: WorktreeCompleteResult = completeAgentWorktree('T1234', projectRoot);
// result.cherryPicked, result.commitCount, result.error

// AFTER (current — ADR-062)
import { completeAgentWorktreeViaMerge } from '@cleocode/core/spawn/branch-lock';

const result: WorktreeMergeResult = completeAgentWorktreeViaMerge('T1234', projectRoot);
// result.merged, result.mergeCommit, result.commitCount, result.rebased,
// result.targetBranch, result.worktreeRemoved, result.branchDeleted, result.error
```

### Orchestrator-level: with audit logging

```typescript
// BEFORE — orchestrators called completeAgentWorktree directly
import { completeAgentWorktree } from '@cleocode/core/spawn/branch-lock';
const result = completeAgentWorktree(taskId, projectRoot);

// AFTER — use the integration wrapper for audit trail
import { completeAgentWorktreeIntegration } from '@cleocode/core/spawn/branch-lock';
const result = completeAgentWorktreeIntegration(taskId, projectRoot, {
  taskTitle: 'original task title for merge commit message',
});
// result.auditLogEntry — path to .cleo/audit/worktree-integration.jsonl entry
```

### Error handling

```typescript
// BEFORE
import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts';
if (errorCode === BRANCH_LOCK_ERROR_CODES.E_CHERRY_PICK_FAILED) { ... }

// AFTER
import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts';
if (errorCode === BRANCH_LOCK_ERROR_CODES.E_MERGE_FAILED) { ... }
```

### Worktree destroy (no integration — merge first)

```typescript
// BEFORE — cherryPickFirst controlled integration during destroy
const result = destroyWorktree({
  taskId: 'T1234',
  cherryPickFirst: true,  // removed — no longer an option
});

// AFTER — complete merge first, then destroy separately
const mergeResult = completeAgentWorktreeViaMerge('T1234', projectRoot);
if (mergeResult.merged) {
  const destroyResult = destroyWorktree({ taskId: 'T1234', force: true });
}
// DestroyWorktreeResult no longer has cherryPicked/commitCount fields.
```

## Why merge --no-ff?

- **Provenance**: Cherry-pick creates new commits with new SHAs — `git log --grep`
  can't find the original agent commits. Merge --no-ff preserves every
  original commit SHA with original authorship.
- **Conflict surface**: Cherry-pick replays diffs one at a time, creating
  per-commit conflict opportunities. Merge handles the branch as one
  operation.
- **Auditability**: The merge commit message follows the pattern
  `Merge T<id>: <title>`, making it trivial to correlate CLEO task
  completion to git history.

## ADR references

- [ADR-055](../adr/ADR-055-agent-worktree-isolation.md) — worktree-by-default policy
- [ADR-062](../adr/ADR-062-worktree-merge-integration.md) — merge --no-ff rationale
- [T1624 commit](https://github.com/kryptobaseddev/cleo/commit/48b4d8052) — deletion diff

## See also

- `packages/core/src/spawn/branch-lock.ts` — current implementation
- `packages/contracts/src/branch-lock.ts` — type contracts
- `packages/worktree/src/worktree-destroy.ts` — destroy lifecycle (now integration-free)
