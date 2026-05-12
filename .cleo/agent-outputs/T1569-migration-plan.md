# T1569 Migration Plan — DELETE nexus-engine.ts → packages/core/nexus/

**Epic**: T1566 (T-ENGINE-MIGRATION)
**Date**: 2026-04-30
**Source**: `packages/cleo/src/dispatch/engines/nexus-engine.ts` (2016 LOC, 63 exports)
**Target dir**: `packages/core/src/nexus/` (34 files already exist)

---

## 1. Decisions (Q1–Q5)

### Q1 — EngineResult pattern

**Finding**: `EngineResult` lives in `packages/core/src/engine-result.ts` and is publicly exported
from `@cleocode/core` (index.ts line 213). `engineSuccess` and `engineError` are exported from
`@cleocode/core`. There is no `cleoErrorToEngineError` in core — `packages/cleo/src/dispatch/engines/_error.ts`
owns that helper. The T1568 migration established a pattern: add a private `caughtToEngineError`
helper (see `packages/core/src/tasks/show.ts` lines 138–148) within each new core file that needs it,
rather than importing from `_error.ts` (which would create a cross-layer dependency).

The nexus-engine.ts functions use three patterns:
- **Pattern A** (most common): `try { return engineSuccess(await coreFunc()) } catch { return engineError(...) }` — thin delegating wrappers.
- **Pattern B** (complex SQL): `nexusImpact` (~185 LOC) and `nexusTopEntries` (~169 LOC) contain inline BFS graph traversal and multi-DB query logic using raw SQL via `getNexusNativeDb()`. These are genuine business logic, not wrappers.
- **Pattern C** (lazy import): 26 functions use `await import('@cleocode/core/...' as string)` to defer circular-import risks. Post-migration these become static imports since the code moves INTO core.

**Decision: Keep EngineResult-returning signatures in core.** New functions added to core/nexus/ files
return `EngineResult<T>`. The domain handler continues to call `wrapCoreResult(await nexusFunc(...), opName)`.
Add a private `caughtToEngineError` helper at the top of any new core file that needs try/catch wrapping,
mirroring the T1568 pattern in `packages/core/src/tasks/show.ts`.

---

### Q2 — Domain handler call shape post-migration

**Current**: `nexus.ts` imports all 63 functions directly from `'../engines/nexus-engine.js'`.

**Post-migration**: `nexus.ts` imports directly from `@cleocode/core/internal` (for the newly-added
EngineResult-returning core functions). There is NO `lib/engine.ts` barrel for nexus — unlike task-engine
which was re-exported through `lib/engine.ts`, nexus-engine.ts is imported directly by the domain handler.
This means the barrel (`lib/engine.ts`) requires NO changes for this migration.

The handler's op bodies stay identical — only the import source changes:
```typescript
// Before
import { nexusStatus, nexusImpact, ... } from '../engines/nexus-engine.js';

// After
import { nexusStatus, nexusImpact, ... } from '@cleocode/core/internal';
```

---

### Q3 — Lazy imports: convert to static?

**Finding**: 26 out of 63 functions use `await import('@cleocode/core/nexus/...' as string)`.
The `as string` cast is a workaround to avoid TypeScript circular-import analysis at build time.
Once these functions move INTO `packages/core/src/nexus/`, they can use **static imports** from
sibling files (e.g., `import { getSymbolFullContext } from './living-brain.js'`) — no circular
risk because the code is no longer crossing a package boundary.

**Decision**: Convert ALL lazy imports to static imports in the migrated core files. This improves
tree-shaking, eliminates runtime dynamic resolution, and removes the fragile `as string` cast pattern.

---

### Q4 — Complex SQL functions (nexusImpact, nexusTopEntries)

**Finding**:
- `nexusImpact` (lines 221–403, ~185 LOC): BFS graph traversal over `nexus_nodes`/`nexus_relations`
  tables using raw `getNexusNativeDb()` SQL. Not a thin wrapper — this IS the business logic.
- `nexusTopEntries` (lines 404–569, ~169 LOC): Multi-source query (brain_page_nodes fallback to
  nexus_relations) with graceful empty-result handling. Also genuine business logic.

**Decision**: Both functions move to `packages/core/src/nexus/query.ts` (extend existing file).
They import `getNexusNativeDb` and `getBrainNativeDb` from `@cleocode/core/internal` (already done
in the existing file). The `paginate` function (used in nexusOrphans and nexusListProjects) comes
from `packages/core/src/pagination.ts` — import directly.

**Alternative considered**: A new `packages/core/src/nexus/query-engine.ts`. Rejected because
`packages/core/src/nexus/query.ts` already contains cross-project task resolution logic and the
`nexusImpact`/`nexusTopEntries` functions are still query operations. Extending the existing file
is cleaner than creating a parallel file.

---

### Q5 — Session-scope or strict-mode concerns

**Finding**: Unlike task-engine.ts, nexus-engine.ts has NO session-scope dependencies. None of the
63 functions call `getActiveSession`. There is no strict-mode enforcement chain analogous to
`taskCompleteStrict`. All nexus functions are either read-only queries or straightforward mutations
(register/unregister/sync/permission/sigil/profile CRUD).

**Decision**: No session-scope helper extraction needed. Each function is independently relocatable.

---

## 2. Existing core/nexus/ Surface (Worker MUST NOT Duplicate)

Files in `packages/core/src/nexus/` with their sizes and key exported functions the worker must
preserve and extend (not duplicate):

