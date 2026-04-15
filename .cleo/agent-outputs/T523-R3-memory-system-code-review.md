# T523-R3: Memory System Code Review

**Date**: 2026-04-11
**Task**: T523 — BRAIN Integrity + Cleo Memory SDK
**Researcher**: Research Explorer subagent
**Status**: complete

---

## 1. Architecture Diagram (Current State)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        CLEO BRAIN MEMORY SYSTEM                              │
│                                                                              │
│  AUTO-GENERATION TRIGGERS                                                    │
│  ┌─────────────────────────────────────────────────────────┐                │
│  │  tasks/complete.ts:293        → extractTaskCompletionMemory()            │
│  │  sessions/session-memory-bridge.ts:58 → extractSessionEndMemory()       │
│  │  hooks/handlers/session-hooks.ts:30   → handleSessionStart()            │
│  │  hooks/handlers/session-hooks.ts:54   → handleSessionEnd()              │
│  └──────────────────────┬──────────────────────────────────┘                │
│                         │                                                    │
│  WRITE PATH             ▼                                                    │
│  ┌─────────────────────────────────────────────────────────┐                │
│  │  memory/auto-extract.ts        (storeLearning/storePattern)             │
│  │  memory/brain-retrieval.ts     (observeBrain — main entry)              │
│  │  memory/session-memory.ts      (persistSessionMemory)                   │
│  │  memory/mental-model-queue.ts  (async agent-tagged queue)               │
│  └──────────────────────┬──────────────────────────────────┘                │
│                         │                                                    │
│  STORAGE LAYER          ▼                                                    │
│  ┌─────────────────────────────────────────────────────────┐                │
│  │  store/brain-sqlite.ts   (node:sqlite + drizzle wrapper)                │
│  │  brain.db                                                                │
│  │                                                                           │
│  │  ┌──────────────────────┐  ┌──────────────────────┐                     │
│  │  │ brain_patterns       │  │ brain_learnings       │                     │
│  │  │   2,467 rows         │  │   328 rows            │                     │
│  │  │   82 unique (96.7%   │  │   all task-completion │                     │
│  │  │   duplicates)        │  │   "Completed: X" fmt  │                     │
│  │  └──────────────────────┘  └──────────────────────┘                     │
│  │                                                                           │
│  │  ┌──────────────────────┐  ┌──────────────────────┐                     │
│  │  │ brain_observations   │  │ brain_decisions       │                     │
│  │  │   238 rows           │  │   5 rows              │                     │
│  │  │   session start/end  │  │   (test entries)      │                     │
│  │  │   manual observes    │  │                       │                     │
│  │  └──────────────────────┘  └──────────────────────┘                     │
│  │                                                                           │
│  │  ┌──────────────────────┐  ┌──────────────────────┐                     │
│  │  │ brain_page_nodes     │  │ brain_page_edges      │                     │
│  │  │   0 rows  [EMPTY]    │  │   0 rows  [EMPTY]     │                     │
│  │  └──────────────────────┘  └──────────────────────┘                     │
│  │                                                                           │
│  │  ┌──────────────────────┐  ┌──────────────────────┐                     │
│  │  │ brain_memory_links   │  │ brain_sticky_notes    │                     │
│  │  │   5 rows             │  │   7 rows              │                     │
│  │  └──────────────────────┘  └──────────────────────┘                     │
│  │                                                                           │
│  │  brain_embeddings: DOES NOT EXIST (vec0 table missing)                  │
│  └─────────────────────────────────────────────────────────┘                │
│                                                                              │
│  READ/SEARCH PATH                                                            │
│  ┌─────────────────────────────────────────────────────────┐                │
│  │  memory/brain-search.ts     (FTS5 + LIKE fallback)                      │
│  │  memory/brain-similarity.ts (vec0 KNN — non-functional)                 │
│  │  memory/brain-retrieval.ts  (3-layer: compact/timeline/fetch)           │
│  │  memory/brain-reasoning.ts  (reasonWhy + reasonSimilar)                 │
│  └─────────────────────────────────────────────────────────┘                │
│                                                                              │
│  DISPATCH LAYER                                                              │
│  ┌─────────────────────────────────────────────────────────┐                │
│  │  dispatch/engines/memory-engine.ts  (re-export only)                    │
│  │  memory/engine-compat.ts  (all engine functions)                        │
│  │  CLI: cleo memory find/fetch/observe/timeline/...                       │
│  └─────────────────────────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Table Schema Summary

