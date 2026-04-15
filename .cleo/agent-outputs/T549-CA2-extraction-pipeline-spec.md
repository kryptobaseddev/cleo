# T549-CA2: Memory Extraction Pipeline — Architecture Spec

**Task**: T549 (subagent CA2 — Architect)
**Date**: 2026-04-13
**Author**: Architect subagent
**Status**: Complete

---

## 1. Full Pipeline Diagram (ASCII)

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                    MEMORY EXTRACTION PIPELINE v2                            ║
╚══════════════════════════════════════════════════════════════════════════════╝

RAW SOURCES (at session boundary — never mid-task)
─────────────────────────────────────────────────
  session transcript      → ExtractionEngine.fromTranscript()
  task.complete event     → ExtractionEngine.fromTaskCompletion()
  code diff / git range   → ExtractionEngine.fromDiff()
  agent manual observe    → trusted path (bypass extraction, direct to gate)
  session debrief note    → ExtractionEngine.fromDebriefNote()

        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  STAGE 1: EXTRACTION                                                      │
│                                                                           │
│  Input: raw source event                                                  │
│  Process: rule-based classifier → typed candidate array                   │
│  Output: MemoryCandidate[]  (typed, confidence-scored, NOT stored yet)    │
│                                                                           │
│  Rules per source type (deterministic, no LLM required):                  │
│   • transcript  → keyword + structure parsing                             │
│   • task event  → structured fields (title, acceptance, completion proof) │
│   • diff        → file path + changed symbol extraction                   │
│   • debrief     → section header classification                           │
│                                                                           │
│  Output shape:                                                            │
│   { text, title, memoryType, tier, confidence, source, sourceSessionId }  │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  STAGE 2: VERIFICATION GATE                                               │
│                                                                           │
│  Input: MemoryCandidate[]                                                 │
│  Process: three sequential checks (fast-fail order)                       │
│                                                                           │
│  Check A — Duplicate detection (cosine similarity, threshold 0.85):       │
│    • embed candidate text → query brain_embeddings KNN (top 5)            │
│    • distance < 0.15 (cosine) → MERGE (increment frequency/cite count)    │
│    • distance 0.15–0.30 (similar, not identical) → EXTEND (link + store) │
│    • distance > 0.30 → NOVEL → proceed to Check B                         │
│                                                                           │
│  Check B — Contradiction detection:                                       │
│    • for top-5 KNN matches: keyword polarity flip heuristic               │
│    • confirmed contradiction → mark existing as invalid_at=now            │
│    • new candidate wins (higher confidence takes precedence by default)    │
│                                                                           │
│  Check C — Confidence threshold:                                          │
│    • candidate.confidence >= 0.40 → PASS                                  │
│    • candidate.confidence  < 0.40 → PENDING queue (not stored)            │
│                                                                           │
│  Trusted bypass: source='manual' skips A + B, applies C only             │
│                                                                           │
│  Output: verified candidates, pending queue, merge/invalidate operations  │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  STAGE 3: TYPED STORAGE                                                   │
│                                                                           │
│  Input: verified MemoryCandidate[]                                        │
│  Process: route to correct table, compute quality score, write atomically  │
│                                                                           │
│  Type routing:                                                            │
│   memoryType='factual'    → brain_learnings  (insight + source)           │
│   memoryType='episodic'   → brain_observations (title + narrative)        │
│   memoryType='procedural' → brain_patterns  (pattern + context)           │
│   memoryType='decision'   → brain_decisions (decision + rationale)        │
│                                                                           │
│  Tier assignment:                                                         │
│   tier='short'   → brain.tier='short'  (new schema column)               │
│   tier='medium'  → brain.tier='medium'                                   │
│   tier='long'    → brain.tier='long'                                     │
│                                                                           │
│  Atomic operations (per entry):                                           │
│   1. INSERT typed row with tier + valid_at=now + invalid_at=NULL          │
│   2. INSERT brain_embeddings (setImmediate — already done for obs)        │
│   3. upsertGraphNode + addGraphEdge (existing pattern)                    │
│                                                                           │
│  Output: stored entries with IDs                                          │
└───────────────────────────────────────────────────────────────────────────┘
        │ (at session end / idle / manual trigger)
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  STAGE 4: CONSOLIDATION (sleep-time compute)                              │
│                                                                           │
│  Input: full brain.db (scoped to recent window by default)               │
│  Trigger: cleo session end → hook → consolidateMemories() (already wired) │
│  Also: cleo brain maintenance (manual)                                    │
│                                                                           │
│  Steps:                                                                   │
│   4a. Deduplication pass — cosine > 0.85 pairs → merge (keep higher-     │
│       confidence entry, transfer citation count, set invalid_at on clone) │
│   4b. Quality recompute — retrieval_count + age factored into score       │
│   4c. Tier promotion — short-term entries with quality >= 0.75 promoted   │
│       to medium; medium entries cited >= 3 times promoted to long          │
│   4d. Cluster summarization — groups > 8 entries by Jaccard overlap       │
│       generate a summary observation (already exists in brain-lifecycle)  │
│   4e. Pruning — quality < 0.30 AND age > 30 days → soft-evict (mark      │
│       quality_score=0 so excluded from search, row stays for audit)        │
│   4f. Graph edge strength update — frequently co-retrieved pairs get      │
│       weight += 0.1 up to max 1.0                                         │
│                                                                           │
│  Output: cleaner brain.db with updated scores, tiers, and graph weights   │
└───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  STAGE 5: BUDGET-AWARE RETRIEVAL                                          │
│                                                                           │
│  Input: query text + token budget                                         │
│  Process: multi-strategy parallel search → ranked merge → budget trim     │
│                                                                           │
│  Strategies (parallel):                                                   │
│   A. FTS5 BM25 (existing searchBrain())    — keyword precision            │
│   B. Vector KNN (existing searchSimilar()) — semantic recall              │
│   C. Graph neighbors (existing relatedBrainNodes()) — associative         │
│                                                                           │
│  Score fusion:                                                            │
│   final = (fts_score * 0.50) + (vec_score * 0.40) + (graph_score * 0.10) │
│   Apply quality multiplier: final *= entry.quality_score                  │
│   Apply recency boost: final += 0.05 if age < 7 days                     │
│   Apply type priority: procedural entries += 0.10 (always-useful rules)  │
│                                                                           │
│  Budget enforcement:                                                      │
│   1. Rank top-50 by final score                                           │
│   2. Walk list, count tokens (≈ len/4), stop when budget exhausted        │
│   3. Tier 0 (procedural) never dropped — comes first always               │
│   4. Episodic entries dropped first when budget tight                     │
│   5. Return structured result with remaining_budget field                 │
│                                                                           │
│  Output: BudgetAwareRetrievalResult — typed entries + token cost          │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Extraction Rules Per Source Type