| File | LOC | Key exports relevant to migration |
|------|-----|-----------------------------------|
| `augment.ts` | 165 | `augmentSymbol`, `formatAugmentResults` — **nexusAugment delegates here** |
| `clusters.ts` | 79 | `getProjectClusters` — **nexusClusters lazy-imports this** |
| `context.ts` | 302 | `getSymbolContext` — **nexusContext lazy-imports this** |
| `deps.ts` | 555 | `blockingAnalysis`, `buildGlobalGraph`, `criticalPath`, `nexusDeps`, `orphanDetection` |
| `diff.ts` | 211 | `diffNexusIndex` — **nexusDiff lazy-imports this** |
| `discover.ts` | 376 | `discoverRelated`, `searchAcrossProjects` |
| `flows.ts` | 82 | `getProjectFlows` — **nexusFlows lazy-imports this** |
| `impact.ts` | 251 | `getSymbolImpact` — note: different from `nexusImpact` (which is SQL BFS) |
| `living-brain.ts` | 1211 | `getSymbolFullContext`, `getTaskCodeImpact`, `getBrainEntryCodeAnchors`, `reasonImpactOfChange` |
| `nexus-bridge.ts` | 460 | `writeNexusBridge`, `generateNexusBridgeContent` — **nexusRefreshBridge uses this** |
| `ops.ts` | 120 | `nexusCoreOps` — **DO NOT MODIFY** (OpsFromCore inference type source) |
| `permissions.ts` | 162 | `setPermission` — **nexusSetPermission delegates here** |
| `plasticity-queries.ts` | 269 | `getHotPaths`, `getHotNodes`, `getColdSymbols` |
| `projects-clean.ts` | 207 | `cleanProjects`, `NoCriteriaError`, `InvalidPatternError` |
| `projects-scan.ts` | 257 | `scanForProjects` — **nexusProjectsScan lazy-imports this** |
| `query.ts` | 240 | `resolveTask`, `validateSyntax`, `getCurrentProject` — **extend with nexusImpact + nexusTopEntries** |
| `query-dsl.ts` | 352 | `compileCteAlias`, `runNexusCte` — **nexusQueryCte lazy-imports these** |
| `registry.ts` | 905 | `nexusInit`, `nexusList`, `nexusRegister`, `nexusUnregister`, `nexusSync`, `nexusSyncAll`, `nexusGetProject`, `nexusReconcile`, `nexusSetPermission`, `readRegistry` |
| `route-analysis.ts` | 320 | `getRouteMap`, `shapeCheck` |
| `sharing/index.ts` | ~350 | `getSharingStatus` |
| `sigil.ts` | 204 | `listSigils`, `getSigil`, `upsertSigil` |
| `sigil-sync.ts` | 465 | `syncCanonicalSigils`, `parseSigilFromCant`, `resolveCanonicalCantFiles` |
| `tasks-bridge.ts` | 528 | `runGitLogTaskLinker`, `getSymbolsForTask`, `getTasksForSymbol` |
| `transfer.ts` | 509 | `executeTransfer`, `previewTransfer`, `exportUserProfile`, `importUserProfile` |
| `user-profile.ts` | 256 | `listUserProfile`, `getUserProfileTrait`, `reinforceTrait`, `supersedeTrait`, `upsertUserProfileTrait` |
| `wiki-index.ts` | 546 | `generateNexusWikiIndex` — **nexusWiki lazy-imports this** |

