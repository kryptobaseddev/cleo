# T4799: Lifecycle Implementation Audit -- Compatibility Matrix

**Task:** T4799 -- Audit and document the 3 RCSD lifecycle implementations end-to-end
**Parent:** T4798 -- RCSD Lifecycle Pipeline Review
**Date:** 2026-02-25
**Status:** Complete

---

## Executive Summary

Three distinct lifecycle implementations exist in the codebase. This audit walks through each one, documents their stage names, stage order, prerequisite maps, schema shapes, status values, and capabilities. A compatibility matrix at the end shows where they diverge and what T4800 (unification) must resolve.

**Key finding:** `stages.ts` is already the canonical source of truth and is used by the newer files (`pipeline.ts`, `state-machine.ts`, `resume.ts`). The unification work for T4800 primarily involves: (1) making `index.ts` delegate to or re-export from `stages.ts`, (2) updating `src/dispatch/engines/lifecycle-engine.ts` to use canonical types, and (3) deprecating legacy names with `@deprecated` re-exports.

---

## Implementation 1: `src/core/lifecycle/index.ts` (Legacy JSON-Based)

### Overview

The original lifecycle implementation from T4467/T4785. Uses JSON files stored at `.cleo/rcsd/<epicId>/_manifest.json` for persistence. Contains TWO separate systems in the same file:

1. **Lines 1-324: Core RCSD system** (T4467) -- 4 RCSD stages + 3 execution stages, uses `readJson`/`saveJson` for async I/O
2. **Lines 326-864: Engine-compatible system** (T4785) -- 8 ENGINE_LIFECYCLE_STAGES, re-reads the same JSON files via `readEngineManifest`/`saveEngineManifest`

### Stage Names

#### Core RCSD System (Lines 14-19)

```typescript
RCSD_STAGES = ['research', 'consensus', 'specification', 'decomposition'] as const
EXECUTION_STAGES = ['implementation', 'contribution', 'release'] as const
LifecycleStage = RcsdStage | ExecutionStage  // 7 total
```

