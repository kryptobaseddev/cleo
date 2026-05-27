---
id: ADR-048
title: "ADR-048: Unified Memory Extraction Pipeline Contract"
status: accepted
date: 2026-04-15
authors: ["cleo-subagent Worker E (T749)", "T726 Council Lead C (T726-council-extraction.md)"]
related_tasks: ["T726", "T749", "T745", "T742", "T740", "T739", "T738", "T734", "T736", "T737"]
supersedes: null
amends: "ADR-009"
summary: "Establishes the unified extraction pipeline contract for CLEO BRAIN. All memory write paths MUST route through verifyAndStore(). Direct calls to storeLearning/storePattern/storeDecision from extraction pipelines without the gate are prohibited. Documents the 7-step gated flow, gaps remediated in T726 Wave 1E, model tier choices (Sonnet cold, Ollama auto-install warm), and D008 7-technique mapping."
keywords: ["brain", "memory", "extraction", "pipeline", "dedup", "supersession", "reflector", "observer", "graph-bridge"]
topics: ["brain", "memory", "extraction", "consolidation", "architecture"]
---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context and Problem Statement

### 1.1 Background

CLEO BRAIN memory architecture is based on D008's 7-technique memory system, which specifies a gated write pipeline that prevents duplicate and low-quality observations from accumulating. However, the T726 council audit (Lead C report at `.cleo/agent-outputs/T726-council-extraction.md`) discovered 11 confirmed gaps where the pipeline either had dead code, bypassed the gate, or was silently no-oping in production.

The most critical gaps (P0):

- **GAP-1**: `runSleepConsolidation()` was orphaned — exported but never called from any hook or production path. The 4-step LLM sleep pipeline (merge-duplicates, prune-stale, strengthen-patterns, generate-insights) never executed.
- **GAP-2**: LLM extraction path in `llm-extraction.ts:storeExtracted()` called `storeLearning`/`storePattern`/`storeDecision` directly — bypassing `verifyCandidate()` entirely. LLM-extracted memories accumulated with zero dedup gating.
- **GAP-3**: `hashDedupCheck()` only queried `brain_observations`. `brain_decisions`, `brain_patterns`, `brain_learnings` had `contentHash` columns but they were never deduplication-checked.

Significant gaps (P1):

- **GAP-4**: `detectSupersession()` was never called automatically from any store function.
- **GAP-5**: `detectSupersession()` used keyword-only Jaccard similarity despite a comment promising sqlite-vec embedding branch.
- **GAP-6**: Observer only fired on task completion when count >= threshold (default 10). Sessions with < 10 observations never got compression.
- **GAP-7**: Reflector's `markSuperseded()` set `invalid_at` but wrote no `supersedes` graph edges from the new patterns/learnings back to the source observations.

### 1.2 Scope of This ADR

This ADR documents:

1. The canonical 7-step gated pipeline (target state)
2. Gap remediation decisions for T726 Wave 1E subtasks
3. LLM model tier choices (owner-locked Q4 and Q5 answers)
4. D008 7-technique mapping after Wave 1E implementation
5. Anti-patterns that are explicitly prohibited going forward

---

## 2. Decision

### 2.1 All Memory Writes MUST Route Through verifyAndStore()

The single most important decision: **all memory write paths from extraction pipelines MUST use `verifyAndStore()`**. Direct calls to `storeLearning`, `storePattern`, `storeDecision`, or `observeBrain` from automated extraction pipelines are PROHIBITED.

The gate (`extraction-gate.ts:verifyAndStore()`) is the canonical enforcement point for:
- SHA-256 content-hash deduplication
- Embedding cosine similarity deduplication (sqlite-vec when available)
- Confidence threshold enforcement (minimum 0.40)
- Contradiction detection (polarity-flip heuristic)

**Rationale**: When extraction pipelines bypass the gate (GAP-2), duplicate LLM-extracted memories accumulate unboundedly. The gate is cheap (hash check is O(1)) and always safe to apply. The cost of bypassing it is permanent noise growth in brain.db.

### 2.2 detectSupersession Auto-Fire Gate (T738)

`detectSupersession()` MUST be called post-write for `storeLearning`, `storePattern`, and `storeDecision`. However, to avoid false positive supersession chains from low-confidence writes:

**Rule**: Auto-fire `detectSupersession()` only when `sourceConfidence` is `'owner'` or `'task-outcome'`. Writes with `'agent'` or `'speculative'` confidence rely on sleep-consolidation dedup instead.

**Rationale** (T726-council-extraction.md §4 Q4, Option B): Auto-firing on every store would cause agent-confidence writes (the majority) to produce false supersession chains where valid observations incorrectly mark each other as superseded. The conservative gate prevents noise while still catching high-confidence contradictions immediately.

### 2.3 detectSupersession sqlite-vec ANN Branch (T739)

`detectSupersession()` MUST use sqlite-vec ANN query as the primary similarity path when `isBrainVecLoaded()` is true. The combined score is `max(embeddingSimilarity, keywordJaccard)` so the most informative signal wins.