**Also in core/memory/** (lazy-imported by nexus-engine.ts):
- `brain-reasoning.ts`: `reasonWhySymbol` — **nexusWhy lazy-imports this**
- `graph-memory-bridge.ts`: `linkConduitMessagesToSymbols` — **nexusConduitScan lazy-imports this**

**Also in core/nexus/api-extractors/** (lazy-imported by nexus-engine.ts):
- `http-extractor.ts`, `grpc-extractor.ts`, `topic-extractor.ts`, `matcher.ts`, `index.ts` — **nexusContractsSync + nexusContractsShow lazy-import these**

---

## 3. Symbol Inventory

Every export from `nexus-engine.ts` with proposed target file in `core/nexus/`.
"(extend)" = add to existing file. "(new)" = create new file.

### Re-exported types

| Symbol | Current source | Post-migration: import from |
|--------|---------------|------------------------------|
| `type EngineResult` | re-export from `./_error.js` | `@cleocode/core` directly |

### Wave 1 — Registry operations (8 functions → extend `registry.ts` + new `registry-engine.ts`)

These are thin wrappers around existing `registry.ts` functions:

| Symbol (nexus-engine.ts) | Core function called | Target |
|--------------------------|---------------------|--------|
| `nexusStatus` | `readRegistry` | extend `packages/core/src/nexus/registry.ts` |
| `nexusListProjects` | `nexusList` + `paginate` | extend `packages/core/src/nexus/registry.ts` |
| `nexusShowProject` | `nexusGetProject` | extend `packages/core/src/nexus/registry.ts` |
| `nexusInitialize` | `nexusInit` | extend `packages/core/src/nexus/registry.ts` |
| `nexusRegisterProject` | `nexusRegister` | extend `packages/core/src/nexus/registry.ts` |
| `nexusUnregisterProject` | `nexusUnregister` | extend `packages/core/src/nexus/registry.ts` |
| `nexusSyncProject` | `nexusSync` / `nexusSyncAll` | extend `packages/core/src/nexus/registry.ts` |
| `nexusSetPermission` | `setPermission` | extend `packages/core/src/nexus/registry.ts` |
| `nexusReconcileProject` | `nexusReconcile` | extend `packages/core/src/nexus/registry.ts` |

### Wave 1 — Query/resolve/deps operations (7 functions → extend `query.ts` + `deps.ts`)

| Symbol | Core function called | Target |
|--------|---------------------|--------|
| `nexusResolve` | `resolveTask` + `validateSyntax` | extend `packages/core/src/nexus/query.ts` |
| `nexusDepsQuery` | `nexusDeps` | extend `packages/core/src/nexus/deps.ts` |
| `nexusGraph` | `buildGlobalGraph` | extend `packages/core/src/nexus/deps.ts` |
| `nexusCriticalPath` | `criticalPath` | extend `packages/core/src/nexus/deps.ts` |
| `nexusBlockers` | `blockingAnalysis` | extend `packages/core/src/nexus/deps.ts` |
| `nexusOrphans` | `orphanDetection` + `paginate` | extend `packages/core/src/nexus/deps.ts` |
| `nexusImpact` | raw SQL BFS via `getNexusNativeDb` | extend `packages/core/src/nexus/impact.ts` |
| `nexusTopEntries` | raw SQL + `getBrainNativeDb`/`getNexusNativeDb` | extend `packages/core/src/nexus/query.ts` |

**Note on `nexusImpact`**: The existing `packages/core/src/nexus/impact.ts` exports `getSymbolImpact`
which is a different function (higher-level BFS using the Drizzle ORM layer). The `nexusImpact` function
in nexus-engine.ts is a direct SQL implementation. Adding it to `impact.ts` is appropriate — it is still
impact analysis, just via a different code path.

### Wave 2 — Discovery, augment, sharing (5 functions → extend `discover.ts`, `augment.ts`, `sharing/index.ts`)

| Symbol | Core function called | Target |
|--------|---------------------|--------|
| `nexusDiscover` | `discoverRelated` (alias: `nexusDiscoverRelated`) | extend `packages/core/src/nexus/discover.ts` |
| `nexusSearch` | `searchAcrossProjects` | extend `packages/core/src/nexus/discover.ts` |
| `nexusAugment` | `augmentSymbol` + `formatAugmentResults` | extend `packages/core/src/nexus/augment.ts` |
| `nexusSearchCode` | delegates to `nexusAugment` (thin alias) | extend `packages/core/src/nexus/augment.ts` |
| `nexusShareStatus` | `getSharingStatus` | extend `packages/core/src/nexus/sharing/index.ts` |

### Wave 2 — Transfer + snapshot operations (4 functions → extend `transfer.ts`)

| Symbol | Core function called | Target |
|--------|---------------------|--------|
| `nexusShareSnapshotExport` | `exportSnapshot` + `writeSnapshot` + `getDefaultSnapshotPath` | extend `packages/core/src/nexus/transfer.ts` |
| `nexusShareSnapshotImport` | `readSnapshot` + `importSnapshot` | extend `packages/core/src/nexus/transfer.ts` |
| `nexusTransferPreview` | `previewTransfer` | extend `packages/core/src/nexus/transfer.ts` |
| `nexusTransferExecute` | `executeTransfer` | extend `packages/core/src/nexus/transfer.ts` |

### Wave 2 — Living Brain primitives (5 functions → extend `living-brain.ts`)

These currently use lazy imports. Post-migration: static imports from sibling file.

| Symbol | Target core function | Target |
|--------|---------------------|--------|
| `nexusFullContext` | `getSymbolFullContext` | extend `packages/core/src/nexus/living-brain.ts` |
| `nexusTaskFootprint` | `getTaskCodeImpact` | extend `packages/core/src/nexus/living-brain.ts` |
| `nexusBrainAnchors` | `getBrainEntryCodeAnchors` | extend `packages/core/src/nexus/living-brain.ts` |
| `nexusImpactFull` | `reasonImpactOfChange` | extend `packages/core/src/nexus/living-brain.ts` |
| `nexusWhy` | `reasonWhySymbol` from `memory/brain-reasoning.ts` | extend `packages/core/src/nexus/living-brain.ts` |

### Wave 3 — Code intelligence + route + wiki (4 functions → extend `route-analysis.ts`, `wiki-index.ts`, `query-dsl.ts`)

| Symbol | Target core function | Target |
|--------|---------------------|--------|
| `nexusRouteMap` | `getRouteMap` | extend `packages/core/src/nexus/route-analysis.ts` |
| `nexusShapeCheck` | `shapeCheck` | extend `packages/core/src/nexus/route-analysis.ts` |
| `nexusWiki` | `generateNexusWikiIndex` | extend `packages/core/src/nexus/wiki-index.ts` |
| `nexusQueryCte` | `compileCteAlias` + `runNexusCte` | extend `packages/core/src/nexus/query-dsl.ts` |

### Wave 3 — Contracts + ingestion bridge (5 functions → new `api-contracts-engine.ts`)

These lazy-import from `api-extractors/` subdir. Logic is non-trivial (parallel extraction, matrix
computation). No existing file has a natural home. Create a focused file.

| Symbol | Target |
|--------|--------|
| `nexusContractsSync` | (new) `packages/core/src/nexus/api-contracts-engine.ts` |
| `nexusContractsShow` | (new) `packages/core/src/nexus/api-contracts-engine.ts` |
| `nexusContractsLinkTasks` | (new) `packages/core/src/nexus/api-contracts-engine.ts` |
| `nexusConduitScan` | (new) `packages/core/src/nexus/api-contracts-engine.ts` |
| `nexusTaskSymbols` | (new) `packages/core/src/nexus/api-contracts-engine.ts` |

**Rationale for new file**: `nexusContractsSync` and `nexusContractsShow` have significant orchestration
logic (parallel extractor calls, matrix computation from T1117). These are not thin wrappers — they belong
in a focused module, not appended to an unrelated existing file.

### Wave 3 — Plasticity + graph ops (5 functions → extend `plasticity-queries.ts`)

These currently lazy-import from `@cleocode/core/internal`. They move into the file that already owns
the underlying functions.

| Symbol | Core function | Target |
|--------|--------------|--------|
| `nexusHotPaths` | `getHotPaths` | extend `packages/core/src/nexus/plasticity-queries.ts` |
| `nexusHotNodes` | `getHotNodes` | extend `packages/core/src/nexus/plasticity-queries.ts` |
| `nexusColdSymbols` | `getColdSymbols` | extend `packages/core/src/nexus/plasticity-queries.ts` |

### Wave 3 — Phase 2 dispatch ops (8 functions → extend existing specialized files)

| Symbol | Core function | Target |
|--------|--------------|--------|
| `nexusClusters` | `getProjectClusters` | extend `packages/core/src/nexus/clusters.ts` |
| `nexusFlows` | `getProjectFlows` | extend `packages/core/src/nexus/flows.ts` |
| `nexusContext` | `getSymbolContext` | extend `packages/core/src/nexus/context.ts` |
| `nexusProjectsList` | `nexusList` (lazy → static) | extend `packages/core/src/nexus/registry.ts` |
| `nexusProjectsRegister` | `nexusRegister` (lazy → static) | extend `packages/core/src/nexus/registry.ts` |
| `nexusProjectsRemove` | `nexusUnregister` (lazy → static) | extend `packages/core/src/nexus/registry.ts` |
| `nexusProjectsScan` | `scanForProjects` | extend `packages/core/src/nexus/projects-scan.ts` |
| `nexusProjectsClean` | `cleanProjects` + validation | extend `packages/core/src/nexus/projects-clean.ts` |
| `nexusRefreshBridge` | `writeNexusBridge` | extend `packages/core/src/nexus/nexus-bridge.ts` |
| `nexusDiff` | `diffNexusIndex` | extend `packages/core/src/nexus/diff.ts` |

### Wave 4 — User profile operations (7 functions → extend `user-profile.ts`)

| Symbol | Core function | Target |
|--------|--------------|--------|
| `nexusProfileView` | `listUserProfile` | extend `packages/core/src/nexus/user-profile.ts` |
| `nexusProfileGet` | `getUserProfileTrait` | extend `packages/core/src/nexus/user-profile.ts` |
| `nexusProfileImport` | `importUserProfile` | extend `packages/core/src/nexus/user-profile.ts` |
| `nexusProfileExport` | `exportUserProfile` | extend `packages/core/src/nexus/user-profile.ts` |
| `nexusProfileReinforce` | `reinforceTrait` + `getUserProfileTrait` | extend `packages/core/src/nexus/user-profile.ts` |
| `nexusProfileUpsert` | `upsertUserProfileTrait` (with full-trait assembly) | extend `packages/core/src/nexus/user-profile.ts` |
| `nexusProfileSupersede` | `supersedeTrait` | extend `packages/core/src/nexus/user-profile.ts` |

**Note on `nexusProfileUpsert`**: Contains non-trivial logic assembling a `UserProfileTrait` from wire
params (setting `firstObservedAt`, `lastReinforcedAt`, `reinforcementCount`, `supersededBy` defaults
with existing-trait awareness). This IS business logic, not a thin wrapper. Belongs in `user-profile.ts`.

**Note on `nexusProfileReinforce`**: Calls `reinforceTrait` then fetches the updated trait for the
response. Compound operation — both calls must stay together in the migrated function.

### Wave 4 — Sigil operations (2 functions → extend `sigil.ts` + `sigil-sync.ts`)

| Symbol | Core function | Target |
|--------|--------------|--------|
| `nexusSigilList` | `listSigils` | extend `packages/core/src/nexus/sigil.ts` |
| `nexusSigilSync` | `syncCanonicalSigils` | extend `packages/core/src/nexus/sigil-sync.ts` |

---

## 4. Call-Site Update Table

All files that import from `nexus-engine.ts` and must be updated when it is deleted:

| # | File | Current import | Post-migration import | Wave |
|---|------|---------------|----------------------|------|
| 1 | `packages/cleo/src/dispatch/domains/nexus.ts` | 63 functions from `'../engines/nexus-engine.js'` | Same 63 names from `'@cleocode/core/internal'` | 5 |
| 2 | `packages/cleo/src/dispatch/domains/__tests__/nexus.test.ts` | `vi.mock('../../engines/nexus-engine.js', ...)` + named imports | Change mock path to `'@cleocode/core/internal'` or `'../../engines/nexus-engine.js'` (see note) | 5 |
| 3 | `packages/cleo/src/dispatch/domains/__tests__/nexus-phase2-dispatch.test.ts` | `vi.mock('../../engines/nexus-engine.js', ...)` + named imports | Change mock path | 5 |
| 4 | `packages/cleo/src/dispatch/domains/__tests__/nexus-living-brain-dispatch.test.ts` | `vi.mock('../../engines/nexus-engine.js', ...)` + named imports | Change mock path | 5 |
| 5 | `packages/cleo/src/dispatch/domains/__tests__/nexus-contracts-ingestion-dispatch.test.ts` | `vi.mock('../../engines/nexus-engine.js', ...)` + named imports | Change mock path | 5 |
| 6 | `packages/cleo/src/dispatch/domains/__tests__/nexus-code-intel-dispatch.test.ts` | `vi.mock('../../engines/nexus-engine.js', ...)` + named imports | Change mock path | 5 |

**Files with NO changes needed**: `lib/engine.ts` — nexus-engine.ts is NOT re-exported through
the lib/engine.ts barrel. No barrel changes required.

**Note on test mock strategy**: These tests currently mock `'../../engines/nexus-engine.js'` (the
intermediate barrel). After deletion, they must mock `@cleocode/core/internal` for the nexus functions.
The test structure (5 files, ~2776 LOC total) remains identical in intent — only the `vi.mock` path
and named import path changes. Each test's mock factory object (listing all stubbed functions) stays the same.

---

## 5. Wave Plan (5 Waves)

### Wave 1: Registry + Query + Core ops (~350 LOC added to existing files, medium)

**Goal**: Move the registry CRUD wrappers and core query/dep operations into the existing files that
own those domains. No new files created.

**Files extended**:
- `packages/core/src/nexus/registry.ts` — add `nexusStatus`, `nexusListProjects`, `nexusShowProject`, `nexusInitialize`, `nexusRegisterProject`, `nexusUnregisterProject`, `nexusSyncProject`, `nexusSetPermission`, `nexusReconcileProject`, `nexusProjectsList`, `nexusProjectsRegister`, `nexusProjectsRemove`
- `packages/core/src/nexus/deps.ts` — add `nexusDepsQuery`, `nexusGraph`, `nexusCriticalPath`, `nexusBlockers`, `nexusOrphans`
- `packages/core/src/nexus/query.ts` — add `nexusResolve`, `nexusTopEntries`
- `packages/core/src/nexus/impact.ts` — add `nexusImpact` (185 LOC SQL BFS logic)
- `packages/core/src/nexus/index.ts` — export all new symbols
- `packages/core/src/internal.ts` — export all new symbols

**Implementation notes**:
- `nexusListProjects` and `nexusOrphans` use `paginate` from `packages/core/src/pagination.ts` — import directly.
- `nexusImpact` uses `getNexusNativeDb` (already used in `impact.ts` via `@cleocode/core/internal` imports).
- `nexusTopEntries` uses both `getBrainNativeDb` and `getNexusNativeDb` — add these imports to `query.ts`.
- Add private `caughtToEngineError` helper at top of each file that needs it.
- Import `EngineResult`, `engineSuccess`, `engineError` from `'../engine-result.js'` (relative within core).
- `nexusSyncProject` conditionally calls `nexusSync` or `nexusSyncAll` — both already in `registry.ts`.
- `nexusProjectsList`, `nexusProjectsRegister`, `nexusProjectsRemove` currently use lazy imports from `@cleocode/core/internal`. After moving into `registry.ts`, convert to static calls to the local functions (`nexusList`, `nexusRegister`, `nexusUnregister`) which are already defined in the same file.

**Files NOT touched yet**: `nexus-engine.ts`, `nexus.ts` (domain handler), all test files.

**Commit message**:
```
feat(T1569): move registry + query + impact wrappers to core/nexus (Wave 1)

Extends registry.ts with nexusStatus, nexusListProjects, nexusShowProject,
nexusInitialize, nexusRegisterProject, nexusUnregisterProject, nexusSyncProject,
nexusSetPermission, nexusReconcileProject, nexusProjectsList, nexusProjectsRegister,
nexusProjectsRemove. Extends deps.ts with nexusDepsQuery, nexusGraph,
nexusCriticalPath, nexusBlockers, nexusOrphans. Extends query.ts with
nexusResolve, nexusTopEntries. Extends impact.ts with nexusImpact (SQL BFS).
All lazy imports converted to static. nexus-engine.ts still present.

Refs: T1569, T1566, ADR-057
```

**Verify**:
```bash
pnpm biome check --write .
pnpm run build
pnpm run test  # zero new failures
```

---

### Wave 2: Discovery + Sharing + Living Brain + Transfer (~300 LOC, medium)

**Goal**: Move the discovery/search/augment ops, sharing status, snapshot ops, transfer ops, and all
5 Living Brain primitives. Convert all lazy imports to static.

**Files extended**:
- `packages/core/src/nexus/discover.ts` — add `nexusDiscover`, `nexusSearch`
- `packages/core/src/nexus/augment.ts` — add `nexusAugment`, `nexusSearchCode`
- `packages/core/src/nexus/sharing/index.ts` — add `nexusShareStatus`
- `packages/core/src/nexus/transfer.ts` — add `nexusShareSnapshotExport`, `nexusShareSnapshotImport`, `nexusTransferPreview`, `nexusTransferExecute`
- `packages/core/src/nexus/living-brain.ts` — add `nexusFullContext`, `nexusTaskFootprint`, `nexusBrainAnchors`, `nexusImpactFull`, `nexusWhy`
- `packages/core/src/nexus/index.ts` — export all new symbols
- `packages/core/src/internal.ts` — export all new symbols

**Implementation notes**:
- `nexusWhy` calls `reasonWhySymbol` from `'../memory/brain-reasoning.js'` — add static import at top of `living-brain.ts`.
- `nexusSearchCode` is a thin alias: `return nexusAugment(pattern, limit)` — keep as one-liner inside `augment.ts`.
- Snapshot functions (`exportSnapshot`, `writeSnapshot`, `readSnapshot`, `importSnapshot`, `getDefaultSnapshotPath`) live in `packages/core/src/snapshot/index.ts`. Import directly via relative path `'../../snapshot/index.js'` inside `transfer.ts`.
- `nexusShareSnapshotExport` orchestrates 3 calls (export + resolve path + write) — this compound logic moves as-is.
- `nexusDiscover` uses `discoverRelated` (which in `discover.ts` is the local function, not the re-export alias). No import alias needed within the file.
- `nexusSearch` uses `searchAcrossProjects` — already in `discover.ts`.

**Files NOT touched yet**: `nexus-engine.ts`, `nexus.ts`, test files.

**Commit message**:
```
feat(T1569): move discovery + sharing + living brain + transfer wrappers to core/nexus (Wave 2)

Extends discover.ts with nexusDiscover, nexusSearch. Extends augment.ts with
nexusAugment, nexusSearchCode. Extends sharing/index.ts with nexusShareStatus.
Extends transfer.ts with snapshot + transfer ops. Extends living-brain.ts with
5 Living Brain primitives (nexusFullContext, nexusTaskFootprint, nexusBrainAnchors,
nexusImpactFull, nexusWhy). All lazy imports converted to static.

Refs: T1569, T1566, ADR-057
```

**Verify**:
```bash
pnpm biome check --write .
pnpm run build
pnpm run test  # zero new failures
```

---

### Wave 3: Code Intel + Contracts + Plasticity + Phase-2 ops (~400 LOC, medium-large)

**Goal**: Move code intelligence (route-map, shape-check, wiki, CTE), the contracts/ingestion bridge
(new file), plasticity queries, and Phase-2 dispatch ops (clusters, flows, context, diff, etc.).

**Files extended**:
- `packages/core/src/nexus/route-analysis.ts` — add `nexusRouteMap`, `nexusShapeCheck`
- `packages/core/src/nexus/wiki-index.ts` — add `nexusWiki`
- `packages/core/src/nexus/query-dsl.ts` — add `nexusQueryCte`
- `packages/core/src/nexus/plasticity-queries.ts` — add `nexusHotPaths`, `nexusHotNodes`, `nexusColdSymbols`
- `packages/core/src/nexus/clusters.ts` — add `nexusClusters`
- `packages/core/src/nexus/flows.ts` — add `nexusFlows`
- `packages/core/src/nexus/context.ts` — add `nexusContext`
- `packages/core/src/nexus/projects-scan.ts` — add `nexusProjectsScan`
- `packages/core/src/nexus/projects-clean.ts` — add `nexusProjectsClean`
- `packages/core/src/nexus/nexus-bridge.ts` — add `nexusRefreshBridge`
- `packages/core/src/nexus/diff.ts` — add `nexusDiff`

**Files created**:
- `packages/core/src/nexus/api-contracts-engine.ts` — `nexusContractsSync`, `nexusContractsShow`, `nexusContractsLinkTasks`, `nexusConduitScan`, `nexusTaskSymbols`

**Files extended (barrel)**:
- `packages/core/src/nexus/index.ts` — export all new symbols
- `packages/core/src/internal.ts` — export all new symbols

**Implementation notes**:
- `nexusRouteMap` and `nexusShapeCheck` call `getRouteMap`/`shapeCheck` — both already in `route-analysis.ts`.
- `nexusWiki` calls `generateNexusWikiIndex` — already in `wiki-index.ts`.
- `nexusQueryCte` contains alias validation logic (6 known aliases) — include as-is in `query-dsl.ts`.
- `nexusProjectsClean` contains pre-validation logic (criteria check, regex validation) BEFORE calling `cleanProjects` — include as-is in `projects-clean.ts`. This validation is business logic.
- `nexusRefreshBridge` calls `writeNexusBridge` — already in `nexus-bridge.ts`. The `resolvedProjectId` computation stays in the function body.
- For `api-contracts-engine.ts`: import from `'./api-extractors/index.js'`, `'./api-extractors/http-extractor.js'`, etc. (static imports). Import `runGitLogTaskLinker` from `'./tasks-bridge.js'`. Import `linkConduitMessagesToSymbols` from `'../memory/graph-memory-bridge.js'`.
- `nexusContractsShow` has significant inline logic (parallel extraction from two projects, matrix assembly, count computation). Include as-is.
- `nexusHotPaths`, `nexusHotNodes`, `nexusColdSymbols` become thin wrappers around local functions already in `plasticity-queries.ts`.

**Files NOT touched yet**: `nexus-engine.ts`, `nexus.ts`, test files.

**Commit message**:
```
feat(T1569): move code-intel + contracts + plasticity + phase-2 ops to core/nexus (Wave 3)

Extends route-analysis.ts (route-map, shape-check), wiki-index.ts (wiki),
query-dsl.ts (query-cte), plasticity-queries.ts (hot-paths, hot-nodes, cold-symbols),
clusters.ts, flows.ts, context.ts, projects-scan.ts, projects-clean.ts,
nexus-bridge.ts, diff.ts. Creates api-contracts-engine.ts (contracts-sync,
contracts-show, contracts-link-tasks, conduit-scan, task-symbols).

Refs: T1569, T1566, ADR-057
```

**Verify**:
```bash
pnpm biome check --write .
pnpm run build
pnpm run test  # zero new failures
```

---

### Wave 4: User Profile + Sigil operations (~300 LOC, medium)

**Goal**: Move all 7 user-profile CRUD wrappers and 2 sigil wrappers into the existing files.

**Files extended**:
- `packages/core/src/nexus/user-profile.ts` — add `nexusProfileView`, `nexusProfileGet`, `nexusProfileImport`, `nexusProfileExport`, `nexusProfileReinforce`, `nexusProfileUpsert`, `nexusProfileSupersede`
- `packages/core/src/nexus/sigil.ts` — add `nexusSigilList`
- `packages/core/src/nexus/sigil-sync.ts` — add `nexusSigilSync`
- `packages/core/src/nexus/index.ts` — export all new symbols
- `packages/core/src/internal.ts` — export all new symbols

**Import types for user-profile.ts**:
```typescript
import type {
  NexusProfileExportResult,
  NexusProfileGetResult,
  NexusProfileImportResult,
  NexusProfileReinforceResult,
  NexusProfileSupersedeResult,
  NexusProfileUpsertResult,
  NexusProfileViewResult,
  UserProfileTrait,
} from '@cleocode/contracts';
```

**Implementation notes**:
- `nexusProfileView` and `nexusProfileGet` and `nexusProfileReinforce` call `await getNexusDb()` — this is already imported in `user-profile.ts` (check first; if not, import from `'../store/nexus-sqlite.js'`).
- `nexusProfileUpsert` assembles a full `UserProfileTrait` from a `Pick<...>` wire param — include the full assembly logic (existing-trait check + now-ISO timestamps + increment reinforcementCount). This is the non-trivial logic from nexus-engine.ts lines 1534–1564.
- `nexusSigilList`: calls `listSigils(nexusDb, role ? { role } : undefined)` — `listSigils` is already in `sigil.ts`. Import `getNexusDb` from `'../store/nexus-sqlite.js'`.
- `nexusSigilSync`: calls `syncCanonicalSigils()` — already in `sigil-sync.ts`.

**Import contracts type for sigil.ts**:
```typescript
import type { NexusSigilListResult } from '@cleocode/contracts';
```

**Files NOT touched yet**: `nexus-engine.ts`, `nexus.ts`, test files.

**Commit message**:
```
feat(T1569): move user-profile + sigil wrappers to core/nexus (Wave 4)

Extends user-profile.ts with 7 profile ops (view, get, import, export,
reinforce, upsert with full-trait assembly, supersede). Extends sigil.ts
with nexusSigilList. Extends sigil-sync.ts with nexusSigilSync.

Refs: T1569, T1566, ADR-057
```

**Verify**:
```bash
pnpm biome check --write .
pnpm run build
pnpm run test  # zero new failures
```

---

### Wave 5: DELETE nexus-engine.ts + wire dispatch + update tests (~final wiring, large)

**Goal**: Delete `nexus-engine.ts`. Update the domain handler to import from `@cleocode/core/internal`.
Rewrite all 5 test files to mock `@cleocode/core/internal` instead of `nexus-engine.js`.

**Files deleted**:
- `packages/cleo/src/dispatch/engines/nexus-engine.ts` — **DELETED**

**Files modified**:
- `packages/cleo/src/dispatch/domains/nexus.ts`:
  - Replace `import { ... } from '../engines/nexus-engine.js'` with `import { ... } from '@cleocode/core/internal'`
  - All 63 function names remain identical — no handler body changes needed
  - Remove `import type { EngineResult }` if unused (handler calls `wrapCoreResult`, not `EngineResult` directly)
- `packages/cleo/src/dispatch/domains/__tests__/nexus.test.ts`:
  - Change `vi.mock('../../engines/nexus-engine.js', ...)` → `vi.mock('@cleocode/core/internal', ...)`
  - Update named imports: `from '../../engines/nexus-engine.js'` → `from '@cleocode/core/internal'`
  - Mock factory object (listing all stubbed functions) stays identical
- `packages/cleo/src/dispatch/domains/__tests__/nexus-phase2-dispatch.test.ts`: same pattern
- `packages/cleo/src/dispatch/domains/__tests__/nexus-living-brain-dispatch.test.ts`: same pattern
- `packages/cleo/src/dispatch/domains/__tests__/nexus-contracts-ingestion-dispatch.test.ts`: same pattern
- `packages/cleo/src/dispatch/domains/__tests__/nexus-code-intel-dispatch.test.ts`: same pattern

**Files NOT changed**:
- `packages/cleo/src/dispatch/lib/engine.ts` — no nexus-engine block exists; no changes needed
- `packages/cleo/src/__tests__/core-parity.test.ts` — does NOT reference nexus-engine.ts; no changes needed
- Any file that mocked `lib/engine.ts` — nexus was never in the barrel

**Commit message**:
```
feat(T1569): delete nexus-engine.ts, wire dispatch to @cleocode/core/internal (Wave 5)

Deletes packages/cleo/src/dispatch/engines/nexus-engine.ts (2016 LOC, 63 exports).
Updates nexus.ts domain handler to import all 63 functions from @cleocode/core/internal.
Updates 5 nexus test files to mock @cleocode/core/internal instead of nexus-engine.js.
No handler body changes — only import source changes.

Refs: T1569, T1566, ADR-057, ADR-058
```

**Verify**:
```bash
pnpm biome check --write .
pnpm run build
pnpm run test  # zero new failures — all nexus tests must still pass
git diff --stat HEAD  # verify nexus-engine.ts shows as deleted
```

---

## 6. File Plan Summary

| File | Action | Wave |
|------|--------|------|
| `packages/core/src/nexus/registry.ts` | Extend: add 12 EngineResult-returning wrappers | 1 |
| `packages/core/src/nexus/deps.ts` | Extend: add 5 EngineResult-returning wrappers | 1 |
| `packages/core/src/nexus/query.ts` | Extend: add nexusResolve, nexusTopEntries | 1 |
| `packages/core/src/nexus/impact.ts` | Extend: add nexusImpact (185 LOC SQL BFS) | 1 |
| `packages/core/src/nexus/discover.ts` | Extend: add nexusDiscover, nexusSearch | 2 |
| `packages/core/src/nexus/augment.ts` | Extend: add nexusAugment, nexusSearchCode | 2 |
| `packages/core/src/nexus/sharing/index.ts` | Extend: add nexusShareStatus | 2 |
| `packages/core/src/nexus/transfer.ts` | Extend: add 4 snapshot/transfer ops | 2 |
| `packages/core/src/nexus/living-brain.ts` | Extend: add 5 Living Brain primitives | 2 |
| `packages/core/src/nexus/route-analysis.ts` | Extend: add nexusRouteMap, nexusShapeCheck | 3 |
| `packages/core/src/nexus/wiki-index.ts` | Extend: add nexusWiki | 3 |
| `packages/core/src/nexus/query-dsl.ts` | Extend: add nexusQueryCte (with alias validation) | 3 |
| `packages/core/src/nexus/plasticity-queries.ts` | Extend: add nexusHotPaths, nexusHotNodes, nexusColdSymbols | 3 |
| `packages/core/src/nexus/clusters.ts` | Extend: add nexusClusters | 3 |
| `packages/core/src/nexus/flows.ts` | Extend: add nexusFlows | 3 |
| `packages/core/src/nexus/context.ts` | Extend: add nexusContext | 3 |
| `packages/core/src/nexus/projects-scan.ts` | Extend: add nexusProjectsScan | 3 |
| `packages/core/src/nexus/projects-clean.ts` | Extend: add nexusProjectsClean (with validation) | 3 |
| `packages/core/src/nexus/nexus-bridge.ts` | Extend: add nexusRefreshBridge | 3 |
| `packages/core/src/nexus/diff.ts` | Extend: add nexusDiff | 3 |
| `packages/core/src/nexus/api-contracts-engine.ts` | **NEW**: 5 contracts + ingestion functions | 3 |
| `packages/core/src/nexus/user-profile.ts` | Extend: add 7 profile CRUD wrappers | 4 |
| `packages/core/src/nexus/sigil.ts` | Extend: add nexusSigilList | 4 |
| `packages/core/src/nexus/sigil-sync.ts` | Extend: add nexusSigilSync | 4 |
| `packages/core/src/nexus/index.ts` | Extend: export all new symbols (each wave) | 1–4 |
| `packages/core/src/internal.ts` | Extend: export all new symbols (each wave) | 1–4 |
| `packages/cleo/src/dispatch/domains/nexus.ts` | Update import source | 5 |
| `packages/cleo/src/dispatch/domains/__tests__/nexus.test.ts` | Rewrite mock path | 5 |
| `packages/cleo/src/dispatch/domains/__tests__/nexus-phase2-dispatch.test.ts` | Rewrite mock path | 5 |
| `packages/cleo/src/dispatch/domains/__tests__/nexus-living-brain-dispatch.test.ts` | Rewrite mock path | 5 |
| `packages/cleo/src/dispatch/domains/__tests__/nexus-contracts-ingestion-dispatch.test.ts` | Rewrite mock path | 5 |
| `packages/cleo/src/dispatch/domains/__tests__/nexus-code-intel-dispatch.test.ts` | Rewrite mock path | 5 |
| `packages/cleo/src/dispatch/engines/nexus-engine.ts` | **DELETED** | 5 |

**Total**: 1 file deleted (2016 LOC), 1 file created (api-contracts-engine.ts ~250 LOC), 25 files extended.

---

## 7. Risk Register

### Risk 1 — `nexusCoreOps` type inference breaks (HIGH)

**Description**: `packages/core/src/nexus/ops.ts` declares `nexusCoreOps` as a `declare const` type
registry used by `OpsFromCore<typeof coreNexus.nexusCoreOps>` in the dispatch layer. If any new
symbol added to core has a signature mismatch with the declared ops, TypeScript will fail silently
(or with confusing errors in `typed.ts`).

**Mitigation**: DO NOT modify `ops.ts`. The new EngineResult-returning functions in core are consumed
by the domain handler via direct import — they do not need to be registered in `nexusCoreOps`. The
`nexusCoreOps` registry is purely for OpsFromCore inference over the existing typed-dispatch path.
Verify after Wave 5 that `pnpm run build` succeeds and the typed handler compiles without widening.

---

### Risk 2 — Lazy imports to static: circular dependency (MEDIUM)

**Description**: nexus-engine.ts uses `await import('@cleocode/core/nexus/...' as string)` to avoid
circular import analysis. Converting to static imports inside core/nexus/ could create real circular
imports if the target file also imports from the source file.

**Mitigation**: Before converting each lazy import, run `grep -n "from.*<source-file>" <target-file>`
to check for existing circular edges. In practice, the living-brain.ts → brain-reasoning.ts path is
memory→nexus cross-module which is fine. The api-extractors files are leaf modules. The most likely
risk is `query-dsl.ts` importing from `query.ts` or vice versa — check before committing Wave 3.

---

### Risk 3 — `nexusProjectsList/Register/Remove` lazy-import `@cleocode/core/internal` (MEDIUM)

**Description**: These three functions use `await import('@cleocode/core/internal' as string)` for
functions that are already defined in the same file (`registry.ts`). After migration into `registry.ts`,
converting to static local calls (`nexusList()`, `nexusRegister(repoPath, name)`, `nexusUnregister(nameOrHash)`)
changes the call signatures slightly — `nexusList()` in registry.ts takes `(filter, opts)` not `()`.

**Mitigation**: Inspect the actual call signatures in `registry.ts` before writing the wrapper. The
lazy-import versions cast to simplified signatures (`nexusList as () => Promise<unknown[]>`). The
migrated version must call the real signature. Verify that the simplified calling convention is
acceptable (empty filter = return all) by checking registry.ts line 1-50.

---

### Risk 4 — `nexusProfileUpsert` type mismatch on `UserProfileTrait` (LOW-MEDIUM)

**Description**: `nexusProfileUpsert` takes a `Pick<UserProfileTrait, 'traitKey' | 'traitValue' | 'confidence' | 'source' | 'derivedFromMessageId'>` and assembles the full `UserProfileTrait`. Moving this to `user-profile.ts` requires importing the `Pick<UserProfileTrait, ...>` type from `@cleocode/contracts`. The strict TypeScript mode might require explicit type annotation on the assembled `fullTrait`.

**Mitigation**: Import `UserProfileTrait` type from `@cleocode/contracts` in `user-profile.ts` (already done if the existing functions use it). Ensure `upsertUserProfileTrait(nexusDb, fullTrait)` accepts the full type. Run `pnpm biome check --write .` after Wave 4.

---

### Risk 5 — Test mock granularity: mocking `@cleocode/core/internal` stubs too many symbols (LOW)

**Description**: The 5 test files currently mock `'../../engines/nexus-engine.js'` which is a small,
focused module. After migration, they must mock `'@cleocode/core/internal'` which exports hundreds of
symbols. A naive `vi.mock('@cleocode/core/internal', () => ({ ... }))` will stub out ALL core/internal
exports including `getProjectRoot`, `getLogger`, `getBrainNativeDb`, etc., which are separately mocked
in `vi.mock('@cleocode/core/internal', ...)` in each test file.

**Mitigation**: In each test, `vi.mock('@cleocode/core/internal', () => ({ ... }))` should include both
the nexus function stubs AND the utility function stubs (getProjectRoot, getLogger, etc.) that were
previously in the separate `vi.mock('@cleocode/core/internal', ...)` block. Merge the two mock blocks
into one. Alternatively, use `vi.mock('@cleocode/core/internal', async (importOriginal) => ({ ...(await importOriginal()), nexusStatus: vi.fn(), ... }))` to preserve unrelated exports. The latter approach is
safer but adds test complexity. Choose the approach that matches the existing test style in the codebase.
