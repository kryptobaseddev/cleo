# T5602 Registry Fix Output

**Status**: PASS — All fixes applied and verified
**Task**: T5602
**Date**: 2026-03-07

---

## Summary

Two source files edited to wire `release.cancel` into the dispatch registry and MCP gateway validator. Four additional test/doc files updated to reflect the new operation count (262 total: 148 query + 114 mutate).

---

## Fix 1 — src/dispatch/registry.ts

Added `release.cancel` entry before `release.rollback` (around line 1891):

```typescript
{
  gateway: 'mutate',
  domain: 'pipeline',
  operation: 'release.cancel',
  description: 'pipeline.release.cancel (mutate)',
  tier: 0,
  idempotent: false,
  sessionRequired: false,
  requiredParams: ['version'],
},
```

## Fix 2 — src/mcp/gateways/mutate.ts

Added `case 'cancel':` to the `validateReleaseParams()` switch statement (line ~798), grouped with other version-required operations:

```typescript
case 'prepare':
case 'changelog':
case 'commit':
case 'tag':
case 'push':
case 'rollback':
case 'cancel':   // added
  if (!params?.version) { ... }
```

## Count Updates (ripple from +1 mutate op)

| File | Change |
|------|--------|
| `src/dispatch/__tests__/parity.test.ts` | `mutateCount: 113 → 114`, `total: 261 → 262` |
| `tests/integration/parity-gate.test.ts` | `EXPECTED_MUTATE: 113 → 114`, `EXPECTED_TOTAL: 261 → 262` |
| `docs/specs/CLEO-OPERATION-CONSTITUTION.md` | pipeline row: `16 \| 24 \| 40` → `17 \| 25 \| 42`; Total: `147 \| 113 \| 260` → `148 \| 114 \| 262` |
| `AGENTS.md` | Already pre-updated to 262/148/114 — no change needed |
| `docs/concepts/CLEO-VISION.md` | Already pre-updated to 262 — no change needed |

---

## tsc Result

```
(no output — zero errors)
```

## Test Result

All previously failing tests now pass:

```
✓ tests/integration/parity-gate.test.ts           (7 tests)
✓ tests/integration/operation-count-doc-sync.test.ts (1 test)
✓ src/dispatch/__tests__/parity.test.ts            (53 tests)
✓ src/mcp/gateways/__tests__/mutate.test.ts        (41 tests)
✓ src/core/release/__tests__/cancel-release.test.ts (8 tests)

Test Files: 5 passed (5)
Tests:     110 passed (110)
```

Full test suite (post-fix):
```
Test Files: 277 passed (277)
Tests:      4335 passed (4335)
```

## End-to-End Test Result

```
# Create release
{"success":true,"result":{"version":"v2026.3.55","status":"prepared",...}}

# Cancel release
{"success":true,"result":{"success":true,"message":"Release v2026.3.55 cancelled and removed","version":"v2026.3.55"}}

# Verify DB row gone
(empty — confirmed deleted)
```

---

## Root Cause Confirmed

`release.cancel` was fully implemented in core, engine, and domain layers but was never registered in `src/dispatch/registry.ts`. The dispatcher's `resolve()` call checked this registry first and returned "Unknown operation" before any domain handler was called. Adding the registry entry unblocked all routing.
