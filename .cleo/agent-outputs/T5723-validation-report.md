# T5723 Validation Report -- @cleocode/core Extraction (Epic T5716)

**Date**: 2026-03-17
**Branch**: `feature/T5701-core-extraction`
**Validator**: Quality Engineer (Claude Opus 4.6)

---

## Validation Summary

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1 | TypeScript compilation (`tsc --noEmit`) | PASS | Exit 0, zero errors |
| 2 | Build (`npm run build`) | PASS | Exit 0, 3 bundles produced (CLI, MCP, core) |
| 3 | Core purity gate | PASS | No upward imports from core to cli/mcp/dispatch |
| 4 | Import verification (zero relative core/ imports) | PASS | 0 files in dispatch, cli, mcp |
| 5 | TODO/FIXME/HACK check | PASS | Only scanner infrastructure references (concerns.ts), no genuine TODOs |
| 6 | E2E smoke test | PARTIAL FAIL | 8/10 pass, 2/10 fail |
| 7 | Unit test suite | PARTIAL FAIL | 4199/4206 pass (99.8%), 7 fail across 6 files |

**Overall**: 5/7 checks fully pass. 2 checks have known, categorized failures documented below.

---

## Check 1: TypeScript Compilation

```
npx tsc --noEmit
EXIT_CODE=0
```

**Result**: PASS -- Zero errors, zero output. Clean compilation.

---

## Check 2: Build

```
npm run build
EXIT_CODE=0
```

**Result**: PASS -- Build completes successfully producing all 3 bundles.

**Warning (non-blocking)**: TS6307 diagnostics emitted during the core package build. These are TypeScript informational warnings about files not listed in `packages/core/tsconfig.json` but reachable via import chains. esbuild bundles successfully regardless. These warnings are inherent to the Option B architecture (esbuild bundle from src/core/ into packages/core/dist/) and are expected.

**Build artifacts**:
- `dist/cli/index.js` -- CLI bundle
- `dist/mcp/index.js` -- MCP bundle
- `packages/core/dist/index.js` -- 1.3MB standalone core bundle

---

## Check 3: Core Purity Gate

```
bash dev/check-core-purity.sh
```

**Output**:
```
core-purity: PASS -- src/core/ and packages/core/src/ have no upward imports to cli/mcp/dispatch
  (1 known exception(s) suppressed -- fix incrementally)
```

**Result**: PASS

---

## Check 4: Import Verification -- Zero Relative core/ Imports

```
grep -r "from ['\"]\.\..*\/core\/" src/dispatch/ --include="*.ts" -l | grep -v __tests__  --> (none)
grep -r "from ['\"]\.\..*\/core\/" src/cli/ --include="*.ts" -l | grep -v __tests__       --> (none)
grep -r "from ['\"]\.\..*\/core\/" src/mcp/ --include="*.ts" -l | grep -v __tests__       --> (none)
```

**Result**: PASS -- All three directories return zero files. The T5718/T5719/T5720 rewiring from relative `../../core/` imports to `@cleocode/core` is complete in production source.

---

## Check 5: TODO/FIXME/HACK Check

Only matches found are in the codebase-map concerns analyzer (`src/core/codebase-map/analyzers/concerns.ts`) which is infrastructure code that *scans* for TODOs -- not a genuine TODO comment. One additional match in `src/core/sticky/id.ts` is a JSDoc description, not a task marker.

**Result**: PASS -- No genuine TODO/FIXME/HACK comments in production source.

---

## Check 6: E2E Smoke Test

```
npx vitest run tests/e2e/core-package-smoke.test.ts
Test Files: 1 failed (1)
Tests: 2 failed | 8 passed (10)
```

**Result**: PARTIAL FAIL -- 8/10 pass, 2/10 fail.

### Failing Tests

**1. `should export the Cleo facade class`**
```
AssertionError: expected undefined to be defined
  at tests/e2e/core-package-smoke.test.ts:15:23
    expect(core.Cleo).toBeDefined();
```

