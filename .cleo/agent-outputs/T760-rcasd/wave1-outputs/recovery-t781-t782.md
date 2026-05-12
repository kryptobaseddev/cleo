# Recovery T781 + T782

**Worker**: Recovery Worker
**Date**: 2026-04-16
**Status**: complete

## What Was Missing

### T781: gate-runner.ts
The file `packages/core/src/tasks/gate-runner.ts` already existed (fully implemented).
The registry entry for `check.gate.run` (mutate) was MISSING from `packages/cleo/src/dispatch/registry.ts`.
Without this entry, the dispatcher returned `E_INVALID_OPERATION` before reaching the check domain handler.

**Fix**: Added `gate.run` (mutate) to OPERATIONS in registry.ts. The handler in check.ts already called `runGates`.

### T782: req dispatch wiring
Three dispatch operations were missing from `packages/cleo/src/dispatch/registry.ts`:
- `query:tasks.req.list` — missing registry entry
- `mutate:tasks.req.add` — missing registry entry
- `query:tasks.req.migrate` (dry-run) — missing registry entry + missing query-branch in tasks domain handler
- `mutate:tasks.req.migrate` (apply) — missing registry entry

The CLI (req.ts), business logic (core/tasks/req.ts), task-engine.ts wiring, and tasks domain handler switch cases were all already correct.

**Fix**:
1. Added 5 new OPERATIONS entries to registry.ts (+2 query, +3 mutate)
2. Added `req.migrate` case to the query branch of tasks domain handler
3. Added `req.migrate` to the tasks handler's getSupportedOperations() query list

## esbuild Bundle Rebuild Required

`pnpm run build` runs `tsc` only. The installed `cleo` binary uses an esbuild bundle
(`packages/cleo/dist/cli/index.js`). Running `node build.mjs` is required to update
the bundle used by the `cleo` CLI binary. Both were rebuilt.

## Files Modified

- `packages/cleo/src/dispatch/registry.ts` — +5 OPERATIONS entries
- `packages/cleo/src/dispatch/domains/tasks.ts` — req.migrate query branch + getSupportedOperations
- `packages/cleo/src/dispatch/__tests__/parity.test.ts` — updated counts (152→154 query, 103→106 mutate, 255→260 total)
- `packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts` — added mocks + MINIMAL_PARAMS for new ops

## Build & Smoke Test Results

```
pnpm --filter @cleocode/core run build   -> 0 errors
pnpm --filter @cleocode/cleo run build   -> 0 errors
node build.mjs                           -> bundle rebuilt

# Smoke tests (via local dist bundle):
node dist/cli/index.js req list T781     -> {"success":true,"data":{"taskId":"T781","gates":[]}}
node dist/cli/index.js req --help        -> lists add/list/migrate subcommands
node dist/cli/index.js verify T781 --run -> {"success":true,"data":{"totalGates":0,...}}
node dist/cli/index.js verify --help     -> shows --run + --skipManual flags
```

## Test Results

- parity.test.ts: 53 passed (was failing on count mismatch)
- registry-parity.test.ts: 260 passed (was failing on missing mocks)
- Pre-existing failures (unrelated): alias-detection.test.ts orchestrate domain ivtr.* mismatch (not caused by T781/T782)
