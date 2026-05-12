# T1933: Resolver Fallback Path + Universal-Tier Pre-Flight

**Task**: T1933
**Epic**: T1929 (Agent System Canonicalization v2)
**Status**: complete
**Commit**: 3297dd5e2 (included in T1935 commit — files were staged together)

## Summary

Two surgical fixes implementing ADR-068 Decisions 1+2+6:

### Fix 1 — Fallback Tier Path (Bug 5)

**File**: `packages/core/src/store/agent-resolver.ts`

- `tryResolveFallback()`: changed `seedDir` variable to `templatesDir`, now uses `resolveDefaultTemplatesDir()` as default
- `resolveDefaultTemplatesDir()`: new exported function, climbs from `packages/core/src/store/` to `packages/agents/templates/`
- `resolveDefaultSeedDir()`: preserved as deprecated exported shim — delegates to `resolveDefaultTemplatesDir()` for one major-version cycle
- `packagedSeedDir` option in `ResolveAgentOptions`: field name preserved for backward compatibility with test call sites

Result: classifier output `project-docs-worker` → `templates/project-docs-worker.cant` (not `seed-agents/project-docs-worker.cant` which no longer exists).

### Fix 2 — Universal Tier in Spawn Validator Pre-Flight (Bug 6)

**File**: `packages/core/src/orchestration/validate-spawn.ts`

- Added `openSignaldockDbForPreflight()`: best-effort DB open, returns `null` if DB unavailable (graceful degradation)
- Added `deriveAgentIdForPreflight()`: mirrors `composeSpawnPayload` classify logic
- Added agent-existence check block in `validateSpawnReadiness`: calls `resolveAgent()` with full 5-tier cascade; only emits `V_AGENT_NOT_FOUND` when `AgentNotFoundError` is thrown (catastrophic state)
- Added `packagedSeedDir` and `universalBasePath` to `SpawnValidationContext` for test isolation

Result: V_AGENT_NOT_FOUND only fires when `cleo-subagent.cant` itself is unreachable. Normal operation always resolves at some tier.

## Tests Added

### `packages/core/src/store/__tests__/agent-resolver.test.ts` (7 new tests)

1. T1933 Fix 1 — fallback tier finds `project-docs-worker.cant` in `templates/`
2. T1933 Fix 1 — project tier wins over fallback templates/ file when both present
3. T1933 Fix 2 — universal tier synthesises envelope when all 4 prior tiers miss
4. T1933 Fix 2 — E_AGENT_NOT_FOUND only when universal base itself is unreachable (triedTiers enumerated)
5. T1933 — `resolveDefaultTemplatesDir` returns path ending in `agents/templates`
6. T1933 — `resolveDefaultSeedDir` (deprecated shim) delegates to `resolveDefaultTemplatesDir`
7. T1933 — all 5 tiers covered individually

### `packages/core/src/orchestration/__tests__/validate-spawn.test.ts` (3 new tests)

1. Skips agent-existence check gracefully when signaldock.db unavailable
2. Emits V_AGENT_NOT_FOUND when all 5 tiers miss (catastrophic state)
3. Passes pre-flight when fallback tier resolves the agent

## Quality Gates

- **implemented**: commit 3297dd5e2 + 4 files verified
- **testsPassed**: 37/37 tests pass (test-run JSON anchored)
- **qaPassed**: biome check on 4 modified files: 0 errors; @cleocode/core tsc: exits 0 (global biome fails on pre-existing lint-no-raw-cr-writes.mjs issue)
- **documented**: TSDoc on all exported functions
- **securityPassed**: read-only fs lookup, no new attack surface
- **cleanupDone**: fallback path corrected, deprecated shim preserved

## Files Modified

- `/mnt/projects/cleocode/packages/core/src/store/agent-resolver.ts`
- `/mnt/projects/cleocode/packages/core/src/orchestration/validate-spawn.ts`
- `/mnt/projects/cleocode/packages/core/src/store/__tests__/agent-resolver.test.ts`
- `/mnt/projects/cleocode/packages/core/src/orchestration/__tests__/validate-spawn.test.ts`
