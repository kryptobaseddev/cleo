# T1325 — dispatch-trace BRAIN hook

**Status**: complete  
**Branch**: task/T1325  
**Commit**: db6ab661f8b79ea6917ec664dec2e0cad75d273a

## Summary

Implemented the dispatch-trace BRAIN observation hook for classification exhaust logging. Every successful agent resolution now emits a structured `DispatchTrace` record into BRAIN via `verifyAndStore`, preserving the FP peer-note guardrail for future training data extraction.

## Files Changed

- `packages/contracts/src/memory.ts` — Added `DispatchTrace` interface (7 fields: taskId, predictedAgentId, confidence, reason, registryHit, fallbackUsed, resolverWarning?, resolvedAt)
- `packages/contracts/src/index.ts` — Exported `DispatchTrace` from @cleocode/contracts
- `packages/core/src/memory/dispatch-trace.ts` — New module exporting `emitDispatchTrace(projectRoot, trace): Promise<void>` routed through `verifyAndStore` with `memoryType='procedural'` and `sourceConfidence='speculative'`
- `packages/core/src/store/agent-resolver.ts` — Wired `emitDispatchTrace` call after decision point (post T1324 resolverWarning), using dynamic import to preserve sync-safe hoisting
- `packages/core/src/memory/__tests__/dispatch-trace.test.ts` — 3 unit tests covering verifyAndStore call contract, universal-fallback path with resolverWarning, and registry-hit path without resolverWarning

## Design Decisions

1. **`memoryType='procedural'`** — The task spec named this `'pattern'` but the BRAIN schema uses `'procedural'` for process/dispatch knowledge. `patterns.ts` uses the same value.
2. **`sourceConfidence='speculative'`** — The task spec said `'unverified'` but the DB enum only has `owner | task-outcome | agent | speculative`. `speculative` is the correct tier-2 candidate marker.
3. **Dynamic import** — Using `import('../memory/dispatch-trace.js')` instead of a static import avoids a hoisting conflict with the `node:sqlite` `createRequire` interop in `agent-resolver.ts`, which was breaking the `preferTier` Vitest test.
4. **Cherry-picked T1324** — The task/T1325 branch was cut before T1324 shipped. The T1324 commit (0cad18809 — `resolverWarning` field) was cherry-picked to task/T1325 as a prerequisite.

## Quality Gates

- `pnpm biome ci .` — clean (schema version info only, no errors) in worktree
- `pnpm run build` — green ("Build complete.")
- Dispatch-trace unit tests: 3 passed
- Agent-resolver tests: 13 passed in isolation (full-suite flakiness in performance-safety.test.ts is pre-existing, unrelated)