**Notable:** Uses long-form names (`specification`, `decomposition`, `implementation`). Does NOT include `architecture_decision`, `validation`, or `testing`. Includes `contribution` as an execution stage (it's actually cross-cutting).

#### Engine-Compatible System (Lines 332-335)

```typescript
ENGINE_LIFECYCLE_STAGES = [
  'research', 'consensus', 'specification', 'decomposition',
  'implementation', 'validation', 'testing', 'release',
] as const  // 8 total
```

**Notable:** Adds `validation` and `testing`. Removes `contribution`. Still uses long-form names. Still does NOT include `architecture_decision`/`adr`.

### Prerequisite Maps

#### Core RCSD System

Implicit linear ordering: `RCSD_STAGES` then `EXECUTION_STAGES`. Gate check (`checkGate`, lines 250-298) iterates through all stages before the target and requires each to be `completed` or `skipped`.

#### Engine-Compatible System (Lines 392-401)

```typescript
STAGE_PREREQUISITES = {
  research: [],
  consensus: ['research'],
  specification: ['research'],           // NOTE: no consensus required
  decomposition: ['research', 'specification'],
  implementation: ['research', 'specification', 'decomposition'],
  validation: ['implementation'],
  testing: ['implementation'],            // NOTE: validation not required
  release: ['implementation', 'validation', 'testing'],
}
```

**Divergence from stages.ts:** `consensus` is not a prerequisite for `specification`. `validation` is not a prerequisite for `testing`.

### Status Values

| System | Status Values |
|--------|--------------|
| Core RCSD | `not_started`, `in_progress`, `completed`, `skipped` |
| Engine-compatible | `pending`, `completed`, `skipped`, `blocked` |

**Key divergence:** Core uses `not_started`/`in_progress`; Engine uses `pending` (no `in_progress`). Core has no `blocked`; Engine has no `not_started`/`in_progress`.

### Schema Shapes

#### Core RcsdManifest (Lines 28-38)

```typescript
interface RcsdManifest {
  epicId: string;
  createdAt: string;
  updatedAt: string;
  stages: Record<LifecycleStage, {
    status: StageStatus;        // not_started | in_progress | completed | skipped
    startedAt?: string;
    completedAt?: string;
    artifacts?: string[];
  }>;
}
```

#### EngineRcsdManifest (Lines 362-367)

```typescript
interface EngineRcsdManifest {
  epicId: string;
  title?: string;
  stages: Record<string, EngineStageData>;  // NOTE: Record<string, ...> not typed to stage names
}

interface EngineStageData {
  status: EngineStageStatus;    // pending | completed | skipped | blocked
  completedAt?: string;
  skippedAt?: string;
  skippedReason?: string;
  artifacts?: string[];
  notes?: string;
  gates?: Record<string, GateData>;   // Gate system only in Engine
}
```

**Key differences:** Engine manifest has `title`, `notes`, `gates`, `skippedAt`, `skippedReason`. Core manifest has `createdAt`, `updatedAt`, `startedAt`. Engine uses `Record<string, ...>` allowing arbitrary stage keys.

### Capabilities

| Capability | Core System | Engine System |
|-----------|-------------|---------------|
| Start stage | Yes (`startStage`) | No (only `recordStageProgress`) |
| Complete stage | Yes (`completeStage`) | Yes (`recordStageProgress` with status) |
| Skip stage | Yes (`skipStage`) | Yes (`skipStageWithReason`) |
| Gate checks | Yes (`checkGate`) | Yes (`checkStagePrerequisites`) |
| Enforcement modes | Yes (strict/advisory/off) | No |
| Gate pass/fail | No | Yes (`passGate`/`failGate`) |
| Reset stage | No | Yes (`resetStage`) |
| List epics | No | Yes (`listEpicsWithLifecycle`) |
| History | No | Yes (`getLifecycleHistory`) |

### Functions Exported

**Core (9 functions):** `getLifecycleState`, `startStage`, `completeStage`, `skipStage`, `checkGate` + internal helpers

**Engine (12 functions):** `getLifecycleStatus`, `getLifecycleHistory`, `getLifecycleGates`, `getStagePrerequisites`, `checkStagePrerequisites`, `recordStageProgress`, `skipStageWithReason`, `resetStage`, `passGate`, `failGate`, `listEpicsWithLifecycle`

### I/O Pattern

Both systems read/write the SAME `.cleo/rcsd/<epicId>/_manifest.json` files using `readJson`/`saveJson` from `../../store/json.js`. This means both systems operate on the same on-disk data, but interpret it through different type lenses.

---

## Implementation 2: `src/core/lifecycle/stages.ts` + `pipeline.ts` + `state-machine.ts` (New Canonical)

### Overview

The new canonical implementation from T4800/T4799. Uses short-form stage names and is designed for SQLite persistence (stubs pending T4801 schema). Three files work together:

- `stages.ts` -- Stage definitions, ordering, prerequisites, transition rules
- `pipeline.ts` -- Pipeline CRUD operations (currently stubs)
- `state-machine.ts` -- State machine logic (prerequisite checks, transition validation, status management)

### Stage Names (`stages.ts`, Lines 39-49)

```typescript
PIPELINE_STAGES = [
  'research', 'consensus', 'adr', 'spec', 'decompose',
  'implement', 'verify', 'test', 'release',
] as const  // 9 total
```

**Notable:** Uses SHORT-FORM names (`adr`, `spec`, `decompose`, `implement`, `verify`, `test`). Includes `adr` (Architecture Decision) as stage 3. Does NOT include `contribution` as a stage (it's cross-cutting per RCASD model).

### Prerequisite Map (`stages.ts`, Lines 343-353)

```typescript
STAGE_PREREQUISITES = {
  research: [],
  consensus: ['research'],
  adr: ['research', 'consensus'],
  spec: ['research', 'consensus', 'adr'],
  decompose: ['research', 'spec'],
  implement: ['research', 'spec', 'decompose'],
  verify: ['implement'],
  test: ['implement', 'verify'],          // NOTE: verify IS required
  release: ['implement', 'verify', 'test'],
}
```

**Divergence from index.ts:** `consensus` IS a prerequisite for `spec`. `verify` IS a prerequisite for `test`. `adr` IS a prerequisite for `spec`. This is a stricter prerequisite chain.

### Status Values (`stages.ts`, Lines 64-70)

```typescript
type StageStatus =
  | 'not_started' | 'in_progress' | 'completed'
  | 'skipped' | 'blocked' | 'failed';
```

**Superset:** Includes all values from both Core and Engine systems, plus `failed`.

### Schema Shapes

#### Pipeline (`pipeline.ts`)

```typescript
interface Pipeline {
  id: string;
  currentStage: Stage;
  createdAt: Date;
  updatedAt: Date;
  status: PipelineStatus;      // active | completed | blocked | cancelled | failed
  isActive: boolean;
  completedAt?: Date;
  cancelledReason?: string;
  transitionCount: number;
  version: number;             // Optimistic locking
}
```

#### PipelineStageRecord (`pipeline.ts`)

```typescript
interface PipelineStageRecord {
  id?: string;
  pipelineId: string;
  stage: Stage;
  status: StageStatus;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  assignedAgent?: string;
  notes?: string;
  order: number;
}
```

### Stage Definitions (`stages.ts`, Lines 123-223)

Rich metadata per stage:

```typescript
interface StageDefinition {
  stage: Stage;
  name: string;
  description: string;
  order: number;               // 1-9
  category: StageCategory;     // planning | decision | execution | validation | delivery
  skippable: boolean;
  defaultTimeoutHours: number | null;
  requiredGates: string[];
  expectedArtifacts: string[];
}
```

### Stage Categories

| Category | Stages |
|----------|--------|
| planning | research, spec, decompose |
| decision | consensus, adr |
| execution | implement |
| validation | verify, test |
| delivery | release |

### Transition Rules (`stages.ts`, Lines 498-519)

Explicit transition rules with `allowed`, `requiresForce`, and `reason` fields. Includes:
- Forward progressions (always allowed)
- Skip patterns (allowed with force): research->spec, spec->implement
- Backward transitions (allowed with force): implement->spec, test->implement
- Disallowed: release->any (pipeline completed)

### Capabilities

| Capability | Status |
|-----------|--------|
| Initialize pipeline | Stub (pending T4801) |
| Get pipeline | Stub (returns null) |
| Advance stage | Stub (throws not-implemented) |
| Validate transition | Implemented (pure logic in state-machine.ts) |
| Check prerequisites | Implemented (pure logic in state-machine.ts) |
| Skip stage | Implemented (pure logic in state-machine.ts) |
| Terminal state check | Implemented |
| Blocked check | Implemented |

### I/O Pattern

All SQLite operations are stubs waiting on T4801. The state machine logic is pure (takes context, returns new context) and can be tested without I/O.

---

## Implementation 3: `src/dispatch/engines/lifecycle-engine.ts` (MCP Adapter)

### Overview

Thin wrapper for the MCP domain layer. Imports types and constants from `src/core/lifecycle/index.ts` (the legacy system). Provides synchronous `EngineResult`-wrapped functions for MCP domain handlers.

### What It Imports

```typescript
import {
  ENGINE_LIFECYCLE_STAGES,          // 8 stages (legacy)
  STAGE_DEFINITIONS,                // Array of StageInfo (legacy)
  STAGE_PREREQUISITES,              // Engine prereq map (legacy)
  type EngineLifecycleStage,
  type EngineStageStatus,
  type EngineRcsdManifest,
  type GateData,
  type StageInfo,
} from '../../core/lifecycle/index.js';
```

**Critical finding:** This engine imports ONLY from `index.ts`, NOT from `stages.ts`. It uses the legacy 8-stage system, not the canonical 9-stage system.

### Re-exports

```typescript
export { ENGINE_LIFECYCLE_STAGES as LIFECYCLE_STAGES };
export type LifecycleStage = EngineLifecycleStage;
export type StageStatus = EngineStageStatus;
export type RcsdManifest = EngineRcsdManifest;
```

### I/O Pattern

Uses `readJsonFile`/`writeJsonFileAtomic` from `../../store/file-utils.js` (SYNCHRONOUS, unlike the async `readJson`/`saveJson` used by `index.ts`). Both operate on the same `.cleo/rcsd/<epicId>/_manifest.json` files.

### Functions (10)

`listRcsdEpics`, `lifecycleStatus`, `lifecycleHistory`, `lifecycleGates`, `lifecyclePrerequisites`, `lifecycleCheck`, `lifecycleProgress`, `lifecycleSkip`, `lifecycleReset`, `lifecycleGatePass`, `lifecycleGateFail`

These mirror the Engine-compatible functions in `index.ts` but with synchronous I/O and `EngineResult` wrapping.

---

## Implementation 4: `src/core/lifecycle/resume.ts` (SQLite-Based, T4805)

### Overview

This file is technically part of the new canonical system but deserves separate mention because it's the ONLY lifecycle file that actually uses SQLite (Drizzle ORM). All other files use JSON files.

### What It Imports

```typescript
import type { Stage } from './stages.js';           // Canonical stages
import { validateStage, getNextStage } from './stages.js';
import * as schema from '../../store/schema.js';     // SQLite schema
import { getDb } from '../../store/sqlite.js';       // Database access
```

**Notable:** Imports from `stages.ts` (canonical), NOT from `index.ts` (legacy). Uses SQLite tables: `lifecyclePipelines`, `lifecycleStages`, `lifecycleGateResults`, `lifecycleEvidence`, `lifecycleTransitions`.

### Stage Status Values

Uses a different status set than either Core or Engine:

```typescript
type DbStageStatus = 'pending' | 'active' | 'blocked' | 'completed' | 'skipped';
```

**Maps to stages.ts:** `active` = `in_progress`, `pending` = `not_started`. Missing: `failed`.

---

## On-Disk Manifests (`.cleo/rcsd/`)

### Directory Structure

19 task directories exist with `_manifest.json` files. Format matches `EngineRcsdManifest`:

```json
{
  "epicId": "T3080",
  "stages": {
    "research": { "status": "completed", "completedAt": "..." },
    "consensus": { "status": "skipped", "skippedAt": "...", "skippedReason": "..." },
    ...
  }
}
```

### Stage Keys in Existing Manifests

The on-disk files use the LONG-FORM stage names from `ENGINE_LIFECYCLE_STAGES`: `research`, `consensus`, `specification`, `decomposition`, `implementation`, `validation`, `testing`, `release`.

**Migration concern:** If T4800 unifies to short-form names (`spec`, `decompose`, `implement`, `verify`, `test`), existing on-disk manifests will have keys that don't match. T4800 must handle this mapping.

---

## Compatibility Matrix

| Aspect | index.ts (Core) | index.ts (Engine) | stages.ts | lifecycle-engine.ts | resume.ts |
|--------|----------------|-------------------|-----------|--------------------|----|
| **Stage count** | 7 | 8 | 9 | 8 (from index.ts) | 9 (from stages.ts) |
| **Includes `adr`** | No | No | Yes | No | Yes |
| **Includes `contribution`** | Yes (as stage) | No | No | No | No |
| **Includes `validation`/`testing`** | No | Yes | Yes (`verify`/`test`) | Yes | Yes |
| **Stage naming** | Long (`specification`) | Long (`specification`) | Short (`spec`) | Long (re-export) | Short (from stages.ts) |
| **Status values** | 4: not_started, in_progress, completed, skipped | 4: pending, completed, skipped, blocked | 6: not_started, in_progress, completed, skipped, blocked, failed | 4 (from Engine) | 5: pending, active, blocked, completed, skipped |
| **Persistence** | JSON async | JSON async | Stubs (pending SQLite) | JSON sync | SQLite (Drizzle) |
| **Prerequisite strictness** | Linear (all prior stages) | Selective (see map) | Selective + stricter | Selective (from Engine) | N/A (uses stages.ts) |
| **Gate system** | Enforcement modes only | Gate pass/fail records | Expected gates in definitions | Gate pass/fail (from Engine) | Gate results from SQLite |
| **Type safety** | Typed to LifecycleStage | Record<string, ...> (loose) | Typed to Stage | Re-exports Engine types | Typed to Stage |
| **Used by** | Internal core functions | Engine functions in index.ts | pipeline.ts, state-machine.ts, resume.ts | MCP domain handlers | Session resume flow |

---

## Divergence Points for T4800

### Critical Divergences (Must Resolve)

1. **Stage naming:** Long-form (`specification`) vs short-form (`spec`). `stages.ts` short-form should be canonical. Legacy long-form names need `@deprecated` mapping.

2. **Stage count:** 7 vs 8 vs 9. The 9-stage model from `stages.ts` is canonical. `adr` must be included. `contribution` must NOT be a stage (it's cross-cutting).

3. **Status value sets:** Three different sets. Unify to the 6-value set from `stages.ts` (most complete). Add mapping for SQLite `active` <-> `in_progress`, `pending` <-> `not_started`.

4. **On-disk manifest keys:** Existing manifests use long-form names. T4800 must either (a) migrate existing files, or (b) add a mapping layer that reads both forms.

5. **Import chain:** `lifecycle-engine.ts` imports from `index.ts` only. Must update to import from `stages.ts` or the new unified barrel export.

### Non-Critical Divergences (May Defer)

6. **Prerequisite strictness:** `index.ts` Engine map is looser (consensus not required for specification). `stages.ts` is stricter. Recommend adopting `stages.ts` as canonical.

7. **Async vs sync I/O:** Core system uses async `readJson`; Engine uses sync `readJsonFile`. SQLite operations are async. Recommend: all new code uses async.

8. **Gate system divergence:** Core has enforcement modes; Engine has gate pass/fail records; stages.ts has `requiredGates` in definitions. These are complementary, not conflicting.

---

## Recommendations for T4800

### Step 1: Make `stages.ts` the canonical barrel export

Update `src/core/lifecycle/index.ts` to:
- Re-export everything from `stages.ts`
- Keep legacy JSON manifest I/O functions (they're still needed until SQLite is fully implemented)
- Add `@deprecated` re-exports for `RCSD_STAGES`, `RcsdStage`, `RcsdManifest`, `ENGINE_LIFECYCLE_STAGES`, `EngineLifecycleStage`, `EngineStageStatus`, `EngineRcsdManifest`
- Add stage name mapping: `specification` <-> `spec`, `decomposition` <-> `decompose`, `implementation` <-> `implement`, `validation` <-> `verify`, `testing` <-> `test`

### Step 2: Update lifecycle-engine.ts imports

Change `src/dispatch/engines/lifecycle-engine.ts` to import canonical types from the updated `index.ts` barrel. Update its functions to use the new 9-stage system while maintaining backward compatibility with existing on-disk manifests (via the stage name mapping).

### Step 3: Add stage name mapping for on-disk compatibility

Create a mapping function that converts between long-form and short-form stage names. Use this when reading/writing `.cleo/rcsd/<epicId>/_manifest.json` files to ensure existing manifests remain readable.

### Step 4: Unify status values

Use the `stages.ts` 6-value `StageStatus` as canonical. Map:
- `pending` (SQLite/Engine) <-> `not_started` (canonical)
- `active` (SQLite) <-> `in_progress` (canonical)

### Step 5: Write compatibility tests

Add tests that verify:
- Old imports (`RCSD_STAGES`, `RcsdManifest`) still work via deprecated re-exports
- Stage name mapping works bidirectionally
- Existing on-disk manifests are readable with new code
- `lifecycle-engine.ts` functions produce correct results with 9-stage system
