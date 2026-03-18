# PR Validation Report — feature/T5701-core-extraction

**Date**: 2026-03-17
**Branch**: `feature/T5701-core-extraction`
**Validator**: Test Suite Validator agent

---

## Results Summary

| Check | Result | Detail |
|-------|--------|--------|
| TSC | PASS (0 errors, after fix) | 30 unused-import errors fixed |
| Build | PASS | Clean, no warnings |
| Tests | 5004 passed, 0 failed, 7 skipped | Matches baseline exactly |
| Core purity | PASS | 1 known exception suppressed |
| TODOs | NONE | No TODO/FIXME/HACK in changed files |
| packages/core | VALID | Correct structure and re-export |

**OVERALL: PASS — ready for PR**

---

## Step 1: TypeScript Compilation

**Initial result**: FAIL — 30 errors, all in `src/core/lifecycle/pipeline.ts`

**Root cause**: Each function in pipeline.ts used a local dynamic import
`const { and, asc, desc, eq, sql } = await import('drizzle-orm')` as a copy-paste
template, but not all functions actually used all five symbols.

**Fix applied**: Trimmed each function's destructure to only the symbols it uses:

| Function | Before | After |
|----------|--------|-------|
| `initializePipeline` (line 243) | `and, asc, desc, eq, sql` | `eq` |
| `getPipeline` (line 345) | `and, asc, desc, eq, sql` | `eq, sql` |
| `advanceStage` (line 411) | `and, asc, desc, eq, sql` | `and, eq` |
| `getCurrentStage` (line 560) | `and, asc, desc, eq, sql` | `eq` |
| `listPipelines` (line 597) | unchanged | `and, asc, desc, eq, sql` (all used) |
| `completePipeline` (line 715) | `and, asc, desc, eq, sql` | `and, eq` |
| `cancelPipeline` (line 778) | `and, asc, desc, eq, sql` | `and, eq` |
| `pipelineExists` (line 847) | `and, asc, desc, eq, sql` | `eq, sql` |
| `getPipelineStatistics` (line 876) | `and, asc, desc, eq, sql` | `sql` |
| `getPipelineStages` (line 949) | `and, asc, desc, eq, sql` | `asc, eq` |

**Final result**: PASS — 0 errors

---

## Step 2: Build

```
npm run build
```

Output: `Build complete.`
No errors or warnings.

---

## Step 3: Full Test Suite

```
Test Files  311 passed | 1 skipped (312)
      Tests  5004 passed | 7 skipped (5011)
   Duration  200.04s
```

Matches known baseline of 5004 passed / 7 skipped / 0 failed exactly.
No regressions.

---

## Step 4: Core Purity Gate

```
core-purity: PASS — src/core/ has no upward imports to cli/mcp/dispatch
  (1 known exception(s) suppressed — fix incrementally)
```

Exit 0. Gate passes.

---

## Step 5: TODO Scan

No TODO, FIXME, or HACK markers found in any files changed relative to `main`.

---

## Step 6: Unused Imports in T5712 Final-Batch Files

All four files were clean after the pipeline.ts fix — none of the four target files
(`src/core/lifecycle/resume.ts`, `src/core/memory/pipeline-manifest-sqlite.ts`,
`src/core/release/release-manifest.ts`, `src/core/lifecycle/index.ts`) produced
any unused import warnings in the final `npx tsc --noEmit` run.

---

## Step 7: packages/core Validation

`/mnt/projects/claude-todo/packages/core/` structure:
- `package.json` — name: `@cleocode/core`, version `1.0.0`, ESM module, correct exports map
- `tsconfig.json` — present
- `src/index.ts` — single line: `export * from '../../../src/core/index.js';`

The package is a correct thin wrapper re-exporting the entire `src/core/` barrel.
peerDependencies declare `@cleocode/caamp`, `@cleocode/contracts`, `@cleocode/lafs-protocol`.

Structure is valid.

---

## Fix Made During Validation

**File**: `src/core/lifecycle/pipeline.ts`
**Issue**: 30 TS6133 unused-import errors across 9 functions (copy-paste `drizzle-orm`
destructures importing symbols not used in that function scope).
**Resolution**: Trimmed each destructure to only the symbols actually used.
**Tests impact**: None — logic unchanged, only import destructuring narrowed.
