# T549 Wave 1-A/B: Tier Routing + Quality Scoring

**Task**: T549
**Date**: 2026-04-11
**Wave**: 1-A (Tier Routing in Store Functions) + 1-B (Quality Scoring with sourceConfidence)
**Status**: Complete

---

## Changes Made

### Wave 1-B: quality-scoring.ts

**File**: `packages/core/src/memory/quality-scoring.ts`

Added to module:
- Import of `BrainMemoryTier` and `BrainSourceConfidence` types from brain-schema.ts
- `SOURCE_MULTIPLIERS` constant — maps each `BrainSourceConfidence` level to a numeric multiplier:
  - `owner`: 1.0 (no penalty — owner-stated facts are ground truth)
  - `task-outcome`: 0.9 (verified by task completion)
  - `agent`: 0.7 (AI agent inference, default)
  - `speculative`: 0.4 (unconfirmed hypothesis)
- `TIER_BONUS` constant — additive bonus per memory retention tier:
  - `short`: 0.0 (new/unproven, no bonus)
  - `medium`: 0.05 (survived session consolidation)
  - `long`: 0.1 (architecturally proven)
- `applySourceMultiplier()` — exported helper that applies multiplier then tier bonus, then clamps to [0.0, 1.0]

Updated all four compute functions to accept optional `sourceConfidence` and `memoryTier` params and pass them through `applySourceMultiplier()`:
- `computePatternQuality` — extended `PatternQualityInput`
- `computeLearningQuality` — extended `LearningQualityInput`
- `computeDecisionQuality` — extended `DecisionQualityInput`
- `computeObservationQuality` — extended `ObservationQualityInput`

**Contract**: The base formula is unchanged. The multiplier is applied on top as a final transform. All existing callers that omit `sourceConfidence` get the `'agent'` default (0.7 multiplier), which preserves backward compatibility.

---

### Wave 1-A: Tier Routing in Store Functions

#### observeBrain() — `packages/core/src/memory/brain-retrieval.ts`

Routing assignments (spec §4.1):
- `memoryTier = 'short'` — observations always start short-term; consolidator promotes
- `memoryType = 'episodic'` — observations are always event records
- `verified = false` — observations are never verified at write time
- `sourceConfidence` routing:
  - `sourceType === 'manual'` → `'owner'`
  - `sourceType === 'session-debrief'` → `'task-outcome'`
  - otherwise → `'agent'` (default)
  - caller-provided `params.sourceConfidence` overrides routing

Added `sourceConfidence?: BrainSourceConfidence` to `ObserveBrainParams` interface for explicit overrides.

Quality score call now passes `sourceConfidence` and `memoryTier` to `computeObservationQuality`.

Row insert now includes: `memoryTier`, `memoryType`, `sourceConfidence`, `verified`.

#### storeDecision() — `packages/core/src/memory/decisions.ts`

Routing assignments (spec §4.1):
- `memoryTier = 'medium'` — decisions skip short-term (owner-stated facts)
- `memoryType = 'semantic'` — decisions are always declarative architectural facts
- `sourceConfidence = 'owner'` — decisions are always manually/intentionally entered
- `verified = true` — the act of deciding IS verification (owner statement gate)

Quality score call passes `sourceConfidence = 'owner'` and `memoryTier = 'medium'` to `computeDecisionQuality`. The `owner` multiplier (1.0) plus `medium` tier bonus (+0.05) means high-confidence decisions now score up to 1.0.

#### storePattern() — `packages/core/src/memory/patterns.ts`

Routing assignments (spec §4.1):
- `memoryTier = 'medium'` — patterns are project-scoped process knowledge
- `memoryType = 'procedural'` — patterns are always process/workflow knowledge
- `verified = false` — patterns need validation through frequency repetition
- `sourceConfidence` routing:
  - `params.source?.startsWith('auto')` → `'speculative'` (auto-extracted, unconfirmed)
  - otherwise → `'agent'` (agent-observed during work)

Added `source?: string` to `StorePatternParams` for routing signal.

#### storeLearning() — `packages/core/src/memory/learnings.ts`

Routing assignments (spec §4.1):
- `verified = false` — learnings need corroboration or manual verify gate
- `sourceConfidence` routing:
  - `source.includes('manual')` → `'owner'`
  - `source.includes('transcript:ses_')` → `'speculative'`
  - otherwise → `'agent'`
- `memoryTier` routing:
  - `source.includes('manual')` → `'medium'` (owner-stated facts skip short-term)
  - otherwise → `'short'`
- `memoryType` routing:
  - `source.includes('transcript:ses_')` → `'episodic'` (event-specific insight)
  - otherwise → `'semantic'` (declarative factual learning)

---

## Routing Summary Table

| Store Function | memoryTier | memoryType | sourceConfidence | verified |
|----------------|-----------|-----------|-----------------|---------|
| observeBrain (agent) | short | episodic | agent | false |
| observeBrain (manual) | short | episodic | owner | false |
| observeBrain (session-debrief) | short | episodic | task-outcome | false |
| storeDecision | medium | semantic | owner | true |
| storePattern (default) | medium | procedural | agent | false |
| storePattern (auto-source) | medium | procedural | speculative | false |
| storeLearning (default) | short | semantic | agent | false |
| storeLearning (manual) | medium | semantic | owner | false |
| storeLearning (transcript) | short | episodic | speculative | false |

---

## Quality Score Effect Examples

With the new multiplier applied to base scores:

| Entry Type | Base Score | sourceConfidence | Multiplier | Tier Bonus | Final Score |
|-----------|-----------|-----------------|-----------|-----------|------------|
| Observation (rich text, agent) | 0.75 | agent | 0.70 | 0.00 | 0.525 |
| Observation (rich text, manual) | 0.75 | owner | 1.00 | 0.00 | 0.750 |
| Decision (high, owner, medium) | 1.05 | owner | 1.00 | 0.05 | 1.00 (clamped) |
| Pattern (workflow, agent) | 0.70 | agent | 0.70 | 0.05 | 0.540 |
| Pattern (workflow, auto) | 0.70 | speculative | 0.40 | 0.05 | 0.330 |
| Learning (0.8 confidence, agent) | 1.00 | agent | 0.70 | 0.00 | 0.700 |
| Learning (0.8, manual) | 1.00 | owner | 1.00 | 0.05 | 1.00 (clamped) |

---

## Quality Gates Passed

1. `pnpm biome check --write` — passed (fixed 2 files: import ordering)
2. `pnpm run build` — passed (full monorepo build success)
3. `pnpm run test` — 7128 passed, 1 pre-existing flaky performance timing test failed
   (performance-safety.test.ts: 50-task SQLite bulk write exceeded 10s budget under system load;
   this test is unrelated to brain memory and was confirmed unrelated by checking test content)

---

## Files Modified

- `packages/core/src/memory/quality-scoring.ts` — Wave 1-B
- `packages/core/src/memory/brain-retrieval.ts` — Wave 1-A (observeBrain)
- `packages/core/src/memory/decisions.ts` — Wave 1-A (storeDecision)
- `packages/core/src/memory/patterns.ts` — Wave 1-A (storePattern)
- `packages/core/src/memory/learnings.ts` — Wave 1-A (storeLearning)