### brain_decisions
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | D- prefix |
| type | TEXT enum | architecture/technical/process/strategic/tactical |
| decision | TEXT | Decision text |
| rationale | TEXT | |
| confidence | TEXT enum | low/medium/high |
| outcome | TEXT enum | success/failure/mixed/pending |
| alternatives_json | TEXT | JSON array |
| context_epic_id | TEXT | soft FK → tasks.db |
| context_task_id | TEXT | soft FK → tasks.db |
| context_phase | TEXT | |
| created_at | TEXT | |
| updated_at | TEXT | |

**Live count**: 5 rows (all test entries)

### brain_patterns
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | P- prefix hex |
| type | TEXT enum | workflow/blocker/success/failure/optimization |
| pattern | TEXT | Pattern description |
| context | TEXT | Auto-generated context |
| frequency | INTEGER | Always 1 — never incremented (BUG) |
| success_rate | REAL | |
| impact | TEXT enum | low/medium/high |
| anti_pattern | TEXT | |
| mitigation | TEXT | |
| examples_json | TEXT | JSON array of task IDs |
| extracted_at | TEXT | |
| updated_at | TEXT | |

**Live count**: 2,467 rows — 82 unique patterns — **96.7% duplicates**
Top noise: `Recurring label "epic" seen in 4 completed tasks` (177 copies)

### brain_learnings
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | L- prefix hex |
| insight | TEXT | Learning text |
| source | TEXT | e.g. task-completion:T123 |
| confidence | REAL | 0.0-1.0 |
| actionable | INTEGER | boolean |
| application | TEXT | |
| applicable_types_json | TEXT | JSON array |
| created_at | TEXT | |
| updated_at | TEXT | |

**Live count**: 328 rows — mostly `Completed: <task title>` auto-generated entries

### brain_observations
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | O- prefix |
| type | TEXT enum | discovery/change/feature/bugfix/decision/refactor |
| title | TEXT | |
| subtitle | TEXT | |
| narrative | TEXT | Full text body |
| facts_json | TEXT | JSON array (never populated) |
| concepts_json | TEXT | JSON array (never populated) |
| project | TEXT | |
| files_read_json | TEXT | JSON array (never populated) |
| files_modified_json | TEXT | JSON array (never populated) |
| source_session_id | TEXT | soft FK → sessions |
| source_type | TEXT enum | agent/session-debrief/claude-mem/manual |
| agent | TEXT | Wave 8 mental model provenance |
| content_hash | TEXT | SHA-256 prefix for dedup |
| discovery_tokens | INTEGER | (never populated) |
| created_at | TEXT | |
| updated_at | TEXT | |

**Live count**: 238 rows — mix of session start/end events and manual observes

### brain_page_nodes / brain_page_edges
**Live count**: 0 rows each — completely empty, never populated

### brain_memory_links
**Live count**: 5 rows (minimal real usage)

### brain_sticky_notes
**Live count**: 7 rows (functional)

### brain_embeddings (vec0 virtual table)
**Status**: DOES NOT EXIST in live brain.db — created only after `sqlite-vec` extension loads, which requires `sqlite-vec` npm package. Package is not installed (`find /mnt/projects/cleocode/node_modules -name "sqlite-vec*"` returns empty).

### FTS5 Virtual Tables
All four FTS5 tables exist and have row counts matching their parent tables:
- `brain_decisions_fts`: 5 rows
- `brain_patterns_fts`: 2,467 rows
- `brain_learnings_fts`: 328 rows
- `brain_observations_fts`: 238 rows

FTS5 content-sync triggers are created at search time (`ensureFts5Tables` in `brain-search.ts`), and a full rebuild runs on first search session (`rebuildFts5Index`). FTS5 search is **functional** for text matching.

---

## 3. NOISE SOURCE MAP

