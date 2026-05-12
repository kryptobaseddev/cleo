# ALPHA-4 — Dispatch Layer Contracts→Core Rewrite

**Task**: T1565 (T-LAYERING-FIX)
**Agent**: Alpha-4 of Team Alpha
**Scope**: `packages/cleo/src/dispatch/**/*.ts` (excluding `__tests__/`)
**Date**: 2026-04-29

## Summary

Pure mechanical rewrite of `from '@cleocode/contracts'` → `from '@cleocode/core'` in dispatch layer source files. No `__tests__` touched (left for Alpha-3/Alpha-5). No subpath imports (`@cleocode/contracts/operations/orchestrate`) touched — out of literal-string scope.

## Counts

| Metric | Value |
|---|---|
| Source files touched | **13** |
| Test files touched (excluded by spec) | 0 |
| Import statements rewritten (source) | **17** |
| Pre-edit grep `'@cleocode/contracts'` in dispatch (incl. tests) | 25 |
| Post-edit grep `'@cleocode/contracts'` in dispatch (incl. tests) | 8 (all in `__tests__/` — out of scope) |
| Post-edit grep in source (excluding `__tests__/`) | **0** ✓ |

## Files Touched

1. `packages/cleo/src/dispatch/types.ts` (1 export-type block)
2. `packages/cleo/src/dispatch/adapters/typed.ts` (1 import + 1 TSDoc `@example`)
3. `packages/cleo/src/dispatch/domains/check.ts` (1 import-type block)
4. `packages/cleo/src/dispatch/domains/session.ts` (1 import-type block)
5. `packages/cleo/src/dispatch/domains/pipeline.ts` (1 import type)
6. `packages/cleo/src/dispatch/domains/playbook.ts` (1 import type)
7. `packages/cleo/src/dispatch/engines/nexus-engine.ts` (3 import blocks)
8. `packages/cleo/src/dispatch/engines/validate-engine.ts` (1 import-type block)
9. `packages/cleo/src/dispatch/engines/session-engine.ts` (1 import type)
10. `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` (1 of 2 — only the bare contracts; the `/operations/orchestrate` subpath was preserved per literal-string rule)
11. `packages/cleo/src/dispatch/engines/task-engine.ts` (1 import type + 1 export type)
12. `packages/cleo/src/dispatch/lib/engine.ts` (1 export type)
13. `packages/cleo/src/dispatch/lib/gateway-meta.ts` (1 import type)

## Verification

### grep (post-edit)

```
$ grep -rE "from '@cleocode/contracts'" packages/cleo/src/dispatch/ --include="*.ts" | wc -l
8     # all 8 are in __tests__/ — explicit out-of-scope
```

Source files (excluding `__tests__/`): **0 hits** ✓

### tsc

```
$ pnpm tsc --noEmit -p packages/cleo/tsconfig.json
(empty output — clean, exit 0)
```

No NEW errors introduced. ✓

### biome

```
$ pnpm biome check packages/cleo/src/dispatch/
Found 2 errors. (assist/source/organizeImports)
```

**Both errors are biome `organizeImports` warnings (FIXABLE/safe-fix)** — they request reordering of the now-collocated `@cleocode/core` blocks:

- `domains/playbook.ts:46` — wants `playbook as corePlaybook` merged into the new `PlaybookApproval, PlaybookRun, PlaybookRunStatus` import (both now `@cleocode/core`).
- `engines/orchestrate-engine.ts:22` — wants the new `@cleocode/core` block sorted after the surviving `@cleocode/contracts/operations/orchestrate` subpath import.

Per Alpha-4 spec ("Don't reformat. Don't merge imports."), these are **deliberately left for synth**. They are pure ordering/merging concerns — no semantic or type errors. Synth or Alpha-final will re-run `biome check --write` after Alpha-3 + Alpha-5 land their imports too.

## Notes

- TSDoc `@example` block in `adapters/typed.ts:157` was rewritten alongside the runtime imports for documentation consistency (Alpha-2 confirmed all 29 names re-export from core). Excluding it would leave stale docs.
- All `import type` qualifiers preserved exactly. No syntax merging or reformatting performed.
- Subpath imports `@cleocode/contracts/operations/orchestrate` (lines 34 & 73 of `orchestrate-engine.ts`) preserved — they don't match the literal-string rule and `@cleocode/core` may not expose this subpath.
