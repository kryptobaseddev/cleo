# T549 Wave 2: Extraction Gate — Summary

**Task**: T549 Wave 2-A + 2-B
**Date**: 2026-04-13
**Status**: Complete

---

## What Was Built

### New File: `packages/core/src/memory/extraction-gate.ts`

The extraction gate is a verification layer that wraps all BRAIN memory writes with three
ordered checks before a candidate is stored. It never blocks the primary write path on error —
all checks are wrapped in try/catch and degrade gracefully.

---

## Gate Architecture

### Check A — Content-Hash Deduplication (always runs)

Queries `brain_observations.content_hash` for a SHA-256 prefix match (normalised text, lowercase).
Covers the most common case: identical content submitted twice. Returns `merged` with the existing
ID and increments `citation_count` on the existing entry.

Only covers `brain_observations` (the only table with a `content_hash` column). Other memory
types skip hash dedup and proceed to the similarity check.

### Check B — Cosine Similarity + Contradiction Detection (embedding-gated, trusted bypass)

Runs `searchSimilar(text, projectRoot, 5)` to get the nearest 5 entries by cosine distance.

| Distance | Action |
|----------|--------|
| `< 0.15` | Exact duplicate → `merged`, citation_count incremented |
| `0.15–0.30` | Related → run `hasContradictingPolarity()` |
| `>= 0.30` | Novel → proceed to Check C |

**Contradiction heuristic** (`hasContradictingPolarity`): returns true when exactly one of
the two texts carries a negation marker (not, never, deprecated, removed, …) AND the texts share
at least 3 meaningful keywords (>4 chars). When contradiction is detected:
- `invalidateEntry()` sets `invalid_at = now` on the old entry (routes by ID prefix to correct table)
- Returns `stored` with `reason: 'contradiction-supersedes {oldId}'`
- After storage, a `supersedes` graph edge is added (best-effort, fire-and-forget)

**Trusted bypass**: `source='manual'`, `sourceConfidence='owner'/'task-outcome'`, or
`candidate.trusted=true` skips Check B entirely. Trusted sources still run Checks A and C.

**Embedding unavailable**: Check B is skipped entirely. The gate degrades to hash-only dedup
(still useful; current state parity).

### Check C — Confidence Threshold (always runs)

Candidates with `confidence < 0.40` return `pending`. Pending entries are not stored — the
caller is responsible for routing them to a pending queue if needed.

---

## Storage Routing (`storeVerifiedCandidate`)

After `verifyCandidate` returns `stored`, `storeVerifiedCandidate` routes to the correct BRAIN
table based on `memoryType`:

| memoryType | Storage function | Table |
|------------|-----------------|-------|
| `semantic` | `storeLearning()` | `brain_learnings` |
| `episodic` | `observeBrain()` | `brain_observations` |
| `procedural` | `storePattern()` | `brain_patterns` |

The `verifyAndStore()` convenience function runs both verification and storage in one call.
`verifyAndStoreBatch()` processes an array sequentially so earlier stores are visible to
later similarity checks.

---

## Conflict Resolutions Applied

| Conflict | Resolution |
|----------|-----------|
| CONFLICT-01 | Used `BrainCognitiveType` from `BRAIN_COGNITIVE_TYPES` (semantic/episodic/procedural), NOT CA2's original (factual/episodic/procedural/decision) |
| Spec vs Wave 0 schema | `sourceConfidence` uses Wave 0 enum: owner/task-outcome/agent/speculative |

---

## Exports Added

`packages/core/src/memory/index.ts` — added `export * from './extraction-gate.js'`

Public surface from `extraction-gate.ts`:
- `MemoryCandidate` (interface)
- `GateResult` (interface)
- `verifyCandidate(projectRoot, candidate)` — pure gate check, no storage
- `verifyBatch(projectRoot, candidates)` — batch gate check, no storage
- `storeVerifiedCandidate(projectRoot, candidate)` — storage routing only
- `verifyAndStore(projectRoot, candidate)` — gate + store
- `verifyAndStoreBatch(projectRoot, candidates)` — batch gate + store

---

## Quality Gates

- `pnpm biome check --write`: PASS
- `pnpm run build`: PASS
- `pnpm run test`: PASS — 396 files, 7129 tests, 0 new failures, 10 skipped (pre-existing)

---

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/memory/extraction-gate.ts` | NEW — full gate implementation |
| `packages/core/src/memory/index.ts` | Added `export * from './extraction-gate.js'` |

---

## Wave Dependencies Unblocked

Wave 2 complete. Downstream waves may now proceed:
- Wave 3: Extraction Engine — calls `verifyAndStoreBatch()` with typed candidates
- Wave 4: Consolidation — uses `invalidateEntry()` pattern for dedup merging
- Wave 7: Session hook wiring — calls `verifyAndStore()` from session-end hook