### 2.1 Session Transcript

**When**: `cleo session end` → fires `extractFromTranscript()` (already exists in `auto-extract.ts`)

**What gets extracted**:

| Signal | Rule | Memory Type | Confidence |
|--------|------|-------------|------------|
| Line starting with "Completed:", "Fixed:", "Shipped:" | task completion event | episodic | 0.70 |
| Line starting with "Decision:", "We decided to" | architectural decision | decision | 0.75 |
| Line starting with "Always:", "Never:", "Rule:" | procedural rule | procedural | 0.65 |
| Line containing "because X causes Y", "X leads to Y" | causal learning | factual | 0.60 |
| Error message + resolution within 10 lines | debugging pattern | procedural | 0.65 |
| Lines containing version numbers + "upgraded to" | codebase fact | factual | 0.70 |
| Lines below quality threshold (e.g., "[hook]", "File changed:", "Task start:") | noise | — | below 0.40 (filtered) |

**Format**: `MemoryCandidate[]` — one candidate per extracted signal.

**Limit**: cap at 10 candidates per session (prevents flooding from long transcripts).

### 2.2 Task Completion Event

**When**: `task.complete` lifecycle hook fires

**What gets extracted**:

| Field | Extraction | Memory Type | Confidence |
|-------|-----------|-------------|------------|
| `task.title` + `task.acceptance` met | "Completed: {title}" | episodic | 0.80 |
| `task.acceptance` items (pipe-separated) | one candidate per accepted criterion that describes a behavioral rule | procedural | 0.70 |
| `task.labels` + completion outcome | pattern update ("label X tasks succeeded") | factual | 0.65 |
| Verification block if present | factual record of what was verified | factual | 0.75 |

**Limit**: max 5 candidates per task completion.

### 2.3 Code Diff / Git Range

**When**: manual trigger via `cleo memory extract --from <sha> --to <sha>` or future hook.

**What gets extracted**:

| Signal | Rule | Memory Type | Confidence |
|--------|------|-------------|------------|
| New exported function signature | "Added function X to module Y" | factual | 0.70 |
| Removed or renamed symbol | "Removed/renamed X in Y — callers must update" | procedural | 0.75 |
| New package added to package.json | "Dependency X added at version Y" | factual | 0.80 |
| Schema migration (brain-schema.ts, drizzle files) | "Schema changed: table X, column Y" | factual | 0.85 |
| File deleted entirely | "Module X deleted — use Y instead" if replacement visible | procedural | 0.70 |

**Limit**: max 15 candidates per diff range (otherwise too noisy).

### 2.4 Agent Observation (Manual `cleo memory observe`)