This is the definitive map of every code path that generates auto-extracted noise.

### Source 1: Task Completion → "Completed: X" Learnings
**File**: `packages/core/src/tasks/complete.ts`
**Lines**: 291-298
```typescript
// Line 292-295:
import('../memory/auto-extract.js')
  .then(({ extractTaskCompletionMemory }) =>
    extractTaskCompletionMemory(cwd ?? process.cwd(), task),
  )
```
**Calls**: `auto-extract.ts:extractTaskCompletionMemory()`

**File**: `packages/core/src/memory/auto-extract.ts`
**Lines**: 32-37 — PRIMARY NOISE SOURCE
```typescript
await storeLearning(projectRoot, {
  insight: `Completed: ${task.title} — ${task.description ?? ''}`,
  source: `task-completion:${task.id}`,
  confidence: 0.7,
  actionable: true,
});
```
**Effect**: Creates 1-2 learnings per task completion (2 if task has dependencies).

### Source 2: Task Completion → "Recurring label X" Patterns
**File**: `packages/core/src/memory/auto-extract.ts`
**Lines**: 50-84 — PRIMARY NOISE SOURCE (accounts for 2,463/2,467 patterns)

```typescript
// Lines 63-80:
for (const t of recentDone) {
  for (const label of t.labels ?? []) {
    const existing = labelCounts.get(label) ?? [];
    existing.push(t.id);
    labelCounts.set(label, existing);
  }
}

for (const [label, taskIds] of labelCounts.entries()) {
  if (taskIds.length >= 3) {
    await storePattern(projectRoot, {
      type: 'success',
      pattern: `Recurring label "${label}" seen in ${taskIds.length} completed tasks`,
      context: `Auto-detected from task completion of ${task.id}`,
      ...
    });
  }
}
```
**Effect**: EVERY task completion re-scans the last 50 done tasks and creates a new pattern for every label seen 3+ times. With no deduplication in `storePattern()`, this creates O(tasks × labels) duplicate patterns.

**Root Bug**: `patterns.ts:storePattern()` lines 66-78 detects duplicates but has a comment showing the dedup logic was never implemented:
```typescript
if (duplicate) {
  // We would ideally increment frequency here
  // However, accessor.addPattern handles inserts. Let's just insert it again or
  // we would need an update method on accessor.
  // For now, since accessor.updatePattern might not exist, we just insert.
}
// Create new entry (always)
```
The `if (duplicate)` block does **nothing** — falls through to always insert.

### Source 3: Session End → Workflow Patterns
**File**: `packages/core/src/memory/auto-extract.ts`
**Lines**: 119-139 — `extractSessionEndMemory()`

```typescript
for (const [label, taskIds] of labelCounts.entries()) {
  if (taskIds.length >= 2) {
    await storePattern(projectRoot, {
      type: 'workflow',
      pattern: `Session ${sessionData.sessionId} completed ${taskIds.length} tasks with label "${label}"`,
      ...
    });
  }
}
```
**Effect**: Creates workflow patterns per session per label (the 4 workflow patterns in the DB).

**Trigger chain**:
1. `cleo session end` → `sessions/session-memory-bridge.ts:bridgeSessionToMemory()` line 58
2. → `extractSessionEndMemory()` in `auto-extract.ts`

### Source 4: Session End → Decision + Per-Task Learnings
**File**: `packages/core/src/memory/auto-extract.ts`
**Lines**: 101-117 — `extractSessionEndMemory()`

```typescript
// Decision about session:
await storeDecision(projectRoot, {
  type: 'process',
  decision: `Session ${sessionData.sessionId} completed ${taskDetails.length} tasks: ...`,
  ...
});

// Per-task learnings (duplicates of Source 1):
for (const t of taskDetails) {
  await storeLearning(projectRoot, {
    insight: `Completed: ${t.title} — ${t.description ?? ''}`,
    source: `session-end:${sessionData.sessionId}`,
    ...
  });
}
```
**Effect**: Duplicate learnings (same `Completed: X` text, different source).

### Source 5: Session Start/End Hooks → Observations
**File**: `packages/core/src/hooks/handlers/session-hooks.ts`
**Lines**: 31-40, 61-68

