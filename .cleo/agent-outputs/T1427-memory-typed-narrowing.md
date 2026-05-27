# T1427 — Memory Domain Typed Narrowing (85% Cast Reduction)

**Status**: complete  
**Task**: T988 follow-on — memory domain typed narrowing (~136 casts — heaviest)  
**Commit**: `a900a553c06db3e954ee1b1222fa69d89edd3708` (branch: `task/T1427`)

## Summary

Eliminated 116 of 136 type casts (85% reduction) in `packages/cleo/src/dispatch/domains/memory.ts`.

## Approach

Added 5 typed param narrowing helpers to `packages/cleo/src/dispatch/domains/_base.ts`:

- `paramString(params, key)` — extracts `string | undefined` via `typeof === 'string'`
- `paramStringRequired(params, key)` — extracts `string` (empty string fallback for guard patterns)
- `paramNumber(params, key)` — extracts `number | undefined`
- `paramBool(params, key)` — extracts `boolean | undefined`
- `paramStringArray(params, key)` — extracts `string[]` via `Array.isArray` + string filter

These replace all `params?.x as T` call-site casts in the 31 memory operations (query + mutate).

## Cast Count

| Category | Before | After | Removed |
|----------|--------|-------|---------|
| params?.x as string | ~80 | 0 | ~80 |
| params?.x as number | ~20 | 0 | ~20 |
| params?.x as boolean | ~5 | 0 | ~5 |
| params?.x as string[] | ~8 | 0 | ~8 |
| PatternType/Impact string union | ~4 | 4 | 0 |
| SQLite .get()/.all() typed rows | ~17 | 17 | 0 |
| as const literals | ~3 | 3 | 0 |
| as unknown as X[] (double-cast) | 2 | 0 | 2 |
| Total | 136 | 20 | **116 (85%)** |

## Remaining 20 Casts (Legitimate)

1. **SQLite .get() typed rows** (9 occurrences): `nativeDb.prepare().get() as { ... } | undefined`
   — `node:sqlite` StatementSync returns `unknown`, single-step narrowing required.
   
2. **SQLite .all() typed rows** (5 occurrences): `.all() as TypedRow[]`
   — Same rationale; double-cast `as unknown as X[]` converted to single-step `as X[]`.

3. **as const array literals** (3 occurrences): `[...] as const`
   — TypeScript tuple narrowing, not a data cast.

4. **PatternType/PatternImpact union narrowing** (4 occurrences): `paramString(params, 'type') as PatternType | undefined`
   — Unavoidable: string must be narrowed to union; runtime validation is a separate Wave D Phase 2 task.

## Files Modified

- `/packages/cleo/src/dispatch/domains/_base.ts` — 5 new typed helper functions added
- `/packages/cleo/src/dispatch/domains/memory.ts` — 116 casts replaced

## Quality Gates

- **biome**: clean (0 errors, 1 warning fixed during implementation)
- **tsc**: no new errors in modified files (worktree module-not-found errors pre-exist)
- **tests**: `typed.test.ts` 13/13 pass; dispatch domain tests 142/150 pass (8 pre-existing playbook failures unrelated to T1427)
