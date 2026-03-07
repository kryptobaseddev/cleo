# T5599 Wave 2A — Fix Report

**Agent**: Wave 2A Fix Agent
**Date**: 2026-03-07
**Task**: T5599
**Status**: COMPLETE — all 3 issues fixed, tsc clean, 4335/4335 tests pass, dist rebuilt

---

## Fix 1: Register `release.channel.show` in MCP query gateway

**Root cause**: The operation existed in `src/dispatch/domains/pipeline.ts` `getSupportedOperations()` and had a `queryRelease` case handler (line 377), but was absent from `src/dispatch/registry.ts` (the OPERATIONS array). The query gateway derives its operation matrix from `registry.ts` via `deriveGatewayMatrix()`, so MCP calls to `query pipeline release.channel.show` failed with `E_INVALID_OPERATION`.

**Fix location**: `/mnt/projects/claude-todo/src/dispatch/registry.ts` — inserted after the `release.show` entry (line ~1820):

```typescript
{
  gateway: 'query',
  domain: 'pipeline',
  operation: 'release.channel.show',
  description: 'Show the current release channel based on git branch (latest/beta/alpha)',
  tier: 0,
  idempotent: true,
  sessionRequired: false,
  requiredParams: [],
},
```

**Cascading test updates** (all test counts incremented to reflect the new op + pre-existing `release.cancel` from T5602 that was also unregistered in tests):

| File | Change |
|------|--------|
| `src/dispatch/__tests__/parity.test.ts` | query 147→148, total 260→262, mutate 113→114 |
| `tests/integration/parity-gate.test.ts` | EXPECTED_TOTAL 260→262, EXPECTED_QUERY 147→148, EXPECTED_MUTATE 113→114, pipeline {16,24,40}→{17,25,42} |
| `src/mcp/gateways/__tests__/query.test.ts` | pipeline query 16→17 |
| `src/mcp/gateways/__tests__/mutate.test.ts` | pipeline mutate 24→25 (two locations) |

**Doc updates** (required by `operation-count-doc-sync.test.ts`):

| File | Change |
|------|--------|
| `AGENTS.md` | 260→262 ops, 147→148 query, 113→114 mutate (3 locations) |
| `docs/concepts/CLEO-VISION.md` | 260→262 total, 147→148 query, 113→114 mutate (2 locations) |
| `docs/specs/CLEO-OPERATION-CONSTITUTION.md` | pipeline row 16/24/40→17/25/42, Total row 147/113/260→148/114/262 |

**Note on mutate count**: The pre-existing `release.cancel` operation (T5602) was already added to `registry.ts` but its test counts had not been updated. Wave 2A resolved this as part of the cascade.

---

## Fix 2: Dry-run must NOT write CHANGELOG.md to disk

**Root cause**: In `src/dispatch/engines/release-engine.ts`, `releaseShip()` called `generateReleaseChangelog()` at Step 4 before the `if (dryRun)` branch. `generateReleaseChangelog()` unconditionally writes to `CHANGELOG.md` (and updates the DB record). Running `release ship --dry-run` caused duplicate changelog sections when the version had already been changelоgged.

**Fix**: Moved `generateReleaseChangelog()` call to after the `if (dryRun)` early-return block. In dry-run mode, the function is never called — instead a preview string is added to `wouldDo[]`:

```
"write CHANGELOG.md: ## [${version}] - ${date} (preview only, not written in dry-run)"
```

In non-dry-run mode, Step 4 runs `generateReleaseChangelog()` as before (with `await` but discarding the return value since the function writes to disk and DB internally).

**Exact lines changed**: `src/dispatch/engines/release-engine.ts` lines ~486-543 (refactored Step 4 from before `if (dryRun)` to after).

---

## Fix 3: `--epic` flag optionality

**Finding**: The `--epic` flag is correctly implemented as required everywhere. The CLI uses `.requiredOption('--epic <id>', ...)` (line 59 of `src/cli/commands/release.ts`). The domain handler validates `!epicId` and returns `E_INVALID_INPUT`. The test env report's Issue 4 was a misread — Commander shows `[options]` as a generic section header, not implying `--epic` is optional. The `--epic <id>` syntax (angle brackets) correctly signals a required value.

**Decision**: No code changes needed. The current behavior is correct and the help text accurately describes the requirement.

---

## Results

### TypeScript compiler
```
npx tsc --noEmit → 0 errors (clean)
```

### Test suite
```
Test Files: 277 passed (277)
Tests:      4335 passed (4335)
```

### Build
```
npm run build → Build complete (version: 2026.3.17)
```

---

## Files Modified

| File | Change |
|------|--------|
| `src/dispatch/registry.ts` | Added `release.channel.show` query entry |
| `src/dispatch/engines/release-engine.ts` | Moved Step 4 changelog write after dry-run guard |
| `src/dispatch/__tests__/parity.test.ts` | Updated counts: 148q, 114m, 262 total |
| `tests/integration/parity-gate.test.ts` | Updated counts + pipeline domain row |
| `src/mcp/gateways/__tests__/query.test.ts` | pipeline query 16→17 |
| `src/mcp/gateways/__tests__/mutate.test.ts` | pipeline mutate 24→25 (×2) |
| `AGENTS.md` | Updated operation counts (3 locations) |
| `docs/concepts/CLEO-VISION.md` | Updated operation counts (2 locations) |
| `docs/specs/CLEO-OPERATION-CONSTITUTION.md` | Updated pipeline row + Total row |