```typescript
// Session start — lines 33-39:
await observeBrain(projectRoot, {
  text: `Session started: ${payload.name}\nScope: ...`,
  title: `Session start: ${payload.name}`,
  type: 'discovery',
  ...
});

// Session end — lines 62-67:
await observeBrain(projectRoot, {
  text: `Session ended: ${payload.sessionId}\nDuration: ...`,
  title: `Session end: ${payload.sessionId}`,
  type: 'change',
  ...
});
```
**Effect**: Creates 1 observation per session start + 1 per session end. These are **reasonable** (not noise), but add to observation count.

### Source 6: bridgeSessionToMemory → Duplicate Session Observation
**File**: `packages/core/src/sessions/session-memory-bridge.ts`
**Lines**: 48-55

```typescript
await observeBrain(projectRoot, {
  text: summary,   // "Session X ended. Scope: Y. Duration: Z min. Tasks: ..."
  title: `Session summary: ${sessionData.sessionId}`,
  type: 'change',
  ...
});
```
**Effect**: Creates a SECOND observation for session end (in addition to Source 5). Duplication.

### Source 7: persistSessionMemory → Session Debrief Observations
**File**: `packages/core/src/memory/session-memory.ts`
**Lines**: 84-133 — `extractMemoryItems()`

Creates observations for:
1. Each decision in debrief data
2. Session task summary observation
3. Session note (if present)

These are registered via `extractMemoryItems()` → `persistSessionMemory()`, called from session end hooks.

---

## 4. Dead Code Inventory

### 4.1 Partially-dead: `patterns.ts:storePattern()` Dedup Block
**File**: `packages/core/src/memory/patterns.ts`
**Lines**: 66-82

```typescript
const duplicate = existingPatterns.find(
  (e) => e.pattern.toLowerCase() === params.pattern.toLowerCase(),
);

if (duplicate) {
  // DEAD: this block intentionally does nothing
  // Comment says "we just insert" — falls through to always-insert
}
```
The duplicate check finds existing patterns but the block is empty. The code always falls through to insert a new row. This is the root cause of 2,467 patterns growing from 82 unique values.

### 4.2 Partially-dead: `learnings.ts:storeLearning()` Dedup Block
**File**: `packages/core/src/memory/learnings.ts`
**Lines**: 62-68

```typescript
const duplicate = existingLearnings.find(
  (e) => e.insight.toLowerCase() === params.insight.toLowerCase(),
);

if (duplicate) {
  // DEAD: same pattern as storePattern() — does nothing
}
```
Same issue. Duplicate detection runs but the dedup is never executed.

### 4.3 Dead: `brain_page_nodes` / `brain_page_edges` Tables
**File**: `packages/core/src/store/brain-schema.ts` lines 256-283
**File**: `packages/core/src/store/brain-accessor.ts` lines 424-567

Full CRUD implementation for graph nodes/edges exists. CLI commands (`memoryGraphAdd`, `memoryGraphShow`, `memoryGraphNeighbors`, `memoryGraphRemove`) all exist. But **0 rows** in either table — nothing ever populates the graph automatically. Manual `cleo memory graph.add` would work but is never called by any automated process.

### 4.4 Dead: `brain_embeddings` vec0 table
**File**: `packages/core/src/store/brain-sqlite.ts` lines 110-136

`loadBrainVecExtension()` and `initializeBrainVec()` exist and would create the table IF sqlite-vec was installed. But `sqlite-vec` is not in any package.json (confirmed: not installed). The table does not exist. All vector similarity code (`brain-similarity.ts`, `embedding-worker.ts`, `embedding-queue.ts`) is dead in practice.

### 4.5 Dead: `brain_observations` Structured Fields
**File**: `packages/core/src/store/brain-schema.ts` lines 167-170

`facts_json`, `concepts_json`, `files_read_json`, `files_modified_json` columns exist in the schema but are never populated by any write path. `discovery_tokens` is also never set.

### 4.6 Dead: `embedding-worker.ts` Worker Thread
**File**: `packages/core/src/memory/embedding-worker.ts`