**Bypass extraction entirely.** Manual observations are ground truth by definition (owner or trusted agent explicitly chose to store this).

Apply only Check C (confidence threshold). Default confidence for manual: 0.80.

No extraction rules applied — the text IS the extracted content.

### 2.5 Session Debrief / Handoff Note

**When**: `cleo session end --note "..."` or sticky note with `type=debrief`.

**What gets extracted**:

| Signal | Rule | Memory Type | Confidence |
|--------|------|-------------|------------|
| Section "## What worked" or "## Successes" | one candidate per bullet | procedural (success pattern) | 0.70 |
| Section "## Blockers" or "## Problems" | one candidate per bullet | procedural (failure pattern) | 0.70 |
| Section "## Decisions" | one candidate per bullet | decision | 0.80 |
| Section "## Next session" or "## Continue" | session handoff, episodic | episodic | 0.65 |

**Limit**: max 8 candidates per debrief note.

---

## 3. Verification Gate — Implementation Design

### 3.1 Where It Lives

**New file**: `packages/core/src/memory/extraction-gate.ts`

This wraps `observeBrain()`, `storeLearning()`, `storePattern()`, and `storeDecision()`. No call site changes — instead, the extraction pipeline calls the gate, which calls the storage functions.

The gate does NOT sit inside `observeBrain()` itself. Wrapping observeBrain would add latency to the hook-triggered path (agent stop, file write, etc.). The gate is an orchestration layer called only from the extraction pipeline.

### 3.2 Function Signatures

```typescript
// packages/core/src/memory/extraction-gate.ts

/** A candidate memory entry produced by extraction. */
export interface MemoryCandidate {
  text: string;
  title: string;
  /** Cognitive type — determines which brain table receives this entry. */
  memoryType: 'factual' | 'episodic' | 'procedural' | 'decision';
  /** Storage tier — determines eviction policy. */
  tier: 'short' | 'medium' | 'long';
  /** Confidence 0.0–1.0. Below 0.40 goes to pending queue. */
  confidence: number;
  /** Source that produced this candidate. */
  source: 'transcript' | 'task-completion' | 'diff' | 'manual' | 'debrief';
  sourceSessionId?: string;
  /** Skip duplicate + contradiction checks (trusted sources only). */
  trusted?: boolean;
}

/** Result of passing a candidate through the gate. */
export interface GateResult {
  action: 'stored' | 'merged' | 'pending' | 'rejected';
  /** ID of the stored or merged entry. Null when pending or rejected. */
  id: string | null;
  /** Reason for the action taken. */
  reason: string;
}

/**
 * Run a MemoryCandidate through the verification gate.
 *
 * Checks (in order):
 *   A. Duplicate detection via cosine similarity (skipped for trusted sources)
 *   B. Contradiction detection (skipped for trusted sources)
 *   C. Confidence threshold >= 0.40
 *
 * @param projectRoot - Project root for brain.db access
 * @param candidate - Candidate to verify and store
 * @returns GateResult describing what happened
 */
export async function verifyAndStore(
  projectRoot: string,
  candidate: MemoryCandidate,
): Promise<GateResult>;

/**
 * Run a batch of candidates through the gate.
 * Candidates are processed sequentially (not parallel) so that earlier
 * "merge" actions are visible to later similarity checks.
 *
 * @param projectRoot - Project root for brain.db access
 * @param candidates - Array of candidates to verify
 * @returns Array of GateResults in input order
 */
export async function verifyAndStoreBatch(
  projectRoot: string,
  candidates: MemoryCandidate[],
): Promise<GateResult[]>;
```

### 3.3 Check A — Duplicate Detection

```typescript
// Inside verifyAndStore():

const DUPLICATE_THRESHOLD = 0.15;   // cosine distance — near-identical
const SIMILAR_THRESHOLD   = 0.30;   // cosine distance — related but distinct

if (!candidate.trusted && isEmbeddingAvailable()) {
  const similar = await searchSimilar(candidate.text, projectRoot, 5);
  // searchSimilar() returns distance-ascending (lower = more similar)
  
  const nearest = similar[0];
  if (nearest) {
    if (nearest.distance < DUPLICATE_THRESHOLD) {
      // Exact duplicate — merge: increment citation count, update quality
      await mergeIntoExisting(projectRoot, nearest.id, candidate);
      return { action: 'merged', id: nearest.id, reason: `Duplicate of ${nearest.id} (distance=${nearest.distance.toFixed(3)})` };
    }
    if (nearest.distance < SIMILAR_THRESHOLD) {
      // Related — store new but link to existing
      // Continue to storage, add graph edge after
    }
  }
}
```

**Performance cost**: One embedding call (≈ 10-30ms if local provider), one KNN query (≈ 5ms SQLite vec0). Total ≈ 15-50ms per candidate. Acceptable at session-boundary extraction (not mid-task).

