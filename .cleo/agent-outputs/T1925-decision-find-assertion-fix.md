# T1925: decision.find assertion fix — T1830 includeAgentDispatch param

## Summary

Fixed the exact-match assertion in `memory-brain.test.ts:297` that was broken by T1830.

## Root Cause

T1830 added `includeAgentDispatch: paramBool(params, 'includeAgentDispatch') ?? false` to the `decision.find` handler in `memory.ts` (lines 169-181). The test at line 297 used an exact object match:

```ts
{ query: undefined, taskId: 'T5241', limit: 10 }
```

This did not include `includeAgentDispatch: false`, so the mock received `{ query: undefined, taskId: 'T5241', limit: 10, includeAgentDispatch: false }` but the assertion expected only 3 fields, causing the `toHaveBeenCalledWith` matcher to fail.

Note: The task description mentioned `decisionCategory: 'architectural'` — that was incorrect. The actual field T1830 added is `includeAgentDispatch: false`.

## Fix

Updated the assertion to include the new field:

```ts
{ query: undefined, taskId: 'T5241', limit: 10, includeAgentDispatch: false }
```

## Test Results

- `memory-brain.test.ts`: 35/35 passed (0 failures)
- `packages/cleo/src/dispatch/domains/__tests__/` directory: 940/942 passed, 1 skipped
- Only pre-existing failure: `alias-detection.test.ts` — tasks domain missing `deps.tree` and `deps.validate` (unrelated to T1925, confirmed pre-existed on main)

## LOC Note (owner directive)

The sibling assertion at line 284 uses `expect.objectContaining({ query: 'SQLite' })` which is resilient to new fields. If the exact-match pattern at line 297 recurs on future T1830-style additions, consolidating to `expect.objectContaining(...)` plus a separate assertion for `includeAgentDispatch` would DRY the pattern. Flagged — not refactored here per scope.

## Evidence

- Commit: `7f56b0de5dec3b3ef8e903b8a9e29240d27e31a6`
- Merged: `aa32838e2277a2a60bbb57bdf72bb93b68e9672b` (main)
- Files: `packages/cleo/src/dispatch/domains/__tests__/memory-brain.test.ts`
- Test run: 35 passed, 0 failed
- Lint: exit 0
- Typecheck: exit 0
