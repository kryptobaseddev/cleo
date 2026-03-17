# Adapter Manager Agent Output

**Task**: #2 -- Phase 2: AdapterManager + provider discovery + session tracking
**Agent**: contracts-agent

## Completed Work

### 1. AdapterManager (src/core/adapters/manager.ts)
Singleton class with full lifecycle:
- `discover()` -- scan packages/adapters/ for manifests
- `detectActive()` -- match detection patterns against environment
- `activate(id)` -- dynamic import + initialize adapter
- `getActive()` / `getActiveId()` -- current active adapter
- `listAdapters()` -- summary info for all known adapters
- `healthCheck()` / `healthCheckAll()` -- adapter health
- `dispose()` / `disposeAdapter()` -- cleanup
- `resetInstance()` -- for testing

### 2. Discovery (src/core/adapters/discovery.ts)
- `discoverAdapterManifests(projectRoot)` -- scan packages/adapters/*/manifest.json
- `detectProvider(patterns)` -- match DetectionPattern[] (env, file, process, cli)

### 3. Schema Migration
- Added `providerId` (nullable text) to sessions table in tasks-schema.ts
- Added `providerId` to session Zod schema in validation-schemas.ts
- Drizzle migration generated: `migrations/drizzle-tasks/20260316024050_silly_gamma_corps/`

### 4. Session Integration
- `StartSessionOptions` now accepts `providerId?: string`
- `startSession()` records `providerId` on new sessions

### 5. Tools Domain -- adapter.* Sub-domain (6 new operations)
Query:
- `adapter.list` -- list all discovered adapters
- `adapter.show` -- show adapter details by ID
- `adapter.detect` -- detect active providers in environment
- `adapter.health` -- health status for adapters

Mutate:
- `adapter.activate` -- load and activate an adapter
- `adapter.dispose` -- dispose one or all adapters

### 6. Registry Updates
- 6 new operations added to OPERATIONS array in registry.ts
- Operation counts updated: 201 -> 207 (118 query, 89 mutate)

### 7. Init Integration
- `src/core/init.ts`: Added adapter discovery step after NEXUS registration
- Discovers adapters and detects active provider during project init

### 8. Documentation Updates
- AGENTS.md: operation counts 201->207, 114->118 query, 87->89 mutate
- CLEO-VISION.md: operation counts updated
- CLEO-OPERATION-CONSTITUTION.md: tools domain and total counts updated, adapter ops added

### 9. Test Count Updates
- `parity-gate.test.ts`: 114->118 query, 87->89 mutate, 201->207 total, tools 22->28
- `operation-count-doc-sync.test.ts`: stale drift patterns updated for old counts
- `discovery.ts`: Fixed `require('node:child_process')` to ESM-compatible static import

### 10. Unit Tests (28 tests)
- `src/core/adapters/__tests__/manager.test.ts` -- 28 tests covering:
  - discoverAdapterManifests: 5 tests (empty dir, valid manifest, multiple, skip bad)
  - detectProvider: 6 tests (env, file, multi-pattern, empty)
  - AdapterManager: 17 tests (singleton, discovery, detection, health, lifecycle)

## Verification
- `npx tsc --noEmit` passes (zero errors)
- `npm run build` succeeds
- 4681 tests pass, 7 skipped, 1 pre-existing failure (research-workflow.test.ts)
- Zero TODO comments in new code