**When embedding is unavailable**: Check A degrades gracefully to SHA-256 content hash comparison (existing 30-second dedup window in `observeBrain()`). This is weaker but not worse than the current state.

### 3.4 Check B — Contradiction Detection

Contradiction detection via embedding alone is unreliable (negation is not a distance relationship in embedding space). Use a polarity heuristic:

```typescript
// keyword polarity flip: presence of negation signals near a similar claim
const NEGATION_MARKERS = ['not', 'never', 'no longer', 'deprecated', 'removed', 'replaced', 'broken'];

function hasContradictingPolarity(existingText: string, newText: string): boolean {
  const existingNegated = NEGATION_MARKERS.some(m => existingText.toLowerCase().includes(m));
  const newNegated      = NEGATION_MARKERS.some(m => newText.toLowerCase().includes(m));
  // Contradiction: exactly one of the two texts carries negation
  return existingNegated !== newNegated;
}
```

When contradiction is detected on a top-5 KNN match with distance < 0.30:
- Set `invalid_at = now` on the existing entry (new schema column — see Section 7).
- Store the new candidate as authoritative.
- Create a graph edge: `new_id → old_id` with `edge_type='supersedes'`.

### 3.5 Check C — Confidence Threshold

```typescript
const MINIMUM_CONFIDENCE = 0.40;

if (candidate.confidence < MINIMUM_CONFIDENCE) {
  await appendToPendingQueue(projectRoot, candidate);
  return { action: 'pending', id: null, reason: `Confidence ${candidate.confidence} below ${MINIMUM_CONFIDENCE}` };
}
```

**Pending queue**: a new table `brain_pending_candidates` (see Section 7). Entries sit here until promoted (future: manual review command `cleo memory pending`) or expired (>7 days → deleted in consolidation pass).

### 3.6 Trusted Source Bypass

Manual observations (`source='manual'`) skip Checks A and B. They still pass through Check C (minimum confidence 0.40) since even manual observations can be mislabeled.

```typescript
if (candidate.trusted) {
  // Skip A and B — go straight to C and storage
}
```

---

## 4. Storage with Typing

### 4.1 Type Routing

```typescript
// packages/core/src/memory/extraction-gate.ts

async function storeVerifiedCandidate(
  projectRoot: string,
  candidate: MemoryCandidate,
): Promise<string> {
  switch (candidate.memoryType) {
    case 'factual':
      return storeLearning(projectRoot, {
        insight: candidate.text,
        source: candidate.source,
        confidence: candidate.confidence,
        actionable: candidate.source === 'task-completion',
        tier: candidate.tier,
      });

    case 'episodic':
      const result = await observeBrain(projectRoot, {
        text: candidate.text,
        title: candidate.title,
        type: 'discovery',
        sourceType: candidate.source === 'manual' ? 'manual' : 'agent',
        sourceSessionId: candidate.sourceSessionId,
        tier: candidate.tier,
      });
      return result.id;

    case 'procedural':
      return storePattern(projectRoot, {
        type: 'workflow',
        pattern: candidate.text,
        context: candidate.title,
        tier: candidate.tier,
      });

    case 'decision':
      return storeDecision(projectRoot, {
        type: 'technical',
        decision: candidate.title,
        rationale: candidate.text,
        confidence: candidate.confidence >= 0.80 ? 'high' : candidate.confidence >= 0.60 ? 'medium' : 'low',
        tier: candidate.tier,
      });
  }
}
```

### 4.2 Tier Assignment

Tier is set by the extraction engine, not the gate. Default rules:

| Source | Default Tier | Rationale |
|--------|-------------|-----------|
| transcript (session-scoped) | short | Session-level, may not generalize |
| task.complete (acceptance verified) | medium | Task verified → more durable |
| diff (code fact) | long | Code facts are durable |
| manual | long | Agent/owner chose to record permanently |
| debrief (decision section) | long | Decisions are durable |
| debrief (blocker/success section) | medium | Patterns are moderately durable |

### 4.3 Quality Score with Tier Factor

Extend `computeObservationQuality()` and friends in `quality-scoring.ts` with a tier bonus:

```typescript
const TIER_BONUS: Record<'short' | 'medium' | 'long', number> = {
  short:  0.00,
  medium: 0.05,
  long:   0.10,
};

// Added inside each compute*Quality() function:
score += TIER_BONUS[params.tier ?? 'short'];
```

This means long-tier entries start with a quality advantage, making them more likely to survive consolidation.

---

## 5. Consolidation Algorithm (Sleep-Time Compute)

### 5.1 Trigger Points