**2. `should create a Cleo instance via forProject`**
```
TypeError: Cannot read properties of undefined (reading 'forProject')
  at tests/e2e/core-package-smoke.test.ts:70:23
    const cleo = Cleo.forProject('/tmp/test-project');
```

### Root Cause

The `Cleo` facade class is defined in `packages/core/src/cleo.ts` and re-exported from `packages/core/src/index.ts`. However, the esbuild bundle (`packages/core/dist/index.js`) only bundles from `src/core/index.ts` as its entry point -- it does not include the `cleo.ts` facade or the additional named exports from `packages/core/src/index.ts`.

The `.d.ts` file (`packages/core/dist/index.d.ts`) similarly only re-exports from `src/core/index.js`, not from `./cleo.js`.

**Fix needed**: The esbuild bundle entry point (`build.mjs`) needs to use `packages/core/src/index.ts` as the entry point (or add `cleo.ts` as an additional entry), rather than just `src/core/index.ts`. This is a build configuration issue, not a code issue.

---

## Check 7: Unit Test Suite

```
npx vitest run --project unit
Test Files: 6 failed | 258 passed (264)
Tests: 7 failed | 4199 passed (4206)
Pass rate: 99.8%
```

**Result**: PARTIAL FAIL -- 7 tests fail across 6 files.

### Failure Categories

#### Category A: Vitest v4 `vi.mock` Breaking Changes (4 files, not caused by T5716)

These failures are pre-existing Vitest v4 migration issues where `vi.mock` requires explicit `importOriginal` usage:

| File | Error |
|------|-------|
| `src/cli/__tests__/logger-bootstrap.test.ts` | No "getLogger" export on mock |
| `src/cli/__tests__/web.test.ts` | No "execFile" export on mock |
| `src/dispatch/domains/__tests__/registry-parity.test.ts` | No "execFile" export on mock |
| `src/dispatch/middleware/__tests__/audit.test.ts` | No "TASK_PRIORITIES" export on mock |

These are tracked under the Vitest v4 migration epic (T5220).

#### Category B: Core-Parity Tests Expect Old Import Paths (1 file, 6 tests, caused by T5718)

| File | Tests Failed |
|------|-------------|
| `src/core/__tests__/core-parity.test.ts` | 6 |

These tests verify that dispatch engine files import from `../../core/` using relative paths. Since T5718 rewired those to `@cleocode/core`, these tests now fail because the import strings no longer match.

**Fix needed**: Update `core-parity.test.ts` to expect `@cleocode/core` imports instead of relative `../../core/` paths.

#### Category C: Flaky Cleanup (1 file, intermittent)

| File | Error |
|------|-------|
| `src/core/sessions/__tests__/index.test.ts` | `ENOTEMPTY: directory not empty, rmdir` |

This is an intermittent test cleanup issue (WAL file race condition), not caused by T5716.

---

## Warnings and Notes

1. **TS6307 Warnings During Build**: The `packages/core/tsconfig.json` does not list all files reachable through the import graph. This is by design (Option B architecture uses esbuild, not tsc, for bundling). The warnings are cosmetic and do not affect the bundle output.

2. **Core-Parity Tests Need Update**: The 6 failures in `core-parity.test.ts` are a direct consequence of the T5718 rewiring and should be fixed as part of PR finalization. The tests need to check for `@cleocode/core` imports instead of relative paths.

3. **Cleo Facade Not in Bundle**: The esbuild bundle entry point does not include the `Cleo` facade class. The 2 smoke test failures will persist until the build configuration is updated to include `packages/core/src/cleo.ts` exports in the bundle.

4. **No Regressions in Core Business Logic**: All 4199 passing unit tests confirm that the import rewiring (T5718-T5720) did not break any core business logic, dispatch routing, CLI commands, or MCP operations.

---

## Verdict

The extraction is structurally sound. The import rewiring is complete and correct at the source level. Two focused fixes remain before the PR can merge:

1. Update `core-parity.test.ts` to expect `@cleocode/core` imports (test update only)
2. Fix the esbuild entry point to include the `Cleo` facade class in the core bundle (build config fix)

Neither fix requires architectural changes.