Exists as a worker thread script for background embedding. Has no effect: sqlite-vec is not installed, so `brain_embeddings` table does not exist, so even if embeddings were generated there is nowhere to write them.

### 4.7 Vestigial: `auto-extract.ts:extractFromTranscript()`
**File**: `packages/core/src/memory/auto-extract.ts` lines 179-201

Called from session-hooks.ts line 92, but only when `config.brain?.autoCapture` is true AND an active adapter has a `getTranscript()` method. In practice no adapter implements this. Dead in production.

### 4.8 Dead: `session-memory.ts:buildSummarizationPrompt()` / `ingestStructuredSummary()`
**File**: `packages/core/src/memory/session-memory.ts` lines 244-347

`buildSummarizationPrompt()` builds a prompt for LLM summarization, and `ingestStructuredSummary()` ingests the result. Neither is called anywhere in the codebase except tests.

---

## 5. Working vs Broken Feature Matrix

| Feature | Status | Notes |
|---------|--------|-------|
| `cleo memory observe` | WORKING | Writes to brain_observations |
| `cleo memory find` | WORKING | FTS5 + LIKE fallback functional |
| `cleo memory fetch` | WORKING | Retrieves full entry by ID |
| `cleo memory timeline` | WORKING | Chronological neighbor lookup |
| `cleo memory show` | WORKING | Single entry by ID |
| `cleo memory decision.store` | WORKING | Inserts to brain_decisions |
| `cleo memory decision.find` | WORKING | LIKE search |
| `cleo memory pattern.store` | BROKEN | Dedup never executes — always inserts duplicate |
| `cleo memory learning.store` | BROKEN | Dedup never executes — always inserts duplicate |
| `cleo memory reason.similar` | BROKEN | Returns 0 results — sqlite-vec not installed, falls back to FTS5 but `reasonSimilar` only returns FTS hits when `vecResults.length > 0` is false (should work via FTS fallback, but vec path is taken first and fails gracefully) |
| `cleo memory reason.why` | WORKING | Causal trace through task deps |
| `cleo memory search.hybrid` | DEGRADED | FTS5 portion works; vec (40% weight) always skips; graph (10%) always skips (0 nodes) — effectively FTS5-only at reduced weight |
| `cleo memory graph.add` | WORKING (manual) | API functional, nothing populates it |
| `cleo memory graph.show` | WORKING (manual) | Returns empty |
| `cleo memory graph.neighbors` | WORKING (manual) | Returns empty |
| `cleo memory link` | WORKING | brain_memory_links inserts |
| `cleo memory unlink` | WORKING | brain_memory_links deletes |
| `cleo memory contradictions` | WORKING | Pattern-regex based |
| `cleo memory superseded` | WORKING | Grouping-based dedup detection |
| `cleo brain maintenance` | PARTIAL | Decay works; consolidation works (but rarely meaningful); embeddings step silently skips (no provider) |
| `memory-bridge.md` generation | WORKING | Outputs correct format, but patterns section is noise |
| Auto-capture on task complete | BROKEN | Creates noise (learning + pattern duplicates) |
| Auto-capture on session end | BROKEN | Creates duplicate observations + noise patterns |
| Embeddings (vector search) | DEAD | sqlite-vec not installed |
| Graph population (auto) | DEAD | No auto-population mechanism |

---

## 6. Embedding System Status

### The Embedding Pipeline (as designed):
1. `embedding-local.ts` — `LocalEmbeddingProvider` using `@huggingface/transformers` (all-MiniLM-L6-v2, 384-dim)
2. `brain-embedding.ts` — Provider registry (`setEmbeddingProvider`, `getEmbeddingProvider`, `embedText`)
3. `embedding-queue.ts` — Worker-thread-based async queue for non-blocking embedding
4. `brain-sqlite.ts` — `loadBrainVecExtension()` loads sqlite-vec, `initializeBrainVec()` creates vec0 table
5. `brain-similarity.ts` — `searchSimilar()` runs KNN against vec0 table
6. `brain-retrieval.ts:populateEmbeddings()` — Backfill pipeline for existing observations