```
cleo session end
  └── session-hooks.ts:handleSessionEnd()
        └── (existing) maybeRefreshMemoryBridge()
        └── (new) triggerConsolidation(projectRoot, { scope: 'recent' })
              └── runBrainMaintenance(projectRoot, { skipEmbeddings: true })
                    (existing: applyTemporalDecay + consolidateMemories + reconcileOrphanedRefs)

cleo brain maintenance
  └── runBrainMaintenance(projectRoot, options)
        (manual full pass — all steps including embeddings)
```

The `session end` trigger runs a fast pass (`skipEmbeddings: true`) because embedding backfill is expensive and can run later. The manual maintenance runs the full pass.

### 5.2 Enhanced Consolidation Steps

Extend `consolidateMemories()` in `brain-lifecycle.ts` with three new sub-steps:

#### Step 4a: Cosine Deduplication (new)

```typescript
/**
 * Remove near-duplicate observations using cosine similarity.
 * Runs before keyword-cluster consolidation.
 * 
 * @param projectRoot
 * @param options.similarityThreshold - Cosine distance below which entries are merged (default 0.10)
 * @param options.limit - Max pairs to process per run (default 50, prevents runaway)
 */
async function deduplicateByEmbedding(
  projectRoot: string,
  options?: { similarityThreshold?: number; limit?: number },
): Promise<{ merged: number }>;
```

Algorithm: fetch all embeddings → pairwise KNN (or use vec0 self-join if SQLite supports it) → merge pairs where distance < 0.10 → keep higher quality_score entry, set invalid_at on the lower. Only runs when embedding is available.

#### Step 4b: Quality Recompute with Retrieval Count (new)

The current quality score is computed at insert time and never updated. After consolidation, recompute quality for all entries using:

```typescript
const updatedScore = 
  (baseScore * 0.50) +
  (retrievalUtility * 0.30) +  // citation_count / max_citation_count in DB
  (recencyBonus    * 0.20);    // 1.0 if < 7 days, 0.5 if < 30 days, 0.0 otherwise
```

This requires a new `citation_count` column (see Section 7) that is incremented each time an entry is returned in a retrieval result.

#### Step 4c: Tier Promotion (new)

```typescript
// Promote short → medium
UPDATE brain_observations
SET tier = 'medium'
WHERE tier = 'short'
  AND quality_score >= 0.75
  AND created_at < datetime('now', '-7 days');

// Promote medium → long  
UPDATE brain_learnings
SET tier = 'long'
WHERE tier = 'medium'
  AND citation_count >= 3;
```

Same pattern applied to brain_patterns and brain_decisions.

#### Step 4d: Cluster Summarization (existing, enhanced)

The existing Jaccard-keyword greedy clustering in `consolidateMemories()` remains. Change the threshold from `olderThanDays=90` to `olderThanDays=30` for short-tier entries (they age faster).

Also add: when a cluster summary is created, set `tier='long'` on the summary observation (summaries are durable).

#### Step 4e: Soft Eviction (new)

```typescript
// Mark quality too low as effectively invisible
// (rows are never hard-deleted — audit trail preserved)
UPDATE brain_observations
SET quality_score = 0.0
WHERE quality_score < 0.30
  AND tier = 'short'
  AND invalid_at IS NULL
  AND created_at < datetime('now', '-30 days');
```

#### Step 4f: Graph Edge Strength Update (new)

```typescript
/**
 * Strengthen edges between entries that are frequently co-retrieved.
 * Co-retrieval is tracked by logging retrieval batches.
 */
async function strengthenCoRetrievedEdges(
  projectRoot: string,
): Promise<{ updated: number }>;
```

Requires a new `brain_retrieval_log` table (see Section 7) that records which entry IDs appeared together in a retrieval result. Consolidation reads this log, identifies frequent co-occurrence pairs, and issues `UPDATE brain_page_edges SET weight = MIN(1.0, weight + 0.1)` for their graph edges.

### 5.3 Full Consolidated `runBrainMaintenance()` Order

```
1. applyTemporalDecay()         — existing
2. deduplicateByEmbedding()     — new, before consolidation
3. recomputeQualityScores()     — new
4. tierPromotion()              — new
5. consolidateMemories()        — existing (Jaccard clustering)
6. softEviction()               — new
7. strengthenCoRetrievedEdges() — new
8. reconcileOrphanedRefs()      — existing
9. populateEmbeddings()         — existing (skipped in fast-path)
```

---

## 6. Budget-Aware Retrieval Design

### 6.1 New Function Signature

