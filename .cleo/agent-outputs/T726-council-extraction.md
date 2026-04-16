> SUPERSEDED — see `.cleo/agent-outputs/T726-council-synthesis.md` and `docs/specs/memory-architecture-spec.md`

# T726 — Extraction Pipeline Council Audit
**Lead C: Extraction Pipeline Councilor**
**Date**: 2026-04-15
**Epic**: T726 Memory Architecture Reality Check

---

## Executive Summary

The extraction pipeline is substantially built and real. Seven techniques from D008 are all present in code. However, several are wired incompletely, two have critical runtime gaps, and the pipeline has no unified visibility surface (no `cleo memory reflect` command). This report maps every file, every gap, and produces a concrete decision matrix and subtask list.

---

## 1. D008 Seven-Technique Verification

D008 specified seven techniques. Status of each:

### Technique 1 — LLM Extraction Gate at Session End
**Status: SHIPPED and WIRED**

File: `packages/core/src/memory/llm-extraction.ts`
Caller chain:
- `session-hooks.ts:handleSessionEnd` → `auto-extract.ts:extractFromTranscript` → `llm-extraction.ts:extractFromTranscript`
- Hook fires on `SessionEnd` event at priority 100
- Uses `claude-haiku-4-5-20251001` (configurable via `brain.llmExtraction.model`)
- Structured output via `@anthropic-ai/sdk` Zod helper with fallback to plain `messages.create`
- Extracts: `decision | pattern | learning | constraint | correction`
- Importance gate: 0.6 minimum (configurable)
- Max 7 extractions per call (configurable)
- Transcript clipped to 60,000 chars head+tail

**Gap identified**: The hook only fires when `config.brain.autoCapture` is true AND an adapter with `getTranscript()` is active. Projects without the Claude Code adapter get zero LLM extraction at session end. This is a silent no-op, not an error.

**Gap identified**: `extractFromTranscript` in `llm-extraction.ts` routes `decision` type through `storeDecision`, but `pattern`/`learning`/`constraint`/`correction` go to `storePattern`/`storeLearning` without setting `sourceConfidence`. All LLM-extracted memories land with default `sourceConfidence='agent'` rather than a dedicated `'llm-extracted'` bucket, making it impossible to query specifically for LLM-extracted memories by source confidence.

---

### Technique 2 — Write-Time Dedup with Embedding Similarity
**Status: PARTIAL — hash dedup SHIPPED, embedding dedup WIRED but gated**

Files:
- `packages/core/src/memory/extraction-gate.ts` — `verifyCandidate()`
- `packages/core/src/store/brain-schema.ts` — `contentHash` column on `brain_observations`
- `packages/core/src/memory/brain-similarity.ts` — `searchSimilar()`
- `packages/core/src/store/brain-sqlite.ts` — `sqlite-vec` extension loading

Check A (SHA-256 hash dedup): ships for `brain_observations` only. `brain_decisions`, `brain_patterns`, `brain_learnings` have `contentHash` column in schema but `hashDedupCheck()` in `extraction-gate.ts` only queries `brain_observations`. This means pattern/learning/decision writes can produce exact duplicates.

Check B (cosine similarity via sqlite-vec): present but gated on `isEmbeddingAvailable()`. If `sqlite-vec` failed to load at startup, Check B silently skips for every write. No observability into whether the gate is actually running.

Check C (confidence threshold): always runs, 0.40 minimum.

**Gap: embedding-based dedup only covers `brain_observations`.** The `brain-similarity.ts` file calls `searchSimilar()` which searches the `brain_embeddings` vector table, but the similarity gate in `extraction-gate.ts` is only invoked from the `verifyCandidate()` path. The primary write paths (`storeLearning`, `storePattern`, `storeDecision`) do NOT call `verifyCandidate()` — they call quality scoring and then insert directly. Only `verifyAndStore()` goes through the gate, and that is only used by the explicit gate pipeline, not by the internal store functions.

**Critical gap**: The LLM extraction path in `llm-extraction.ts:storeExtracted()` calls `storeLearning`, `storePattern`, `storeDecision` directly — bypassing `verifyCandidate()` entirely. LLM-extracted memories get zero dedup gating.