### Why it doesn't work:
1. **sqlite-vec not installed**: `packages/core/package.json` lists `@huggingface/transformers` but NOT `sqlite-vec`. The `createRequire` call in `brain-sqlite.ts:110` fails silently. `_vecLoaded = false`.
2. **vec0 table never created**: Without sqlite-vec, `initializeBrainVec()` is never called. `brain_embeddings` table does not exist in the live database (confirmed via direct query: `ERROR - no such table: brain_embeddings`).
3. **Embedding provider never initialized**: `initDefaultProvider()` in `brain-embedding.ts:80` must be explicitly called to register the `LocalEmbeddingProvider`. Nothing in the startup chain calls it. `currentProvider = null` always.
4. **`isEmbeddingAvailable()` returns false**: Both guards fail — no provider AND no vec0 table. All embedding code paths return early.
5. **`reason.similar` fallback**: `brain-reasoning.ts:reasonSimilar()` tries vector search first, falls back to FTS5 if empty. The FTS5 fallback path IS reached, so `reason.similar` actually does return results — but labeled as `distance: 0` (no real similarity scoring).

### What would be needed to enable embeddings:
```bash
pnpm add sqlite-vec --filter @cleocode/core
```
Then `initDefaultProvider()` would need to be called at startup (currently not wired).

---

## 7. BrainConfig Feature Flags

From `packages/contracts/src/config.ts:197`:

```typescript
interface BrainConfig {
  autoCapture: boolean;       // auto-capture observations from lifecycle (default: true)
  captureFiles: boolean;      // capture file change events (default: false)
  captureWork: boolean;       // capture task add/update mutations (default: false)
  embedding: BrainEmbeddingConfig;
  memoryBridge: BrainMemoryBridgeConfig;
  summarization: BrainSummarizationConfig;
}

interface BrainEmbeddingConfig {
  enabled: boolean;           // (default: false) — gates initDefaultProvider()
  provider: 'local' | 'openai'; // (default: 'local')
  model: string;              // (default: 'all-MiniLM-L6-v2')
}

interface BrainMemoryBridgeConfig {
  autoRefresh: boolean;       // (default: true)
  contextAware: boolean;      // (default: false) — gates hybridSearch in bridge
  maxTokens: number;          // (default: 2000)
}

interface BrainSummarizationConfig {
  enabled: boolean;           // (default: false) — LLM summarization on session end
}
```

Key observations:
- `autoCapture: true` is the default that enables all noise-generating hooks
- `embedding.enabled` defaults to false — embeddings never activate unless explicitly set
- `captureFiles` and `captureWork` both default to false (good — those would add more noise)
- `memoryBridge.contextAware` defaults to false — hybrid search in bridge is never used

---

## 8. Noise Source Root Cause Analysis

The 2,467 patterns (96.7% duplicate) are caused by a combination of:

1. **Algorithm design flaw** (`auto-extract.ts:50-84`): Every task completion re-scans ALL 50 recent done tasks and re-detects every label. This is O(N) per completion, where N grows with project size.

2. **Missing dedup implementation** (`patterns.ts:65-82`): The dedup check finds duplicates but the if-block body is empty. The comment literally says "we just insert." This is an acknowledged TODO that was never resolved.

3. **No frequency increment**: The `frequency` column in `brain_patterns` defaults to 1 and is never incremented. The intent (increment on duplicate) was planned but not implemented.

4. **No unique constraint on `pattern` text**: The database schema has no `UNIQUE` constraint on `brain_patterns.pattern`, so the database cannot enforce deduplication.

The learnings noise (328 rows, mostly "Completed: X" format) is less severe but follows the same pattern: meaningful task titles become noise because there is no quality filter — every completion unconditionally creates a learning.

---

## 9. Recommendations: Keep / Gut / Refactor