**Implementation**: When sqlite-vec is available, run `SELECT id, distance FROM brain_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 50` with the new entry's text embedded. Convert cosine distance to similarity as `max(0, 1 - distance/2)`. Compare max score against `KEYWORD_OVERLAP_THRESHOLD` (0.8).

**Rationale**: Keyword Jaccard misses semantic similarity between entries that express the same concept with different vocabulary. sqlite-vec is already loaded (brain-sqlite.ts), so the ANN query has no additional dependency cost.

### 2.4 Reflector Supersedes Graph Edges (T742)

`runReflector()` MUST write `supersedes` graph edges from each newly stored pattern/learning to each superseded observation ID in `brain_page_edges`. Currently `markSuperseded()` sets `invalid_at` but writes no edges, breaking temporal chain traversal.

**Implementation**: After `storePattern()` and `storeLearning()` calls in the reflector, collect the returned IDs. After `markSuperseded()`, call `addGraphEdge()` for each `(newNodeId, 'observation:' + obsId, 'supersedes')` pair.

**Rationale**: The supersession graph must be bidirectionally traversable via `getSupersessionChain()`. Without edges, the reflector's output has no causal link to the observations it synthesized.

### 2.5 Session-End Observer Hook (T740)

`runObserver()` MUST fire at every session end, unconditionally. This is implemented by adding a new session hook at priority 4.5 (between consolidation at 5 and reflector at 4) that calls `runObserver()` with `thresholdOverride: 1`.

**Rationale**: Sessions with fewer than 10 observations (the default threshold) never got compression. The reflector reads observations expecting compressed + raw forms; without compression, short sessions produce poor reflector output. Firing Observer first ensures reflector gets the best input regardless of session length.

### 2.6 LLM Model Tier Choices (Owner-Locked Q4)

Per the spec (`docs/specs/memory-architecture-spec.md §7`) with owner override:

| Component | Model | Notes |
|-----------|-------|-------|
| Observer | `claude-haiku-4-5` (configurable via `brain.observer.model`) | Compression is mechanical; Haiku adequate |
| Reflector | `claude-haiku-4-5` default, `brain.reflector.model` config override | Synthesis; Sonnet via override |
| Transcript extraction (warm) | Ollama + Gemma 4 E2B (auto-installed via postinstall script) | Local, no API cost |
| Transcript extraction (cold) | `claude-sonnet-4-6` | Owner-specified: always Sonnet for cold path |
| Fallback chain | Ollama → transformers.js → Sonnet → skip | Graceful degradation |

**Rationale**: Owner specified Sonnet for the cold extraction path (T726 council Q4, Option C overridden to: warm=local Ollama, cold=Sonnet). Sonnet provides the highest quality extraction for cold sessions where local model is unavailable.

### 2.7 Transcript GC Automation (Owner-Locked Q5)

Hybrid mode (Option C) is the owner-locked answer:
- Automatic extraction (non-destructive) nightly via `node-cron v4` sidecar daemon
- Require explicit `--confirm` flag for file deletion
- Daemon managed via `cleo daemon start/stop/status`
- GC thresholds: 70/85/90/95% (per ADR-047)

---

## 3. The 7-Step Gated Pipeline (Target State)

```
RAW INPUT (observation, decision, pattern, learning, transcript)
  │
  ▼
[0] Write-Time Gate (verifyAndStore — ALL paths MUST use this)
    A. SHA-256 hash dedup (all 4 tables, not just observations) [T737]
    B. Embedding cosine dedup (sqlite-vec when available)
       → similarity > 0.9: increment citationCount, return existing ID
       → similarity 0.7-0.9: store new, create 'related' edge
    C. Confidence threshold >= 0.40
    D. Supersession check (only for sourceConfidence='owner'|'task-outcome') [T738]
       → Combined score (max of embedding + Jaccard) > 0.8
       → mark old invalid_at, create 'supersedes' edge [T739]
  │
  ▼
[1] Quality Scoring (at write time)
    sourceConfidence multiplier: owner=1.0, task-outcome=0.90, agent=0.70, speculative=0.40
    Content richness: length, specificity, task linkage
    Tier bonus: short=0.0, medium=+0.05, long=+0.10
  │
  ▼
[2] Initial Tier Assignment
    Default: 'short'
    Override: sourceConfidence='owner' with explicit decision/learning → 'medium'
  │
  ▼
[3] Embedding Queue (async, non-blocking)
    Enqueue for all-MiniLM-L6-v2 embedding
    Write to brain_embeddings vec0 table when computed
  │
  ▼

SESSION-END PIPELINE (sequential, priority-ordered):
  Priority 100: LLM Extraction Gate (setImmediate deferred)
    → extractFromTranscript via llm-extraction.ts
    → route through verifyAndStore() [T736 — to be wired]

  Priority 10: Database Backup
    → vacuumIntoBackupAll

  Priority 5: runConsolidation() [existing 12-step pipeline]
    + Step 10: runSleepConsolidation() [T734 — wires orphaned sleep pipeline]

  Priority 4.5: runObserver() [T740 — unconditional, thresholdOverride=1]
    → compress ≥1 observations → observer-compressed entries

  Priority 4: runReflector() [existing + T742 supersedes edge fix]
    → synthesize patterns+learnings from compressed+raw observations
    → addGraphEdge() for each (newEntry → supersededObs)

  Priority 3: transcript_pending_extraction record write [T732]
```

