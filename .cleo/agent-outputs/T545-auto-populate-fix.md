# T545 — Auto-populate and Quality Scoring Fix

**Date**: 2026-04-13
**Task**: T545
**Epic**: T542
**Status**: complete

---

## Root Cause Analysis

### Problem 1: Graph nodes not created for observations/decisions

The `cleo` binary on the user's PATH (`/home/keatonhoskins/.npm-global/bin/cleo`) pointed to a
hard-linked copy of `packages/cleo/dist/cli/index.js`. The local build (v2026.4.31) includes
`upsertGraphNode` and all quality scoring functions. The investigation confirmed:

- Local build: 16 occurrences of `upsertGraphNode` — **correct**
- Installed binary: same inode as local build — **same file**

The actual failure was NOT a missing import in the built output. The real root cause was in the
dispatch layer.

### Problem 2: `quality_score` NULL for decisions via `cleo memory decision-store`

**File**: `packages/core/src/memory/engine-compat.ts`
**Function**: `memoryDecisionStore` (lines 330–388)

`memoryDecisionStore` called `accessor.addDecision()` directly — bypassing `storeDecision()` from
`decisions.ts`. This meant:

1. `computeDecisionQuality()` was never called — `quality_score` remained NULL
2. `upsertGraphNode()` was never called — no graph node was created

By contrast, `memoryPatternStore` and `memoryLearningStore` in the same file correctly delegated
to `storePattern()` and `storeLearning()` respectively — both of which do call quality scoring
and graph population.

### Why `observeBrain` worked correctly

`memoryObserve` (via `observeBrain` in `brain-retrieval.ts`) already called both
`computeObservationQuality()` and `upsertGraphNode()`. Observations were fine.

---

## Fix Applied

**File changed**: `packages/core/src/memory/engine-compat.ts`

### Import added

```typescript
// T545: Decision store with quality scoring and graph auto-population
import { storeDecision } from './decisions.js';
```

### `memoryDecisionStore` rewritten

Before (bypassed business logic layer):
```typescript
const accessor = await getBrainAccessor(root);
const id = `D-${Date.now().toString(36)}`;
const row = await accessor.addDecision({
  id,
  type: 'technical',
  decision: params.decision,
  rationale: params.rationale,
  confidence: 'medium',
  outcome: 'pending',
  ...
});
```

After (routes through `storeDecision` for quality scoring + graph population):
```typescript
const row = await storeDecision(root, {
  type: 'technical',
  decision: params.decision,
  rationale: params.rationale,
  confidence: 'medium',
  outcome: 'pending',
  alternatives: params.alternatives,
  contextTaskId: params.taskId,
});
```

---

## Verification Results

### Build verification
- `pnpm run build` passes cleanly
- `grep "upsertGraphNode" packages/cleo/dist/cli/index.js | wc -l` = 16
- `grep "computeDecisionQuality\|computeObservationQuality" packages/cleo/dist/cli/index.js | wc -l` = 11

### Test verification
- `pnpm run test`: **7129 passed | 10 skipped | 32 todo — 0 failures**

### End-to-end verification

**Observation** (was already working, confirmed still works):
```
cleo memory observe "T545 final verification" --title "T545 final verification" --json
# -> O-mnwgdsvk-0, quality_score: 0.65
cleo memory graph-show "observation:O-mnwgdsvk-0" --json
# -> qualityScore: 0.65, graph node created
```

**Decision** (was broken, now fixed):
```
cleo memory decision-store --decision "T545 final decision..." --rationale "..." --json
# -> D001, type: technical
cleo memory graph-show "decision:D001" --json
# -> qualityScore: 0.7999..., graph node created
```

**Pattern** (was already working, confirmed still works):
```
cleo memory store --type pattern ... --json
# -> P-5c44944b, qualityScore: 0.6
cleo memory graph-show "pattern:P-5c44944b" --json
# -> qualityScore: 0.6, graph node created
```

### Database state
- Decisions with `quality_score` set: 1 (D001, new)
- Decisions with `quality_score` null: 3 (pre-fix historical entries)
- Observations with `quality_score` set: 3 (new entries post-fix)
- Observations with `quality_score` null: 53 (pre-fix historical entries)
- Graph nodes total: 289

Historical null entries are expected — they are from v2026.4.30 before graph/quality was added.
A separate backfill operation (already available via `cleo brain backfill`) can populate scores
for historical entries.

---

## Files Changed

- `packages/core/src/memory/engine-compat.ts` — import `storeDecision`; rewrite `memoryDecisionStore` to delegate to `storeDecision()` instead of calling `accessor.addDecision()` directly.

No other files changed. No logic changes to the auto-populate helpers or quality formulas.