```typescript
// packages/core/src/memory/brain-retrieval.ts (extend)

export interface BudgetAwareRetrievalParams {
  query: string;
  /** Token budget for returned content (default: 1500). */
  tokenBudget?: number;
  /** Session/task scope for relevance boosting (optional). */
  scope?: { taskId?: string; epicId?: string };
  /** Memory types to include (default: all). */
  memoryTypes?: Array<'factual' | 'episodic' | 'procedural' | 'decision'>;
}

export interface BudgetAwareRetrievalResult {
  entries: Array<{
    id: string;
    memoryType: string;
    tier: string;
    title: string;
    text: string;
    score: number;
    tokensEstimated: number;
  }>;
  /** How many tokens were consumed from the budget. */
  tokensUsed: number;
  /** How many tokens remain from the budget. */
  tokensRemaining: number;
  /** How many entries were excluded due to budget. */
  excluded: number;
}

/**
 * Multi-strategy retrieval with hard token budget enforcement.
 *
 * Runs FTS5, vector KNN, and graph neighbor strategies in parallel,
 * fuses scores, ranks by (quality * relevance), then walks the ranked
 * list filling the token budget from top to bottom.
 *
 * Procedural entries are promoted to the front (never dropped).
 * Episodic entries are dropped first when budget is tight.
 *
 * @param projectRoot - Project root for brain.db access
 * @param params - Query + budget + optional scope
 * @returns Ranked entries within token budget
 */
export async function retrieveWithBudget(
  projectRoot: string,
  params: BudgetAwareRetrievalParams,
): Promise<BudgetAwareRetrievalResult>;
```

### 6.2 Score Fusion Implementation

```typescript
// Inside retrieveWithBudget():

// Run three strategies in parallel
const [ftsResults, vecResults, graphResults] = await Promise.all([
  searchBrain(projectRoot, query, { limit: 20 }),
  searchSimilar(query, projectRoot, 20),
  relatedBrainNodes(projectRoot, /* derive seed from query */, {}),
]);

// Normalize each strategy's scores to [0, 1]
const ftsNorm  = minMaxNormalize(ftsResults.map(r => r.relevance ?? 0));
const vecNorm  = minMaxNormalize(vecResults.map(r => 1 - r.distance));  // invert distance
const graphNorm = minMaxNormalize(graphResults.map(r => r.weight ?? 0.5));

// Merge by ID, take max per strategy
const scoreMap = new Map<string, { fts: number; vec: number; graph: number; entry: unknown }>();
// ... (deduplicate across strategies by entry ID)

// Final score per entry
for (const [id, scores] of scoreMap) {
  const entry = await fetchBrainEntry(id);
  const fused =
    (scores.fts   * 0.50) +
    (scores.vec   * 0.40) +
    (scores.graph * 0.10);
  
  const qualityAdjusted = fused * (entry.quality_score ?? 0.5);
  const recencyBoosted  = qualityAdjusted + (isRecent(entry.created_at, 7) ? 0.05 : 0);
  const typePromoted    = recencyBoosted + (entry.memoryType === 'procedural' ? 0.10 : 0);
  
  rankedEntries.push({ ...entry, score: typePromoted });
  
  // Track retrieval for co-occurrence logging
  citationCount.increment(id);
}
```

### 6.3 Budget Enforcement

```typescript
// Sort: procedural first, then by score descending
rankedEntries.sort((a, b) => {
  if (a.memoryType === 'procedural' && b.memoryType !== 'procedural') return -1;
  if (b.memoryType === 'procedural' && a.memoryType !== 'procedural') return  1;
  return b.score - a.score;
});

const result: BudgetAwareRetrievalResult['entries'] = [];
let tokensUsed = 0;
let excluded   = 0;
const budget   = params.tokenBudget ?? 1500;

for (const entry of rankedEntries) {
  const entryTokens = Math.ceil(entry.text.length / 4);  // ≈ 4 chars/token
  
  if (tokensUsed + entryTokens > budget) {
    // Episodic entries: skip (dropped first)
    if (entry.memoryType === 'episodic') { excluded++; continue; }
    // Procedural: always include (already sorted first, but safety check)
    if (entry.memoryType === 'procedural') {
      result.push({ ...entry, tokensEstimated: entryTokens });
      tokensUsed += entryTokens;
      continue;
    }
    // Factual: truncate text to fit remaining budget
    const remaining = budget - tokensUsed;
    if (remaining > 20) {
      const truncated = entry.text.slice(0, remaining * 4 - 20) + '…';
      result.push({ ...entry, text: truncated, tokensEstimated: remaining });
      tokensUsed += remaining;
    }
    excluded++;
    continue;
  }
  
  result.push({ ...entry, tokensEstimated: entryTokens });
  tokensUsed += entryTokens;
}

return { entries: result, tokensUsed, tokensRemaining: budget - tokensUsed, excluded };
```

### 6.4 Citation Count Tracking

After retrieval, increment citation counts in background:

```typescript
setImmediate(() => {
  for (const entry of result.entries) {
    incrementCitationCount(projectRoot, entry.id).catch(() => {/* best-effort */});
  }
});
```

---

## 7. Instrumentation Metrics

