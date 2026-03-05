# T5368 Complete: nexus.reconcile + Handshake Contract

## Files Modified
- `src/core/nexus/registry.ts` — added `nexusReconcile()` function (4-scenario handshake)
- `src/dispatch/domains/nexus.ts` — added `reconcile` mutate case + import + getSupportedOperations entry
- `src/dispatch/registry.ts` — added `nexus.reconcile` operation entry (mutate, tier 1, idempotent)
- `src/core/init.ts` — replaced `initNexusRegistration` body: now delegates to `nexusReconcile()`, removed unused `projectName` parameter
- `src/core/upgrade.ts` — updated `initNexusRegistration` call (removed `projectName` arg), removed unused `basename` import

## Files Created
- `src/core/nexus/__tests__/reconcile.test.ts` — 5 tests covering all 4 scenarios + input validation

## Reconcile logic implemented

The key architectural decision: **projectId is the stable identifier, not projectHash**.

Since `generateProjectHash()` is SHA-256 of the absolute path, moving a project changes its hash. Therefore:

| Scenario | Match Strategy | Action | Return |
|----------|---------------|--------|--------|
| 1. Known project, same path | projectId match, path match | Update lastSeen | `{status:'ok'}` |
| 2. Known project, moved | projectId match, path differs | Update path + hash + lastSeen | `{status:'path_updated', oldPath, newPath}` |
| 3. Unknown project | No projectId or hash match | Auto-register via `nexusRegister()` | `{status:'auto_registered'}` |
| 4. Hash conflict | Hash matches but projectId differs | Throw CleoError | Error thrown |

For projects without a projectId (legacy), falls back to hash-based matching (scenario 1/3 only).

## Exit code used for scenario 4
- `ExitCode.NEXUS_REGISTRY_CORRUPT` (75) — chosen because a hash collision with a different projectId indicates corrupted or conflicting registry state, not a simple "not found" or "permission" issue. The error message includes both projectIds for diagnosis.

## Validation Results
- npx tsc --noEmit: 0 errors
- vitest reconcile.test.ts: 5 passing (263ms)
- TODO scan: 0 found
- npm run build: success

## Status: COMPLETE