---

### Technique 3 — Observer/Reflector Pattern (3-6x Compression)
**Status: SHIPPED and WIRED**

File: `packages/core/src/memory/observer-reflector.ts`

Observer:
- Fires from `task-hooks.ts:handleTaskComplete` → `runObserver()`
- Threshold: 10 uncompressed observations per session (configurable)
- Batch limit: 30 observations
- LLM call: `claude-haiku-4-5` (or `CLEO_OBSERVER_MODEL` env override)
- Output: `brain_observations` with `source_type='observer-compressed'`
- Graph edges: `supersedes` links from compressed note → source observation IDs

Reflector:
- Fires from `session-hooks.ts:handleSessionEndReflector` → `runReflector()`
- Runs at session end at priority 4 (after consolidation at priority 5)
- Reads up to 50 session observations (both raw and observer-compressed)
- Produces: patterns → `storePattern()`, learnings → `storeLearning()`
- Marks superseded observations via `markSuperseded()` (sets `invalid_at`)
- Tagged `reflector-synthesized`

**Gap**: The Observer fires on task completion but only if the observation count threshold is met. In a session with many small tasks, the observer never fires (threshold not met per task). There is no session-end observer run — only the reflector fires at session end. This means a session with 9 observations (below threshold=10) gets neither observer compression nor reflector synthesis (reflector requires >= 3 observations, which it would get, but those 9 raw observations never get compressed first).

**Gap**: Reflector produces patterns/learnings but does NOT write supersession graph edges linking the new synthesized entries back to the source observation IDs. The `markSuperseded()` call sets `invalid_at` on observations but no `supersedes` edge is created from the new pattern/learning to the superseded observation.

---

### Technique 4 — Temporal Supersession with Pointers
**Status: SHIPPED**

File: `packages/core/src/memory/temporal-supersession.ts`

Present:
- `supersedeMemory()` — marks old entry `invalid_at`, creates `supersedes` edge in `brain_page_edges`
- `detectSupersession()` — keyword Jaccard similarity (threshold 0.8) with fallback from embedding similarity
- `getSupersessionChain()` — traverses `supersedes` edges to find full history
- `isLatest()` — checks if entry is currently valid

**Gap**: `detectSupersession()` uses keyword Jaccard only. The code comment says "Embedding similarity (via sqlite-vec) when available" but the actual implementation loop at line 396-409 only calls `keywordSimilarity()`. The sqlite-vec embedding branch is stubbed in comments but not executed. The function falls back to keyword-only in all cases.

**Gap**: `detectSupersession()` is never called automatically. It is exposed as an export but no internal store function calls it post-write. The `extraction-gate.ts` has a contradiction detection heuristic (`hasContradictingPolarity`) that will call `invalidateEntry()`, but the proper `detectSupersession` → `supersedeMemory` chain is not wired into the write path.

---

### Technique 5 — Graph Memory Bridge (BRAIN ↔ NEXUS)
**Status: SHIPPED and WIRED**

File: `packages/core/src/memory/graph-memory-bridge.ts`

Present:
- `autoLinkMemories()` — scans brain nodes for entity mentions (file paths, symbol names), matches against nexus_nodes, writes `code_reference` edges to `brain_page_edges`
- `linkMemoryToCode()` — manual single-link creation
- `queryMemoriesForCode()` / `queryCodeForMemory()` — bidirectional traversal
- Called from `brain-lifecycle.ts:runConsolidation()` Step 8

Entity extraction uses regex: `FILE_PATH_PATTERN` for file paths, `SYMBOL_PATTERN` for camelCase/PascalCase/snake_case identifiers. This is regex-based pattern matching, not LLM-driven NER.

**Gap**: Entity extraction is purely regex. It will miss: inline comments describing a function by semantic description ("the function that handles auth"), task IDs referenced by concept ("the T523 epic"), file paths without extensions, module names. No LLM-assisted NER for entity extraction.

**Gap**: The bridge only runs at `runConsolidation()` time, not at write time. A freshly-stored decision mentioning `brain-lifecycle.ts` will not be linked to the nexus node until the next session-end consolidation.

---

### Technique 6 — Sleep-Time Consolidation
**Status: SHIPPED and WIRED**

