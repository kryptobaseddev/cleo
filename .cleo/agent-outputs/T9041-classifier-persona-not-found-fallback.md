# T9041 — Classifier Persona-Not-Found Fallback

## Summary

Fixed `classifyTask` in `packages/core/src/orchestration/classify.ts` to fall back to
`cleo-subagent` when the classified persona is not installed in the live registry, instead
of throwing `ClassifierUnregisteredAgentError` / `E_AGENT_NOT_FOUND`.

## Root Cause

In the T1910 orchestration failure, the classifier correctly scored tasks to specific personas
(`project-security-worker`, `project-code-worker`) but those personas were not attached to
the project. The post-scoring registry validation at line 544–546 threw
`ClassifierUnregisteredAgentError`, which was surfaced as `E_AGENT_NOT_FOUND`, rejecting
the spawn even though worktree provisioning had already succeeded.

## Fix

**File:** `packages/core/src/orchestration/classify.ts`

When `bestRule.agentId` is absent from `allowedIds`:
- Emit a warning containing the orphaned persona ID and a `cleo agent attach` fix hint
- Return `cleo-subagent` with `usedFallback: true` and `originalAgentId` preserving the
  classified persona for audit-log surfacing
- Only throw `ClassifierUnregisteredAgentError` when `cleo-subagent` itself is absent from
  the allowed vocabulary (broken registry — must be surfaced as an error)

New field added to `ClassifyResult`:
```typescript
originalAgentId?: string;
```

## Tests

**File:** `packages/core/src/orchestration/__tests__/classify.test.ts`

Updated 3 existing tests (removed throw assertions, replaced with fallback assertions).
Added 4 new tests:
1. `falls back to cleo-subagent when resolved agent is absent from allowedAgentIds`
2. `warning contains the missing persona ID and a fix hint`
3. `preserves original confidence in fallback result when persona not installed`
4. Integration test: `falls back to cleo-subagent when classified persona is absent from live registry` (in-memory DB, exercises persona-not-found path end-to-end)
5. `still throws when cleo-subagent itself is absent from allowedAgentIds (broken registry)`

Total: 37 tests pass (all).

## Commit

`2dc948858087ba76b0e6bf6f85cd1c9683d72a90` on branch `task/T9041`

## Acceptance Criteria

1. Falls back to cleo-subagent when classified persona not installed — DONE
2. Warning emitted with persona ID — DONE (includes `cleo agent attach` fix hint)
3. Spawn proceeds successfully (worktree + prompt resolution) — DONE (no throw)
4. Integration test exercises persona-not-found path — DONE
