# T5602 Test Output: release.cancel

**Status**: FAIL — Critical Bug Found
**Task**: T5602
**Agent**: Wave 2B (Claude Sonnet 4.6)
**Date**: 2026-03-07

---

## Summary

ALL CLI integration tests fail with exit code 2. Root cause: `release.cancel` is missing from the
central dispatch registry (`src/dispatch/registry.ts`). The dispatcher resolves operations against
this registry before routing to any domain handler, so the pipeline domain handler never gets called.

Unit tests for `cancelRelease()` (the core function) pass cleanly (8/8).

---

## Test Results

| Test Case | Expected | Actual | PASS/FAIL |
|-----------|----------|--------|-----------|
| Cancel prepared release | Success + row deleted | `{"success":false,"error":{"code":2,"message":"Unknown operation: mutate:pipeline.release.cancel"}}` | FAIL |
| Cancel with v-prefix | Success + row deleted | Same "Unknown operation" error | FAIL |
| Cancel non-existent release | Error: not found | Same "Unknown operation" error | FAIL |
| Cancel committed release | Error: use rollback | Same "Unknown operation" error | FAIL |
| CLI help shows cancel subcommand | Shows `cancel <version>` | PASS — `cancel <version>  Cancel and remove a release in draft or prepared state` visible in `cleo release --help` | PASS |
| Unit tests (cancelRelease core) | 8/8 pass | 8/8 pass (verified via `vitest run`) | PASS |

---

## Root Cause: Missing Registry Entry

The dispatcher (`src/dispatch/dispatcher.ts` line 38) calls `resolve(gateway, domain, operation)` against
the central registry before doing anything else. If the operation is not found in the registry, it
immediately returns an error without calling the domain handler.

`release.cancel` was implemented in the pipeline domain handler (`src/dispatch/domains/pipeline.ts`)
and is listed in the domain's `supportedOps` array (line 197), but **it was never added to the
central dispatch registry** (`src/dispatch/registry.ts`).

### Missing Entry (needs to be inserted around line 1900 of registry.ts)

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

### Secondary Issue: MCP Gateway validateReleaseParams

`src/mcp/gateways/mutate.ts` — the `validateReleaseParams()` function at line 792 has a switch
statement that validates `version` param presence for `prepare`, `changelog`, `commit`, `tag`,
`push`, `rollback` — but is missing the `cancel` case. This means MCP calls to `release.cancel`
would skip the version param check (only matters after the registry is fixed).

```typescript
// Line 793 in mutate.ts — 'cancel' needs to be added to this case group:
case 'prepare':
case 'changelog':
case 'commit':
case 'tag':
case 'push':
case 'rollback':
case 'cancel':   // <-- missing
```

---

## What Was Correctly Implemented

- `cancelRelease()` in `src/core/release/release-manifest.ts` — correct logic, correct return types
- `releaseCancel()` engine wrapper in `src/dispatch/engines/release-engine.ts` — correct
- `case 'cancel':` in pipeline domain `mutateRelease()` — correct, routes to engine
- `release cancel <version>` CLI subcommand in `src/cli/commands/release.ts` — correct dispatch call
- `src/dispatch/lib/engine.ts` re-export of `releaseCancel` — correct
- 8 unit tests in `src/core/release/__tests__/cancel-release.test.ts` — all passing
- CLI help text shows the subcommand — correct

---

## Files Needing Fixes

| File | Issue |
|------|-------|
| `src/dispatch/registry.ts` | Missing `release.cancel` entry (BLOCKING — all integration fails) |
| `src/mcp/gateways/mutate.ts` | Missing `'cancel'` in `validateReleaseParams()` switch (secondary) |

---

## Overall: T5602 FAIL

The core business logic is implemented correctly and tested. However, the operation is not wired
into the dispatch registry, making it completely non-functional at the CLI and MCP integration layer.
Two source file edits are required before this can ship.