---

## 4. D008 7-Technique Status After Wave 1E

| # | Technique | Status |
|---|-----------|--------|
| 1 | LLM Extraction Gate at session end | SHIPPED (P0 gap: getTranscript path — T729 pending) |
| 2 | Write-time dedup with embedding similarity | PARTIAL → T736/T737 fix hash dedup for all tables |
| 3 | Observer/Reflector (3-6x compression) | SHIPPED + T740 (unconditional session-end hook) + T742 (supersedes edges) |
| 4 | Temporal supersession with pointers | SHIPPED + T738 (auto-fire gate) + T739 (sqlite-vec ANN) |
| 5 | Graph memory bridge (BRAIN↔NEXUS) | SHIPPED (runs at consolidation time; write-time bridge pending) |
| 6 | Sleep-time consolidation | PARTIAL → T734 wires orphaned `runSleepConsolidation()` |
| 7 | Reciprocal Rank Fusion for retrieval | SHIPPED (brain-reasoning.ts hybrid search) |

---

## 5. Files Modified by T726 Wave 1E

| File | Change |
|------|--------|
| `packages/core/src/memory/temporal-supersession.ts` | T739: sqlite-vec ANN branch in detectSupersession |
| `packages/core/src/memory/learnings.ts` | T738: gate detectSupersession to owner/task-outcome only |
| `packages/core/src/memory/patterns.ts` | T738: gate detectSupersession to owner/task-outcome only |
| `packages/core/src/memory/observer-reflector.ts` | T742: supersedes edges from reflector; T740: thresholdOverride param |
| `packages/core/src/hooks/handlers/session-hooks.ts` | T740: session-end Observer hook at priority 4.5 |
| `packages/core/src/internal.ts` | T745: export runObserver/runReflector for CLI |
| `packages/cleo/src/cli/commands/memory-brain.ts` | T745: cleo memory reflect + cleo memory dedup-scan commands |
| `docs/specs/memory-architecture-spec.md` | Lock §7 §8 §13 with owner Q4/Q5 answers |

---

## 6. Prohibited Anti-Patterns

The following patterns are explicitly PROHIBITED going forward:

1. **Bypassing verifyAndStore**: Never call `storeLearning()`, `storePattern()`, or `storeDecision()` from automated extraction pipelines without routing through the gate.
2. **Unconditional detectSupersession**: Never fire `detectSupersession()` for `'agent'` or `'speculative'` confidence writes — it causes noise chains.
3. **Orphaned async functions**: Any function in the memory pipeline that is `export`ed but never called from a hook or production path MUST be wired before the epic is marked complete.
4. **Silent threshold blocking**: The Observer MUST NOT silently return `empty` at session end. Use `thresholdOverride: 1` at session end to ensure compression always runs.

---

## 7. Consequences

### 7.1 Positive

- Dedup coverage extends to all 4 brain tables (decisions, patterns, learnings, observations)
- Every session end produces Observer compression + Reflector synthesis
- Supersession chains are fully traversable via `getSupersessionChain()`
- sqlite-vec embedding similarity in supersession detection catches semantic duplicates that keyword Jaccard misses

### 7.2 Negative / Costs

- Session-end pipeline now makes 2 additional LLM calls (Observer + Reflector) — costs ~$0.0004/session with Haiku. Acceptable for the quality gain.
- `detectSupersession()` with sqlite-vec does a KNN query on every high-confidence write — adds ~5-15ms per write when embeddings are available.

### 7.3 Neutral

- All changes are additive and idempotent — existing brain.db data is not modified by Wave 1E changes.
- The gate `verifyAndStore()` is already battle-tested; extending its coverage is low risk.

---

## 8. Acceptance Criteria (T726 Wave 1E)

| ID | Criterion | Task |
|----|-----------|------|
| W1E-1 | `detectSupersession()` calls `brain_embeddings` KNN query when `isBrainVecLoaded()` returns true | T739 |
| W1E-2 | `storePattern()` with `sourceConfidence='agent'` does NOT call `detectSupersession()` | T738 |
| W1E-3 | `storePattern()` with `sourceConfidence='owner'` DOES call `detectSupersession()` | T738 |
| W1E-4 | `runReflector()` writes `supersedes` edges in `brain_page_edges` after `markSuperseded()` | T742 |
| W1E-5 | `runObserver()` runs at session end for sessions with 0-9 observations | T740 |
| W1E-6 | `cleo memory reflect` triggers Observer + Reflector and reports results | T745 |
| W1E-7 | `cleo memory dedup-scan` reports hash-duplicate counts per table | T745 |
| W1E-8 | ADR written and linked from `docs/specs/memory-architecture-spec.md §17` | T749 |
| W1E-9 | `pnpm biome check --write .` passes; `pnpm run build` passes; zero new test failures | All |

---

*This ADR is authoritative for T726 Wave 1E implementation. See `docs/specs/memory-architecture-spec.md` for the full epic spec.*
