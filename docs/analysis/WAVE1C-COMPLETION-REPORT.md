# Wave 1C Completion Report: Type Hardening

**Team Lead**: Wave 1C Agent
**Scope**: Type system hardening across sessions, hooks, memory, and skills modules
**Build Status**: PASS (pnpm run build succeeds with zero errors)

---

## Task 1: Fix Loose TaskFileExt Typing

**File**: `packages/core/src/sessions/types.ts`

### Changes Made

1. **Added contracts import**: `import type { FileMeta, Task, TaskStatus, TaskWorkState } from '@cleocode/contracts'`

2. **Tightened `TaskWorkStateExt`**: Now `extends TaskWorkState` from contracts, ensuring structural alignment with the canonical type while keeping the engine's required-null field guarantees.

3. **Extracted `TaskFileTaskEntry`**: Replaced the inline `Array<{ id: string; status: string; ... [key: string]: unknown }>` with a named interface. Uses `TaskStatus` from contracts instead of bare `string` for the `status` field. Adds typed optional fields (`title`, `description`, `priority`, `depends`, `labels`, `notes`) matching the contracts `Task` type while retaining an index signature for forward compatibility.

4. **Extracted `TaskFileMetaExt`**: Replaced the inline `_meta` object type with a named interface. Mirrors `FileMeta` from contracts with added JSDoc documentation for each field.

5. **Improved `TaskFileExt`**: Now uses the named sub-types (`TaskFileMetaExt`, `TaskFileTaskEntry`) instead of anonymous inline shapes. Added comprehensive JSDoc explaining the relationship to contracts `TaskFile`.

6. **Improved `toTaskFileExt()`**: Added JSDoc explaining the validation contract and type assertion behavior.

### Backward Compatibility

- All existing callers continue to work because the new named types are structurally compatible with the old anonymous types.
- The index signatures (`[key: string]: unknown`) are preserved for extensibility.
- Callers using `as unknown as TaskFileExt` casts (in handoff.ts and briefing.ts) are unaffected.

### Exports Updated

- `packages/core/src/sessions/index.ts`: Added `TaskFileMetaExt` and `TaskFileTaskEntry` to type exports.
- `packages/core/src/internal.ts`: Added flat exports for `TaskFileMetaExt` and `TaskFileTaskEntry`.

---

## Task 2: Add Zod Schemas for Hook Payloads

**File**: `packages/core/src/hooks/payload-schemas.ts` (new)

### Changes Made

1. **Created 14 Zod schemas** covering every hook payload type:
   - `HookPayloadSchema` (base)
   - `OnSessionStartPayloadSchema`, `OnSessionEndPayloadSchema`
   - `OnToolStartPayloadSchema`, `OnToolCompletePayloadSchema`
   - `OnFileChangePayloadSchema`, `OnErrorPayloadSchema`
   - `OnPromptSubmitPayloadSchema`, `OnResponseCompletePayloadSchema`
   - `OnWorkAvailablePayloadSchema`, `OnAgentSpawnPayloadSchema`
   - `OnAgentCompletePayloadSchema`, `OnCascadeStartPayloadSchema`
   - `OnPatrolPayloadSchema`

2. **Created `validatePayload()` function**: Takes a `HookEvent` and `unknown` payload, validates against the correct event-specific schema using a dispatch map. Falls back to base `HookPayloadSchema` for unrecognized events. Returns `{ valid, errors }` rather than throwing.

3. **Uses `zod/v4`**: Follows the project convention established in `store/validation-schemas.ts`.

4. **Schema strictness**: Required fields from the TypeScript interfaces are required in the Zod schemas. Optional fields use `.optional()`. Enum fields use `z.enum()` with the exact literal values from the interfaces.

### Exports Updated

- `packages/core/src/hooks/index.ts`: Exports all 14 schemas, `validatePayload`, and `PayloadValidationResult` type.
- `packages/core/src/internal.ts`: Added flat exports for `validatePayload` and `PayloadValidationResult`.

---

## Task 3: Complete BrainRowTypes Coverage

**File**: `packages/core/src/memory/brain-row-types.ts`

### Audit Results

Searched all files in `packages/core/src/memory/` for raw SQL queries (`db.run`, `db.all`, `db.get`, `.prepare`, etc.). Found these untyped query results:

| File | Query | Previous Typing | Fix |
|------|-------|----------------|-----|
| `brain-lifecycle.ts` | Old observations for consolidation | Inline `Array<{...}>` cast | `BrainConsolidationObservationRow` |
| `brain-retrieval.ts` | Timeline UNION ALL neighbors | `as unknown as TimelineNeighbor[]` | `BrainTimelineNeighborRow` |
| `claude-mem-migration.ts` | ID existence checks (3 sites) | `as Record<string, unknown> \| undefined` | `BrainIdCheckRow` |

### New Types Added

1. **`BrainTimelineNeighborRow`**: `{ id: string; type: string; date: string }` -- Used by the timeline UNION ALL queries in brain-retrieval.ts.

2. **`BrainConsolidationObservationRow`**: `{ id, type, title, narrative, project, created_at }` -- Used by the consolidation old-observation query in brain-lifecycle.ts.