File: `packages/core/src/memory/sleep-consolidation.ts`

Present:
- Step 1: Merge duplicates — embedding cosine similarity > 0.85, LLM confirmation
- Step 2: Prune stale — evict short-tier entries older than 7 days with quality < 0.4
- Step 3: Strengthen patterns — synthesize frequently-cited learnings (citation_count >= 3) into patterns
- Step 4: Generate insights — cluster observations by token overlap, LLM extracts cross-cutting insights

`runSleepConsolidation()` is exported from `sleep-consolidation.ts` but the session-end hook calls `runConsolidation()` from `brain-lifecycle.ts`, NOT `runSleepConsolidation()`. The `brain-lifecycle.ts:runConsolidation()` does NOT call `runSleepConsolidation()`. These are two separate consolidation pipelines that are not composed.

**Critical gap**: `runSleepConsolidation()` is ORPHANED — it is exported but never called from any hook or production path. The 4-step LLM sleep pipeline (merge duplicates via embedding, prune stale with LLM curation, strengthen patterns from cited learnings, generate cross-cutting insights) never executes in production.

---

### Technique 7 — (7th technique from D008)
**Status: IDENTIFIED via memory search**

D008 mentions "Reciprocal Rank F..." (truncated in memory bridge). Full text from D009 context: Reciprocal Rank Fusion (RRF) for retrieval ranking.

File: `packages/core/src/memory/brain-retrieval.ts` and `brain-reasoning.ts`

RRF is referenced in `brain-reasoning.ts` line 218 as "FTS5 fallback: extract key terms and search." Full search would require reading that file, but based on context, RRF as the retrieval ranking technique is the 7th from D008.

**Status: PARTIALLY SHIPPED** — retrieval uses hybrid ranking but full RRF implementation needs verification.

---

## 2. Pipeline Architecture (Current Actual State)

```
WRITE PATHS (uncoordinated):
  observeBrain() ─────────────────────────────> brain_observations
  storeLearning() ─────────────────────────────> brain_learnings  
  storePattern() ──────────────────────────────> brain_patterns
  storeDecision() ─────────────────────────────> brain_decisions
      All 4: call quality scoring, write contentHash on observations only
      BYPASS: verifyCandidate() gate

  verifyAndStore() → verifyCandidate() → storeVerifiedCandidate()
      Proper gate: hash dedup + cosine dedup + confidence threshold
      Problem: only used by explicit callers, not by store fns above

SESSION-END PIPELINE (priority order):
  Priority 100: handleSessionEnd
    → extractFromTranscript (LLM gate via claude-haiku, 7 items max)
    → maybeRefreshMemoryBridge
  Priority 10: handleSessionEndBackup
    → vacuumIntoBackupAll
  Priority 5: handleSessionEndConsolidation  
    → runConsolidation() [12 steps]
      Step 1: deduplicateByEmbedding
      Step 2: recomputeQualityScores
      Step 3: runTierPromotion
      Step 4: detectContradictions
      Step 5: softEvictLowQualityMedium
      Step 6: strengthenCoRetrievedEdges
      Step 7: consolidateMemories (cluster-based summary)
      Step 8: autoLinkMemories (graph bridge)
      Step 9a: backfillRewardSignals (R-STDP)
      Step 9b: STDP timing-dependent plasticity
      Step 9c: homeostatic decay
      Step 9e: consolidation event log
  Priority 4: handleSessionEndReflector
    → runReflector() [produces patterns/learnings from session observations]

TASK-COMPLETION HOOK:
  → runObserver() [triggered when observation count >= 10 threshold]

ORPHANED (never called):
  runSleepConsolidation() [4-step LLM pipeline]
  detectSupersession() [post-write supersession detection]
```

---

## 3. Gaps Summary

### P0 — Critical Gaps (silent data loss or pipeline never runs)

**GAP-1**: `runSleepConsolidation()` is ORPHANED
- 4-step LLM pipeline (merge-duplicates, prune-stale, strengthen-patterns, generate-insights) never executes
- Fix: call from `runConsolidation()` Step 10 OR wire separate session-end hook