### 7.1 Metrics File

New file: `packages/core/src/memory/memory-metrics.ts`

Appends JSONL events to `.cleo/metrics/MEMORY_METRICS.jsonl` (same pattern as `TOKEN_USAGE.jsonl`).

```typescript
export type MemoryMetricEvent =
  | { event: 'extract';     sessionId: string; source: string; candidates: number; timestamp: string }
  | { event: 'gate_pass';   candidateId?: string; action: 'stored' | 'merged' | 'pending' | 'rejected'; memoryType: string; confidence: number; timestamp: string }
  | { event: 'retrieve';    query: string; strategy: string; tokensUsed: number; entries: number; excluded: number; timestamp: string }
  | { event: 'consolidate'; step: string; merged: number; evicted: number; promoted: number; durationMs: number; timestamp: string };

export function recordMemoryMetric(event: MemoryMetricEvent): void;
```

### 7.2 Metrics Per Stage

| Stage | Metric | Purpose |
|-------|--------|---------|
| Extraction | `candidates_per_session` | Measure extraction productivity |
| Extraction | `noise_rate` = candidates rejected / total | High noise rate signals over-eager extractor |
| Gate | `gate_pass_rate` = stored / (stored + pending + rejected) | Health of confidence threshold |
| Gate | `duplicate_rate` = merged / total candidates | Dedup effectiveness |
| Gate | `contradiction_rate` = invalidated / total candidates | Tracks knowledge churn |
| Storage | `entries_per_day` by `memoryType` and `tier` | Growth rate monitoring |
| Storage | `quality_score_p50` at insert time | Quality distribution tracking |
| Consolidation | `entries_merged_per_run` | Dedup effectiveness |
| Consolidation | `entries_evicted_per_run` | Noise pruning effectiveness |
| Consolidation | `tier_promotions_per_run` | Signal elevation tracking |
| Consolidation | `duration_ms` | Performance cost of consolidation |
| Retrieval | `queries_per_session` | Retrieval frequency |
| Retrieval | `avg_tokens_used_per_query` | Token cost of retrieval |
| Retrieval | `avg_entries_returned` | Retrieval depth |
| Retrieval | `budget_exceeded_rate` | How often budget truncates results |
| Retrieval | `citation_count_p90` | Are top-retrieved entries being reused? |

### 7.3 Dashboard Command

Extend `cleo brain maintenance` output to include metrics summary, or add `cleo brain health`:

```
Memory Health Report
  Total entries:      421 (obs=210, learnings=89, patterns=75, decisions=47)
  Quality p50/p90:    0.63 / 0.82
  Gate pass rate:     78% (last 7 days)
  Duplicate rate:     12%
  Token cost (7d avg): 823 tokens/retrieval
  Tier distribution:  short=31%, medium=44%, long=25%
  Citation p90:       4 (entries retrieved ≥ 4 times)
  Last consolidation: 6 hours ago
```

---

## 8. Agent-Driven vs Automatic Responsibility Matrix

| Pipeline Stage | Who Decides | Implementation | Rationale |
|---------------|------------|----------------|-----------|
| Extraction: WHEN | Automatic (lifecycle hooks) | `session end` hook triggers extraction | Extraction at session boundary avoids mid-task latency |
| Extraction: WHAT | Automatic (rule-based classifier) | `ExtractionEngine.fromX()` functions | Deterministic, testable, no LLM cost |
| Verification: duplicate check | Automatic (code) | `verifyAndStore()` cosine gate | Embedding comparison is deterministic |
| Verification: contradiction | Automatic (code, heuristic) | polarity flip heuristic | Fast, no LLM cost; approximate is good enough |
| Verification: confidence threshold | Automatic (code) | fixed threshold 0.40 | Simple gate, reviewable |
| Storage: routing | Automatic (code) | `memoryType` → table map | Type was set at extraction time |
| Storage: quality score | Automatic (code) | `compute*Quality()` + tier bonus | Consistent, no agent subjectivity |
| Consolidation: ALL | Automatic (sleep-time compute) | triggered at `session end` | Background, never interrupts agent work |
| Retrieval: WHEN | Agent-driven (JIT) | agent calls `cleo memory find` or `retrieveWithBudget()` | Agent knows when it needs context |
| Retrieval: WHAT | Agent-driven (query text) | agent provides the query | Agent knows the domain it needs |
| Retrieval: budget | Automatic (code) | `tokenBudget` param with default 1500 | Prevents context rot without agent attention |
| Manual observe | Agent-driven | `cleo memory observe` → trusted bypass | Owner/agent explicitly chose to store |

---

## 9. New Code vs Extending Existing Code

### New Files Required

