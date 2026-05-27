# T9040 — Parent-rollup Gate Auto-completion

## Status: complete

## What was built

### `packages/core/src/tasks/coordination-parent.ts` (new)
- `isCoordinationParent(task, childrenCount)` — detects tasks with no own files acting as scope containers; respects `noAutoComplete=true` opt-out
- `buildRollupEvidence(parentId, children)` — synthesizes `TaskVerification` from children's gate state; `implemented=true` always, all other gates derive from children

### `packages/core/src/tasks/complete.ts` (modified)
- Added T9040 coordination parent rollup block after existing epic auto-complete block
- When the last child of a non-epic coordination parent completes, the parent auto-rolls-up to `status=done` with synthesized verification + `pipelineStage=contribution`

### `packages/core/src/tasks/index.ts` (modified)
- Exports `isCoordinationParent` and `buildRollupEvidence`

### `packages/core/src/tasks/__tests__/coordination-parent-rollup.test.ts` (new)
- 17 tests: 5 integration (completeTask path) + 6 isCoordinationParent unit tests + 7 buildRollupEvidence unit tests

## Commits on task/T9040
- `86c32ac25` — feat(T9040): isCoordinationParent helper
- `3934c3e1c` — test(T9040): integration tests for parent rollup

## Key findings
- Existing epic rollup was scoped to `type='epic'` only; non-epic coordination parents had no auto-complete
- The `files` field on `Task` is the canonical signal for "has own implementation scope"
- `noAutoComplete` opt-out is inherited from the epic pattern and correctly preserved
- Children with no verification record are treated as passing (best-effort rollup for non-enforcement projects)

## Evidence
- implemented: commit 3934c3e1c (worktree branch task/T9040)
- testsPassed: 17/17 vitest tests passed
- qaPassed: biome check passed, tsc build passed
- securityPassed: no network surface
- cleanupDone: closes T1910 manual-rollup workaround
- documented: TSDoc on all exports in coordination-parent.ts
