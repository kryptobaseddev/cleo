# T550: Wave 0 Schema Foundation — Summary

**Task**: T550
**Epic**: T549 — Memory Architecture v2
**Date**: 2026-04-13
**Status**: Complete

---

## What Was Done

### 1. Migration Created

`packages/core/migrations/drizzle-brain/20260413000001_t549-tiered-typed-memory/migration.sql`

Adds 7 new columns to all 4 typed brain tables via `ALTER TABLE ADD COLUMN` (additive-only):

| Column | Type | Default | Tables |
|--------|------|---------|--------|
| `memory_tier` | TEXT | `'short'` | all 4 |
| `memory_type` | TEXT | per-table | all 4 |
| `verified` | INTEGER (bool) | `0` (false) | all 4 |
| `valid_at` | TEXT | `datetime('now')` | all 4 |
| `invalid_at` | TEXT | NULL | all 4 |
| `source_confidence` | TEXT | `'agent'` | all 4 |
| `citation_count` | INTEGER | `0` | all 4 |

Per-table `memory_type` defaults:
- `brain_decisions` → `'semantic'`
- `brain_patterns` → `'procedural'`
- `brain_learnings` → `'semantic'`
- `brain_observations` → `'episodic'`

Indexes added for all new columns on each table (5 indexes per table = 20 total).

Backfill SQL updates legacy rows using deterministic rules:
- decisions: `confidence = 'high'` → `long`, otherwise `medium`
- patterns: `frequency >= 5` → `long`, `>= 2` → `medium`, else `medium`
- learnings: `confidence >= 0.80` → `long`, `>= 0.60` → `medium`, else `medium`
- observations: all → `medium` (with `source_confidence` from `source_type` mapping)

### 2. brain-schema.ts Updated

`packages/core/src/store/brain-schema.ts`

Added 3 new exported constants and type aliases:

```typescript
export const BRAIN_MEMORY_TIERS = ['short', 'medium', 'long'] as const;
export type BrainMemoryTier = (typeof BRAIN_MEMORY_TIERS)[number];

export const BRAIN_COGNITIVE_TYPES = ['semantic', 'episodic', 'procedural'] as const;
export type BrainCognitiveType = (typeof BRAIN_COGNITIVE_TYPES)[number];

export const BRAIN_SOURCE_CONFIDENCE = ['owner', 'task-outcome', 'agent', 'speculative'] as const;
export type BrainSourceConfidence = (typeof BRAIN_SOURCE_CONFIDENCE)[number];
```

Added 7 new columns (with TSDoc) to all 4 typed tables:
- `brainDecisions`, `brainPatterns`, `brainLearnings`, `brainObservations`

Added 5 new indexes per table to their index arrays.

### 3. contracts/src/config.ts Updated

`packages/contracts/src/config.ts`

Added new `BrainTieringConfig` interface:

```typescript
export interface BrainTieringConfig {
  enabled: boolean;           // default: false
  autoPromote: boolean;       // default: false
  shortTermTtlHours: number;  // default: 48
  mediumTermTtlDays: number;  // default: 30
  promotionThreshold: number; // default: 5 (citations for medium→long)
}
```

Extended `BrainConfig` with optional `tiering?: BrainTieringConfig` field.

### 4. contracts/src/brain.ts Updated

`packages/contracts/src/brain.ts`

Added 3 new exported types:

```typescript
export type BrainMemoryTier = 'short' | 'medium' | 'long';
export type BrainCognitiveType = 'semantic' | 'episodic' | 'procedural';
export type BrainSourceConfidence = 'owner' | 'task-outcome' | 'agent' | 'speculative';
```

### 5. contracts/src/index.ts Updated

`packages/contracts/src/index.ts`

Exported `BrainMemoryTier`, `BrainCognitiveType`, `BrainSourceConfidence` from `./brain.js`.
Exported `BrainTieringConfig` from `./config.js`.

---

## Conflict Resolutions Applied

| Conflict | Resolution |
|----------|-----------|
| CONFLICT-01 | Used `BRAIN_COGNITIVE_TYPES` (not `BRAIN_MEMORY_TYPES`) to avoid link table enum collision |
| CONFLICT-03 | Added `citation_count INTEGER NOT NULL DEFAULT 0` to all 4 tables per cross-validation report |
| CA1 §3.1.5 | `source_confidence` enum: `['owner', 'task-outcome', 'agent', 'speculative']` (spec is authoritative over task summary) |

---

## Quality Gates

- `pnpm biome check --write`: PASS (1 file auto-fixed, 0 warnings)
- `pnpm run build`: PASS
- `pnpm run test`: PASS — 396 files, 7129 tests, 0 new failures, 10 skipped (pre-existing)

---

## Files Modified

| File | Change |
|------|--------|
| `packages/core/migrations/drizzle-brain/20260413000001_t549-tiered-typed-memory/migration.sql` | NEW — full migration SQL with backfill |
| `packages/core/src/store/brain-schema.ts` | Added 3 constants, 7 columns × 4 tables, 5 indexes × 4 tables |
| `packages/contracts/src/config.ts` | Added `BrainTieringConfig`, extended `BrainConfig` |
| `packages/contracts/src/brain.ts` | Added `BrainMemoryTier`, `BrainCognitiveType`, `BrainSourceConfidence` |
| `packages/contracts/src/index.ts` | Exported 4 new types |

---

## Wave Dependencies Unblocked

Wave 0 complete. All downstream waves (1–7) may now proceed:
- Wave 1: Storage + Quality Layer (depends on brain-schema.ts + contracts)
- Wave 2: Extraction Gate + Bridge Mode (depends on Wave 1)
- All subsequent waves depend on this schema foundation
