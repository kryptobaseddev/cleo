# Shared Package Agent Output

**Task**: #9 -- Phase 1A: Initialize packages/shared/ runtime utilities
**Agent**: contracts-agent

## Completed Work

### 1. packages/shared/ created (@cleocode/shared v1.0.0)

| File | Purpose | Extracted From |
|------|---------|----------------|
| `observation-formatter.ts` | `shouldSkipTool()`, `summarizeToolUse()`, `formatObservation()` | `brain-worker.cjs` lines 18-112 |
| `cleo-cli.ts` | `CleoCli` class with `observe()`, `sessionStatus()`, `brainSearch()`, `run()`, `runJson()` | `brain-worker.cjs` `cleoObserve()` + session/memory patterns |
| `hook-dispatch.ts` | `dispatchHookEvent()`, `checkWorkerHealth()` | `brain-hook.sh` fire-and-forget curl logic |
| `index.ts` | Barrel re-export of all runtime utilities | -- |

### 2. Dependencies
- Depends on `@cleocode/contracts` (workspace link, types only)
- No external npm dependencies beyond Node.js built-ins

### 3. Verification
- `npx tsc --noEmit` passes for shared, contracts, and root project
- `npm run build` succeeds
- Unit tests: 247/249 pass (2 pre-existing LAFS failures from errors-agent work)
- Zero TODO comments

## Design Decisions

1. **CleoCli is synchronous** -- uses `execFileSync` because adapters typically call cleo during hook processing where async is unnecessary overhead. The `observe()` method matches the original `cleoObserve()` semantics exactly.
2. **hook-dispatch uses native `http`** -- no dependencies beyond Node.js built-ins. The fire-and-forget pattern matches the original bash `curl` approach.
3. **observation-formatter preserves exact skip lists** -- SKIP_TOOLS and SKIP_PREFIXES match brain-worker.cjs identically.