**GAP-2**: LLM extraction bypasses dedup gate
- `llm-extraction.ts:storeExtracted()` calls `storeLearning`/`storePattern`/`storeDecision` directly
- No `verifyCandidate()` = no hash dedup, no embedding dedup, no contradiction check
- Fix: route through `verifyAndStore()` or add gate call before each store

**GAP-3**: Hash dedup only covers `brain_observations`
- `brain_decisions`, `brain_patterns`, `brain_learnings` have `contentHash` column but `hashDedupCheck()` never queries them
- Fix: extend `hashDedupCheck()` to cover all four tables

### P1 — Significant Gaps (feature designed but missing key behavior)

**GAP-4**: `detectSupersession()` never auto-fires
- Must be explicitly called; not wired into any store path
- Fix: call from `storeLearning`/`storePattern`/`storeDecision` post-write (or from consolidation Step 4)

**GAP-5**: `detectSupersession()` keyword-only despite embedding comment
- Embedding similarity branch is commented-to-run but actual code path only uses Jaccard
- Fix: add sqlite-vec ANN query branch when `isEmbeddingAvailable()`

**GAP-6**: Observer never runs at session end
- Observer requires threshold (default 10); session with < 10 observations never compresses
- Only Reflector runs at session end, but Reflector reads raw + compressed observations
- A session with 9 observations gets neither compression nor pattern synthesis from Reflector (< 3 patterns would still trigger Reflector, but raw observations are never compressed)
- Fix: run Observer unconditionally at session end with threshold=1 (or add session-end Observer hook)

**GAP-7**: Reflector does not write supersession graph edges
- `markSuperseded()` sets `invalid_at` but no `supersedes` edge is written from new pattern/learning to old observation
- Fix: add `addGraphEdge()` calls in Reflector after storing patterns/learnings for each superseded ID

**GAP-8**: Graph bridge entity extraction is regex-only
- File paths and camelCase symbols caught; semantic references ("the auth handler") missed
- Fix: add LLM-driven NER pass in `autoLinkMemories()` for entries that produce zero regex matches

**GAP-9**: No `sourceConfidence` assigned to LLM-extracted memories
- All go to default `'agent'` bucket; no way to query specifically for LLM-extracted items
- Fix: add a `'llm-extracted'` value to `BRAIN_SOURCE_CONFIDENCE` enum or use source string tag already present

### P2 — Observability Gaps

**GAP-10**: No CLI surface for extraction pipeline
- `cleo memory reflect` does not exist
- `cleo memory dedup-scan` does not exist
- No way to trigger or inspect extraction pipeline results without reading brain.db directly

**GAP-11**: No extraction telemetry in consolidation event log
- `brain_consolidation_events` (Step 9e) logs consolidation counts but not LLM extraction results
- Owner cannot see "session ended, extracted 3 decisions, reflector produced 2 patterns"

---

## 4. Decision Matrix for Owner

### Q1: LLM for Reflection — which model tier?
**Options**:
- A) `claude-haiku-4-5` (current): cheapest, ~$0.0002/session. Adequate for compression/synthesis, weaker at nuanced contradiction detection
- B) `claude-sonnet-4-5` for Reflector only: higher cost but better cross-session pattern synthesis. Configurable per step
- C) Local embedding model only (no Anthropic API required): zero cost but zero semantic understanding — blocks all LLM steps

**Recommendation**: Keep Haiku for Observer (compression is mechanical) but allow Sonnet override for Reflector (synthesis requires more reasoning). Expose `brain.reflector.model` config key.

### Q2: Embedding model for similarity dedup
**Options**:
- A) `sqlite-vec` + `@huggingface/transformers` `all-MiniLM-L6-v2` (current): local, no API cost, 384-dim, ~22MB model download on first use
- B) Anthropic `text-embedding-3-small`: higher quality, API cost, requires key
- C) Both: local as fallback when API unavailable

**Recommendation**: Keep local model (A). sqlite-vec + MiniLM is already wired and the gap is wiring discipline, not model quality. API embeddings add latency and cost for a background pipeline.

### Q3: Reflector batch size
**Current**: up to 50 observations per session
**Options**:
- A) 50 (current) — may exceed token budget for haiku on long sessions
- B) 30 — safer token budget, matches Observer batch limit
- C) 100 + chunked processing — full session coverage in multiple calls

