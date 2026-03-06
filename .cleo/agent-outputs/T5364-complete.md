# T5364 Complete: generateProjectHash Deduplication

## Files Modified
- `src/core/nexus/hash.ts` -- CREATED (canonical single source of truth)
- `src/core/nexus/registry.ts` -- removed local impl, imports from hash.ts
- `src/core/nexus/permissions.ts` -- updated import to use hash.ts directly
- `src/core/nexus/index.ts` -- added direct re-export from hash.ts, removed from registry re-export
- `src/core/scaffold.ts` -- removed local impl, re-exports from nexus/hash.ts for backward compat
- `src/store/project-registry.ts` -- removed createHash import, delegates to canonical impl via thin wrapper (preserves empty-path guard for backward compat)

## Validation Results
- npx tsc --noEmit: 0 errors (clean)
- grep for duplicate project-hash impls: only 1 canonical impl in hash.ts

## Third duplicate found and resolved
The task mentioned 2 duplicates (registry.ts and scaffold.ts), but a third was found in `src/store/project-registry.ts`. That version had an additional empty-path guard (`if (!path) throw`). Resolved by keeping a thin wrapper that validates input then delegates to the canonical implementation.

## Any TODOs found and resolved
None found in modified files.

## Status: COMPLETE