### KEEP (solid, reuse in new system)
- `brain-schema.ts` — Table definitions are sound. Keep `brain_observations`, `brain_decisions`, `brain_memory_links`, `brain_sticky_notes`. Extend don't replace.
- `brain-accessor.ts` — Clean CRUD layer. Extend with new methods.
- `brain-sqlite.ts` — Initialization, migration, WAL, singleton pattern is solid.
- `brain-retrieval.ts:observeBrain()` — Core observation write path with content-hash dedup (30-second window) is correct architecture.
- `brain-retrieval.ts:searchBrainCompact()` / `timelineBrain()` / `fetchBrainEntries()` — 3-layer retrieval pattern is correct.
- `brain-search.ts:ensureFts5Tables()` / `searchBrain()` — FTS5 infrastructure is functional.
- `memory-bridge.ts` — Bridge generation is useful, but the pattern-selection logic needs fixing (currently shows noise patterns in "Patterns to Follow" section).
- `brain-lifecycle.ts:applyTemporalDecay()` — Legitimate maintenance operation. Keep.
- `brain-reasoning.ts:reasonWhy()` — Causal trace is legitimate and useful.
- `mental-model-queue.ts` — Async queue architecture is sound (for when embeddings are enabled).
- `engine-compat.ts` — Full dispatch surface is correct. Keep all operation signatures.

### GUT ENTIRELY (remove or disable)
- `auto-extract.ts:extractTaskCompletionMemory()` — Remove or completely rewrite. The learning template (`Completed: X — description`) is low quality and creates duplicates. The pattern detection (`Recurring label X`) is the #1 noise source.
- `auto-extract.ts:extractSessionEndMemory()` — Remove. Duplicates session observations and creates duplicate learnings.
- The empty dedup `if (duplicate)` blocks in `patterns.ts` and `learnings.ts` — Fix or remove these placeholders.
- `patterns.ts:storePattern()` as-is — The entire function needs rewriting with proper upsert semantics.
- `learnings.ts:storeLearning()` as-is — Same issue, needs upsert with frequency tracking.

### REFACTOR (keep concept, fix implementation)
- `brain_patterns` table: Add `UNIQUE(pattern, type)` constraint OR enforce uniqueness in application code. Change insert to upsert that increments `frequency`.
- `brain_learnings` table: Same — enforce uniqueness on `insight`, use upsert that updates `confidence` and `updated_at`.
- `brain-sqlite.ts:loadBrainVecExtension()` — Add `sqlite-vec` to package.json dependencies. Currently the package is listed in code but not installed.
- Embedding initialization: Wire `initDefaultProvider()` into startup when `config.brain.embedding.enabled = true`. Currently unreachable.
- `brain_page_nodes` / `brain_page_edges`: The schema and CRUD exist and are ready. Needs a population mechanism (manual import or auto-extract from tasks/docs).
- `brain_observations.facts_json`, `concepts_json`, `files_read_json`, `files_modified_json` — Either populate these fields or remove them to reduce schema noise.
- Memory bridge pattern selection: Filter out `success` patterns that match the `Recurring label` template, or sort by `frequency DESC` first to show highest-frequency unique patterns.

### ADD (for graph-native evolution)
- Database-level `UNIQUE` constraints or triggers for deduplication on patterns and learnings
- Purge script for existing noise: delete all patterns matching `Recurring label "%"` pattern, deduplicate learnings with same `insight` text
- Auto-population for `brain_page_nodes`: task nodes (`task:T###`) should auto-create when tasks are created/completed
- Quality scoring layer before any write to brain.db
- sqlite-vec package installation (enables the entire vector search infrastructure already coded)

---

## 10. Summary Statistics

| Metric | Value |
|--------|-------|
| Total brain.db rows | 3,050 |
| Meaningful rows (signal) | ~300 (est.) |
| Noise rows (patterns) | 2,385+ duplicates |
| Pattern dedup ratio | 96.7% duplicates |
| Unique patterns | 82 |
| Learnings (auto-generated "Completed:") | ~280 of 328 |
| Graph nodes | 0 |
| Graph edges | 0 |
| Vector embeddings | 0 (table missing) |
| sqlite-vec installed | NO |
| Embedding provider initialized | NO |
| FTS5 working | YES |
| Key dead code files | embedding-worker.ts, embedding-queue.ts, brain-similarity.ts (all functional but inert) |
| Files with empty dedup blocks | patterns.ts:66-82, learnings.ts:62-68 |