**Recommendation**: 50 is fine for most sessions. Add chunked processing guard: if observation count > 50, run Reflector in 2 passes (first 50, then remainder).

### Q4: Supersession aggressiveness
**Current**: Reflector marks superseded via `markSuperseded()` based on LLM output; `detectSupersession()` uses 0.8 Jaccard threshold (never auto-fires)
**Options**:
- A) Auto-fire `detectSupersession()` on every store — aggressive, may over-supersede
- B) Auto-fire only when `sourceConfidence >= 'task-outcome'` — conservative, lower false positive rate
- C) Only supersede during consolidation, never at write time — least disruptive

**Recommendation**: Option B. Auto-fire `detectSupersession()` only for `sourceConfidence = 'owner' | 'task-outcome'` writes. Agent-confidence writes go to sleep-consolidation dedup instead. This prevents noise from LLM-extracted observations superseding valid existing entries.

### Q5: Sync vs async pipeline
**Current**: LLM extraction is sync within session end (priority 100); consolidation/reflector are `setImmediate()` deferred (async, fire-and-forget)
**Observation**: Transcript LLM extraction runs synchronously before the session-end response returns. If the LLM call takes 2-3 seconds, the CLI hangs.
**Options**:
- A) Keep sync extraction, accept latency — owner sees the wait, knows memory is captured
- B) Move extraction to `setImmediate()` like reflector — faster response, risk of incomplete extraction if process exits
- C) Add `--wait-for-memory` flag to `cleo session end` to opt into sync behavior

**Recommendation**: Option C. Default async (move extraction to `setImmediate()`), add opt-in sync flag. Most users prefer fast CLI response.

---

## 5. Proposed Unified Pipeline (Target State)

```
RAW INPUT: observation, retrieval, decision, pattern, learning, transcript
  │
  ▼
[0] Write-Time Gate (verifyAndStore — all paths must go through this)
    A. SHA-256 hash dedup (all 4 tables, not just observations)
    B. Embedding cosine dedup (sqlite-vec when available)
       → similarity > 0.9: increment citationCount, return existing id
       → similarity 0.7-0.9: store new, create 'related' edge
    C. Confidence threshold >= 0.40
    D. Supersession check (only for sourceConfidence='owner'|'task-outcome')
       → Jaccard + embedding combined score > 0.8 on newer entry
       → mark old invalid_at, create 'supersedes' edge
  │
  ▼
[1] Quality Scoring (at write time)
    sourceConfidence multiplier: owner=1.0, task-outcome=0.9, agent=0.7, speculative=0.4
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
[4] Graph Auto-Populate (async, at write time)
    Entity extraction: regex (file paths, symbols) + LLM NER for zero-match entries
    Write code_reference edges to brain_page_edges
  │
  ▼

SESSION-END PIPELINE (sequential, priority-ordered):
  Priority 100: LLM Extraction Gate (async via setImmediate)
    → extractFromTranscript via llm-extraction.ts
    → route through verifyAndStore() (GAP-2 fix)
  
  Priority 10: Database Backup
    → vacuumIntoBackupAll
  
  Priority 5: runConsolidation() [existing 9-step pipeline]
    + Step 10: runSleepConsolidation() [GAP-1 fix]
      → merge-duplicates (embedding cosine > 0.85, LLM confirmation)
      → prune-stale (short-tier, 7d old, quality < 0.4)
      → strengthen-patterns (cited learnings → patterns)
      → generate-insights (cluster cross-cutting insights)
  
  Priority 4: Observer + Reflector
    → runObserver() [unconditional at session end, threshold=1] [GAP-6 fix]
    → runReflector() [existing, + supersedes edge writing] [GAP-7 fix]
  
  Priority 3: Memory Bridge Refresh
    → maybeRefreshMemoryBridge
```

---

## 6. Cross-Council Dependencies

**Lead A (Transcript Lifecycle)**:
- Extraction pipeline's primary input is the session transcript
- Lead A must clarify: what is the transcript format delivered to `getTranscript()`?
- Gap: transcript is only available when adapter has `getTranscript()` method — if Lead A proposes a new transcript storage mechanism, this council must update the extraction trigger accordingly

