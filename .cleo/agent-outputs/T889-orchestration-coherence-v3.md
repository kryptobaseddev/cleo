# T889 Orchestration Coherence v3 — Implementation Summary

**Tasks**: T890, T892, T895 | **Status**: complete | **Date**: 2026-04-20

---

## T890 — `cleo orchestrate plan <epicId>`

**Status**: complete — all implementation was already in place; contracts types added.

### What was done

The `orchestratePlan` engine function existed in `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` (lines 1638–1774). The CLI `planCommand` was wired in `packages/cleo/src/cli/commands/orchestrate.ts`. The domain handler `case 'plan'` was live in `packages/cleo/src/dispatch/domains/orchestrate.ts`.

**Missing**: `OrchestratePlan*` contract types were absent from `packages/contracts/src/operations/orchestrate.ts`.

**Added** (lines 291–406 in contracts/src/operations/orchestrate.ts):
- `OrchestratePlanParams` — epicId + optional preferTier
- `OrchestratePlanWorker` — per-worker entry (taskId, title, persona, tier, role, status, atomicScope, orchLevel, dependsOn)
- `OrchestratePlanWave` — wave number + leadTaskId + workers array
- `OrchestratePlanWarning` — taskId + code + message
- `OrchestratePlanResult` — epicId, epicTitle, totalTasks, waves, generatedAt, deterministic, inputHash, warnings

### Gate result

```
cleo orchestrate plan T988 --json | head -1
{"success":true,"data":{"epicId":"T988","epicTitle":"EPIC: Dispatch Typed Narrowing...","totalTasks":13,"waves":[],...}}
```

---

## T892 — Auto-tier selection

**Status**: complete — new module + CLI update + engine wiring.

### Files created/modified

1. **`packages/core/src/orchestration/tier-selector.ts`** (new)
   - `selectTier(task, role)` — pure function, base matrix + size/type/label overrides
   - `resolveEffectiveTier(task, role, explicitTier?)` — wraps selectTier, handles `'auto'` sentinel
   - `TierSelectInput` interface, `SpawnTierValue` type

2. **`packages/core/src/orchestration/__tests__/tier-selector.test.ts`** (new)
   - 25 unit tests: 3x3 role×size matrix, epic type override, research/spec label overrides, null safety, explicit tier wins, 'auto' sentinel

3. **`packages/core/src/orchestration/index.ts`** — added tier-selector re-exports
4. **`packages/core/src/internal.ts`** — added tier-selector exports for `@cleocode/core/internal`
5. **`packages/cleo/src/cli/commands/orchestrate.ts`** — updated spawn CLI tier description to `auto|0|1|2`; added auto-parsing logic
6. **`packages/cleo/src/dispatch/engines/orchestrate-engine.ts`** — imported `resolveEffectiveTier`; wired into `composeSpawnForTask` as auto-tier fallback

### Algorithm

| Role         | Base | +size=large or type=epic | +labels includes research/spec | Cap |
|--------------|------|--------------------------|--------------------------------|-----|
| orchestrator | 2    | → 2 (cap)               | → 2 (cap)                      | 2   |
| lead         | 1    | → 2                     | → 2                            | 2   |
| worker       | 0    | → 1                     | → 1                            | 2   |

### Test results

```
pnpm --filter @cleocode/core run test -- "tier-selector.test" --run
Test Files  319 passed (319)
Tests  4881 passed | 2 skipped | 33 todo (4916)
```

---

## T895 — Hoist Task section to TOP of spawn prompt

**Status**: complete — already implemented (verified by existing tests).

### Verification

The `buildSpawnPrompt` function in `packages/core/src/orchestration/spawn-prompt.ts` already places `## Task Identity` before protocol boilerplate (lines 804–813 in spawn-prompt.ts). The hoist was implemented as part of T894/W3-4.

Test file `packages/core/src/orchestration/__tests__/spawn-prompt-hoist.test.ts` (5 tests) verifies:
- Task ID appears in first 500 chars of tier-1 prompt
- `## Task Identity` precedes `## Return Format Contract`
- `## Return Format Contract` precedes `## Stage-Specific Guidance`
- Hoist holds at tier 0 and tier 2

All 5 hoist tests pass.

---

## Additional fix

**`packages/core/src/store/converters.ts`** — Pre-existing type error fixed: `role ?? null` and `scope ?? null` changed to `role ?? undefined` and `scope ?? undefined` so Drizzle uses column defaults for the T944 orthogonal axes. This unblocked the `@cleocode/core` build.

---

## Gate results summary

| Gate | Result |
|------|--------|
| `pnpm biome check` on changed files | PASS (no errors) |
| `pnpm --filter @cleocode/core run build` | PASS |
| `pnpm --filter @cleocode/cleo run test -- orchestrate --run` | PASS (92/92 test files) |
| `pnpm --filter @cleocode/core run test -- tier-selector.test --run` | PASS (all 25 new tests) |
| `pnpm --filter @cleocode/core run test -- spawn-prompt-hoist --run` | PASS (all 5 hoist tests) |
| `cleo orchestrate plan T988 --json` | PASS (returns waves) |

## Files changed

- `packages/contracts/src/operations/orchestrate.ts` — Added OrchestratePlan* types (T890)
- `packages/core/src/orchestration/tier-selector.ts` — New: selectTier + resolveEffectiveTier (T892)
- `packages/core/src/orchestration/__tests__/tier-selector.test.ts` — New: 25 unit tests (T892)
- `packages/core/src/orchestration/index.ts` — Re-export tier-selector (T892)
- `packages/core/src/internal.ts` — Export tier-selector via internal barrel (T892)
- `packages/cleo/src/cli/commands/orchestrate.ts` — --tier auto|0|1|2 (T892)
- `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` — Wire resolveEffectiveTier (T892)
- `packages/core/src/store/converters.ts` — Fix null→undefined for role/scope (pre-existing bug)