3. **`BrainIdCheckRow`**: `{ id: string }` -- Used by single-column ID existence checks in claude-mem-migration.ts.

### Call Sites Updated

- `brain-retrieval.ts`: Changed two `as unknown as TimelineNeighbor[]` casts to `as unknown as BrainTimelineNeighborRow[]`.
- `brain-lifecycle.ts`: Replaced inline `Array<{...}>` cast with `as unknown as BrainConsolidationObservationRow[]`.
- `claude-mem-migration.ts`: Replaced three `as Record<string, unknown> | undefined` casts with `as BrainIdCheckRow | undefined`.

### Already-Typed Queries (No Action Needed)

- `brain-search.ts`: Uses `BrainDecisionRow`, `BrainPatternRow`, `BrainLearningRow`, `BrainObservationRow` from brain-schema.ts.
- `brain-similarity.ts`: Uses `BrainKnnRow` from brain-row-types.ts.
- `brain-retrieval.ts` (observeBrain): Uses `BrainFtsRow` from brain-row-types.ts.
- `brain-retrieval.ts` (populateEmbeddings): Uses `BrainNarrativeRow` from brain-row-types.ts.
- `decisions.ts`, `learnings.ts`, `patterns.ts`: Use Drizzle ORM accessor methods (fully typed).
- `pipeline-manifest-sqlite.ts`: Uses Drizzle ORM query builder (fully typed).

### Exports Updated

- `packages/core/src/internal.ts`: Added flat type exports for all 9 brain row types.

---

## Task 4: Consolidate Dual Skill Type Representations

**Files**: `packages/core/src/skills/types.ts`, `packages/core/src/skills/precedence-types.ts`

### Analysis

The dual representation exists by design:

- **CAAMP layer** (`CaampSkillMetadata`, `CtSkillEntry`): Cross-agent standard types for skill discovery, installation, and provider management. Minimal fields (name, description, version, license, compatibility, metadata, allowedTools).

- **CLEO layer** (`SkillFrontmatter`, `Skill`, `SkillSummary`, `SkillManifest`): Extended domain model adding CLEO-specific fields (tags, triggers, dispatchPriority, model, invocable, command, protocol).

`SkillFrontmatter` is a functional superset of `CaampSkillMetadata` -- every CAAMP field maps directly to a SkillFrontmatter field. Making `SkillFrontmatter extends CaampSkillMetadata` was considered but rejected because:
1. CAAMP uses `metadata?: Record<string, string>` while CLEO doesn't need that field.
2. The types serve different API boundaries and forcing inheritance would couple them unnecessarily.

### Changes Made (Documentation Approach)

1. **Module-level JSDoc on `types.ts`**: Added comprehensive documentation explaining the dual type system, when to use which type, and the exact field mapping between CAAMP and CLEO types.

2. **Per-field JSDoc on `SkillFrontmatter`**: Each field now documents whether it maps to a `CaampSkillMetadata` field or is a CLEO extension.

3. **JSDoc on `Skill`**: Clarifies its relationship to `CtSkillEntry`.

4. **JSDoc on `SkillSummary`**: Documents its role as a projection of `Skill`.

5. **JSDoc on `precedence-types.ts`**: Added module doc explaining how precedence types complement the skill domain model.

6. **JSDoc on all precedence interfaces**: Added per-field documentation.

---

## Task 5: Verify Export Chain Completeness

### Public Barrel (`packages/core/src/index.ts`)

New types flow through namespace re-exports:
- `export * as sessions` -> `TaskFileMetaExt`, `TaskFileTaskEntry`
- `export * as coreHooks` -> `validatePayload`, `PayloadValidationResult`, all 14 payload schemas
- `export * as memory` -> brain row types (via memory/index.ts -> brain-row-types.ts)

### Internal Barrel (`packages/core/src/internal.ts`)

Added explicit flat exports for:
- `TaskFileMetaExt`, `TaskFileTaskEntry` from sessions/types.ts
- `validatePayload`, `PayloadValidationResult` from hooks/payload-schemas.ts
- All 9 brain row types from memory/brain-row-types.ts

### Verification

Build (`pnpm run build`) completes successfully with zero TypeScript errors, confirming all new types resolve correctly through the export chains.

---

## Files Modified

| File | Change Type |
|------|------------|
| `packages/core/src/sessions/types.ts` | Tightened types, added contracts imports |
| `packages/core/src/sessions/index.ts` | Added new type exports |
| `packages/core/src/hooks/payload-schemas.ts` | **New file** -- Zod schemas + validator |
| `packages/core/src/hooks/index.ts` | Added payload schema exports |
| `packages/core/src/memory/brain-row-types.ts` | Added 3 new row types |
| `packages/core/src/memory/brain-lifecycle.ts` | Used new row type |
| `packages/core/src/memory/brain-retrieval.ts` | Used new row type |
| `packages/core/src/memory/claude-mem-migration.ts` | Used new row type |
| `packages/core/src/skills/types.ts` | Added comprehensive JSDoc |
| `packages/core/src/skills/precedence-types.ts` | Added comprehensive JSDoc |
| `packages/core/src/internal.ts` | Added flat exports for all new types |