| File | Purpose |
|------|---------|
| `packages/core/src/memory/extraction-engine.ts` | `ExtractionEngine` class with `fromTranscript()`, `fromTaskCompletion()`, `fromDiff()`, `fromDebriefNote()` |
| `packages/core/src/memory/extraction-gate.ts` | `verifyAndStore()`, `verifyAndStoreBatch()`, `MemoryCandidate`, `GateResult` types |
| `packages/core/src/memory/memory-metrics.ts` | `recordMemoryMetric()`, metric event types, JSONL append |

### Extend Existing Files

| File | What to Add |
|------|------------|
| `packages/core/src/memory/brain-retrieval.ts` | `retrieveWithBudget()` function |
| `packages/core/src/memory/brain-lifecycle.ts` | `deduplicateByEmbedding()`, `recomputeQualityScores()`, `tierPromotion()`, `softEviction()`, `strengthenCoRetrievedEdges()` |
| `packages/core/src/memory/brain-maintenance.ts` | Wire new lifecycle steps into `runBrainMaintenance()` |
| `packages/core/src/memory/quality-scoring.ts` | Add `tier` param + tier bonus to all four `compute*Quality()` functions |
| `packages/core/src/hooks/handlers/session-hooks.ts` | Trigger extraction engine + fast consolidation pass on `session end` |
| `packages/core/src/store/brain-schema.ts` | New columns + new tables (see below) |

### Schema Changes Required

```sql
-- Add to brain_observations, brain_learnings, brain_patterns, brain_decisions:
ALTER TABLE brain_observations ADD COLUMN tier TEXT DEFAULT 'short' CHECK (tier IN ('short', 'medium', 'long'));
ALTER TABLE brain_observations ADD COLUMN valid_at TEXT;      -- when fact became true (default=created_at)
ALTER TABLE brain_observations ADD COLUMN invalid_at TEXT;    -- when fact was superseded (NULL=still valid)
ALTER TABLE brain_observations ADD COLUMN citation_count INTEGER DEFAULT 0;
ALTER TABLE brain_observations ADD COLUMN memory_type TEXT CHECK (memory_type IN ('factual', 'episodic', 'procedural', 'decision'));

-- Same three columns for brain_learnings, brain_patterns, brain_decisions

-- New table: pending candidates (confidence < 0.40)
CREATE TABLE IF NOT EXISTS brain_pending_candidates (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  title       TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'short',
  confidence  REAL NOT NULL,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL  -- created_at + 7 days
);

-- New table: retrieval co-occurrence log (for edge strengthening)
CREATE TABLE IF NOT EXISTS brain_retrieval_log (
  session_id  TEXT NOT NULL,
  entry_ids   TEXT NOT NULL,  -- JSON array of IDs returned together
  query       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX brain_retrieval_log_session ON brain_retrieval_log(session_id);
```

### Contracts Package

Add to `packages/contracts/src/brain.ts`:

```typescript
export interface MemoryCandidate { ... }   // (as defined in Section 3.2)
export interface GateResult { ... }         // (as defined in Section 3.2)
export interface BudgetAwareRetrievalParams { ... }  // (as defined in Section 6.1)
export interface BudgetAwareRetrievalResult { ... }  // (as defined in Section 6.1)
export type MemoryMetricEvent = ...;        // (as defined in Section 7.1)
```

### CLI Commands (add to `packages/cleo/src/cli/commands/`)

| Command | Maps to |
|---------|---------|
| `cleo memory extract --source transcript --session <id>` | `ExtractionEngine.fromTranscript()` |
| `cleo memory extract --source diff --from <sha> --to <sha>` | `ExtractionEngine.fromDiff()` |
| `cleo memory pending` | List `brain_pending_candidates` for review |
| `cleo brain health` | Print memory metrics dashboard |

---

## 10. Implementation Order

The stages form a dependency graph. Build in this order:

1. **Schema changes** — add columns + new tables to `brain-schema.ts` (no logic yet, unblocks everything)
2. **`extraction-gate.ts`** — the gate that all writes flow through; depends on `searchSimilar()` (existing)
3. **`extraction-engine.ts`** — produces `MemoryCandidate[]`; calls the gate; depends on gate
4. **`brain-lifecycle.ts` additions** — new consolidation steps; depends on schema (citation_count, tier, invalid_at)
5. **`brain-retrieval.ts` `retrieveWithBudget()`** — depends on existing `searchBrain()` + `searchSimilar()` + `relatedBrainNodes()`
6. **`memory-metrics.ts`** — pure append, no dependencies; can be built in parallel with step 2
7. **Session hook wiring** — trigger extraction on `session end`; depends on steps 2 + 3
8. **CLI commands** — surface the new operations; depends on all above
9. **`quality-scoring.ts` tier bonus** — small extension; can be in step 1 or 2

---

*Architect subagent output. See MANIFEST.jsonl for entry.*
