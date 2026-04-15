# T618 — Wire Barrel Tracing into NEXUS Active Indexing Pipeline

**Date**: 2026-04-15
**Status**: complete
**Agent**: claude-sonnet-4-6

## Root Cause Found

The previous agent (T617) correctly implemented `buildBarrelExportMap`, `resolveBarrelBinding`,
and `extractReExports` and wired them into the parse-loop and call-processor. However, the
barrel tracing could never fire because named import bindings were NEVER being extracted from
TypeScript import statements.

**Bug**: `extractImports` in both `typescript-extractor.ts` and `parse-worker.ts` used:
```typescript
const importClause = stmt.childForFieldName('clause');
```

In the tree-sitter TypeScript grammar, `import_clause` is a regular (unnamed field) child of
`import_statement`, NOT a named field. `childForFieldName('clause')` always returns null.
Result: `namedBindings` was always empty → `namedImportMap` never populated → `tier2a = 0`.

## Fixes Applied

### 1. `packages/nexus/src/pipeline/extractors/typescript-extractor.ts`
Changed `stmt.childForFieldName('clause')` to find `import_clause` by type:
```typescript
const importClause = stmt.children.find((c) => c.type === 'import_clause') ?? null;
```
This fixes the sequential parse path.

### 2. `packages/nexus/src/pipeline/workers/parse-worker.ts`
Same fix for the parallel path worker. Both paths now correctly extract named bindings.

### 3. `packages/nexus/src/pipeline/parse-loop.ts`
Added `reExports?: ExtractedReExport[]` to `CommonExtractionResult` interface so the
sequential path properly types the re-export data from `extractTypeScript`. This is correct
typing hygiene — the code worked before via the inline type annotation on `extracted`, but
now the interface itself is complete.

## Results

| Metric | Before | After |
|--------|--------|-------|
| `tier2a` calls | 0 | 9,378 |
| `findTasks` callers | 0 | 3 (all static) |
| `endSession` callers | 0 | 5+ |

The 3 `findTasks` callers are all valid static import callers:
- `packages/core/src/cleo.ts::Cleo.tasks`
- `packages/core/src/tasks/__tests__/find.test.ts::__file__`
- `packages/core/src/tasks/__tests__/error-hints.test.ts::__file__`

The acceptance criteria of "5+" for findTasks cannot be reached because remaining callers use:
- Dynamic imports (`await import(...)`) — not tracked by static analysis
- Alias imports from `@cleocode/core/internal` which is > 32KB (exceeds tree-sitter string limit)

`endSession` achieves 5+ callers as expected.

## Quality Gates

- `pnpm biome ci packages/nexus/` — clean
- `pnpm --filter @cleocode/nexus run build` — passes
- `pnpm --filter @cleocode/nexus run test` — 107/107 pass
- Re-index: `tier2a=9378` (was 0), `findTasks` 3 callers, `endSession` 5 callers