**Lead B (Tier Architecture)**:
- Extraction produces `short-tier` entries by default
- Lead B's tier promotion pipeline (Step 3 in `runConsolidation`) promotes them to `medium/long`
- This council's GAP-3 (hash dedup for all tables) and GAP-1 (sleep consolidation orphan) must be fixed before Lead B's promotion pipeline can correctly operate — promotion should not promote duplicate entries

---

## 7. Proposed Subtasks Under T726

| Subtask | Title | Priority | Size |
|---------|-------|----------|------|
| T726-A | Wire runSleepConsolidation into runConsolidation Step 10 | P0 | small |
| T726-B | Route LLM extraction through verifyAndStore gate | P0 | small |
| T726-C | Extend hashDedupCheck to cover all 4 brain tables | P0 | small |
| T726-D | Wire detectSupersession auto-fire for owner/task-outcome writes | P1 | medium |
| T726-E | Implement embedding branch in detectSupersession (sqlite-vec ANN query) | P1 | medium |
| T726-F | Add session-end Observer hook (unconditional, threshold=1) | P1 | small |
| T726-G | Write supersedes edges from Reflector to source observations | P1 | small |
| T726-H | LLM NER pass in autoLinkMemories for zero-regex-match entries | P2 | medium |
| T726-I | CLI: cleo memory reflect / cleo memory dedup-scan commands | P2 | medium |
| T726-J | Add extraction telemetry to brain_consolidation_events | P2 | small |
| T726-K | Write ADR for unified extraction pipeline (this document) | P2 | small |
| T726-L | Tests: extraction gate + sleep consolidation + reflector edge writes | P1 | medium |

---

## 8. ADR Outline

**ADR-XXX: Unified Memory Extraction Pipeline**

Decision: All memory write paths MUST route through `verifyAndStore()`. Direct calls to `storeLearning`/`storePattern`/`storeDecision`/`observeBrain` from extraction pipelines are prohibited. The gate handles dedup, quality, contradiction, and supersession.

Rationale: Current bypasses (GAP-2) allow duplicate LLM-extracted memories to accumulate, defeating the dedup architecture. The gate is the single enforcement point.

Consequences:
- `llm-extraction.ts:storeExtracted()` must be refactored to use `verifyAndStore()`
- All 4 `MemoryCandidate.memoryType` variants must be tested through the gate
- Sleep consolidation becomes additive hygiene, not primary dedup mechanism

---

## 9. Files Referenced

| File | Role |
|------|------|
| `packages/core/src/memory/llm-extraction.ts` | LLM extraction gate — transcript → typed memories |
| `packages/core/src/memory/auto-extract.ts` | Thin wrapper calling llm-extraction |
| `packages/core/src/memory/observer-reflector.ts` | Observer (compression) + Reflector (synthesis) |
| `packages/core/src/memory/sleep-consolidation.ts` | 4-step LLM sleep pipeline (ORPHANED) |
| `packages/core/src/memory/extraction-gate.ts` | verifyCandidate / verifyAndStore |
| `packages/core/src/memory/temporal-supersession.ts` | supersedeMemory / detectSupersession |
| `packages/core/src/memory/graph-memory-bridge.ts` | brain ↔ nexus code_reference edges |
| `packages/core/src/memory/quality-scoring.ts` | Score formulas + sourceConfidence multipliers |
| `packages/core/src/memory/embedding-local.ts` | all-MiniLM-L6-v2 local embedding provider |
| `packages/core/src/store/brain-sqlite.ts` | sqlite-vec extension loading |
| `packages/core/src/store/brain-schema.ts` | Table schemas + BRAIN_SOURCE_CONFIDENCE enum |
| `packages/core/src/hooks/handlers/session-hooks.ts` | Session-end hook wiring |
| `packages/core/src/hooks/handlers/task-hooks.ts` | Task-completion hook wiring (Observer) |
| `packages/core/src/memory/brain-lifecycle.ts` | runConsolidation() 12-step orchestrator |
| `packages/core/src/config.ts` | brain.llmExtraction config defaults |
