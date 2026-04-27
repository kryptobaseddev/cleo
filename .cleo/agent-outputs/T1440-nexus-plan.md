# T1440 Nexus Dispatch OpsFromCore Refactor — Plan

## Summary

Migrate `packages/cleo/src/dispatch/domains/nexus.ts` from importing
contract param types directly from `@cleocode/contracts` to deriving
`NexusOps` via `OpsFromCore<typeof nexus.nexusCoreOps>`.

## Phase 1 Audit Findings

- **Dispatch handler**: `nexus.ts` — 1698 lines, 48 ops total (30 query, 18 mutate)
- **Current state**: Already uses `defineTypedHandler<NexusOps>` and `typedDispatch`
  with `T1424` typed migration done. BUT still imports ~50 param types directly from
  `@cleocode/contracts`.
- **Target state**: Use `OpsFromCore<typeof coreNexus.nexusCoreOps>` so the type
  source comes from Core, not contracts directly.
- **Special ops**: `handleTopEntries` and `handleImpact` are complex inline functions
  that bypass typed dispatch. They MUST be preserved.
- **Core nexus** (`packages/core/src/nexus/`): T1473 already extracted clusters, flows,
  context, impact, gexf, symbol-ranking, diff, projects-scan, projects-clean.
- **No new Core functions needed** — the nexus-engine.ts adapter functions already
  exist and the dispatch layer calls them. We just need a `nexusCoreOps` type registry.

## Migration Table

All 48 ops stay in the typed handler. The migration:
1. Remove ~50 `import type { NexusXxxParams, ... }` from `@cleocode/contracts`
2. Add `import type { nexus as coreNexus } from '@cleocode/core'`
3. Add `type NexusOps = OpsFromCore<typeof coreNexus.nexusCoreOps>` 
4. Remove `import type { OpsFromCore }` (already imported via adapters/typed.js)
5. Handler body stays identical — params are still narrowed by typed dispatch

## New Files

### `packages/core/src/nexus/ops.ts`

TypedOpRecord declaration that maps each NexusOps key to its params/result types
extracted from the tuple-based `NexusOps` contract type.

```ts
import type { NexusOps } from '@cleocode/contracts';
type NexusOpKeys = keyof NexusOps;
type NexusCoreOperation<K extends NexusOpKeys> = (
  params: NexusOps[K][0],
) => Promise<NexusOps[K][1]>;
export declare const nexusCoreOps: { ... };
```

### `packages/cleo/src/dispatch/domains/__tests__/nexus-opsfromcore.test.ts`

Regression tests verifying:
- `nexus.ts` uses `OpsFromCore<typeof coreNexus.nexusCoreOps>`
- `nexus.ts` no longer directly imports contract param types
- `nexusCoreOps` is exported from core nexus index

## Behavior Preservation

- All 48 op handlers remain identical
- `handleTopEntries` and `handleImpact` inline functions preserved exactly
- QUERY_OPS / MUTATE_OPS sets preserved
- `getSupportedOperations()` preserved
- All error messages, exit codes, pagination behavior preserved
