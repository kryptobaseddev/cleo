# T1145 + T1146 Explorer Map — Wave 5 Deriver Queue + Wave 6 Dreamer Upgrade

**Slot**: v2026.4.131 | **Depends on**: T1260 E3 (spawn wiring)
**Sources**: PORT-AND-RENAME-SYNTHESIS.md, NEXT-SESSION-HANDOFF.md, memory-schema.ts, brain-retrieval.ts, dream-cycle.ts, sleep-consolidation.ts, brain-lifecycle.ts, brain-maintenance.ts, sentient/tick.ts, session-narrative.ts, dialectic-evaluator.ts, llm-backend-resolver.ts

---

## TL;DR (5 bullets)

- No `deriver/` or `queue/` directory exists in `packages/core/src/` — Wave 5 builds from scratch as a SQLite-WAL queue table + 3-4 worker files at `packages/core/src/deriver/`.
- Existing "dreamer" is `sleep-consolidation.ts` (T555) plus `dream-cycle.ts` (T628) — Wave 6 upgrades these with Bayesian surprisal scoring, 4-6 specialist functions, and hierarchical RPTree structure; no new daemon needed (sentient tick already calls `checkAndDream`).
- `buildRetrievalBundle` (Wave 4, T1090) is upstream dependency for both: W5 deriver outputs feed warm-pass; W6 dreamer consolidation feeds retrieval quality scores. E3 wires this into spawn prompts, making W5+W6 non-dead-weight.
- Schema is additive: 2-3 new Drizzle migrations (deriver_queue + W6 brain_memory_trees + ALTER brain_observations for tree_id and level columns); W6 ALTER columns specified in PORT-AND-RENAME-SYNTHESIS.md §2.
- Largest risk: W5 queue durability ordering (SQLite `BEGIN EXCLUSIVE` vs `SKIP LOCKED` analog) must ship before W6 reads deriver outputs; W6 specialist LLM calls each need an existing `llm-backend-resolver.ts` backend or degrade gracefully.

---

## 1. W5 Deriver Queue Surface

### 1.1 Existing queue infrastructure

**No queue infrastructure** in `packages/core/src/`. No BullMQ, no p-queue, no custom queue. Codebase uses:
- `setImmediate()` for fire-and-forget (e.g., embedding writes brain-retrieval.ts:939, citation count increments :343)
- Sentient daemon cron tick (`packages/core/src/sentient/tick.ts`) — only recurring background scheduler
- `runBrainMaintenance()` in `brain-maintenance.ts` — one-shot maintenance pass

PSYCHE source uses PostgreSQL `FOR UPDATE SKIP LOCKED`. CLEO adapts to SQLite WAL with `BEGIN EXCLUSIVE` lock OR simpler "status column + created_at ordering" already in `brainBackfillRuns` (`memory-schema.ts:1525`).

**Recommended pattern** (adapt from `brainBackfillRuns`):
```sql
SELECT * FROM deriver_queue
WHERE status = 'pending'
ORDER BY priority DESC, created_at ASC
LIMIT 1
-- then UPDATE status='in_progress' WHERE id=? AND status='pending'
-- SQLite serialises via WAL; no SKIP LOCKED needed.
```

### 1.2 Where deriver workers live

Per PORT-AND-RENAME-SYNTHESIS.md §1.1:

```
packages/core/src/deriver/
  queue-manager.ts      # port of queue_manager.py (876 LOC) — SQLite WAL queue
  consumer.ts           # port of consumer.py — async worker loop
  deriver.ts            # port of deriver.py — main derivation logic
  enqueue.ts            # port of enqueue.py — enqueue helpers
  status.ts             # port of crud/deriver.py (220 LOC) — queue status reads
  index.ts              # public barrel
```

All NEW files.

### 1.3 What "derives"

| Type | Input | Output | BRAIN table |
|------|-------|--------|-------------|
| Session narrative | `brain_observations` (session batch) | Rolling summary | `session_narrative` (exists, T1089) |
| Themes | Cluster of related observations | Synthesized tags | `brain_observations` with `level='inductive'` |
| Embeddings | `brain_observations` lacking vectors | Float32 blobs | `brain_embeddings` (exists, T5387) |
| Dialectic outputs | Session turn text | DialecticInsights struct | `brain_observations` + `brain_decisions` (via `dialectic-evaluator.ts`) |

`source_ids` and `times_derived` columns on `brain_observations` (PORT-AND-RENAME-SYNTHESIS.md §2 ALTER) track lineage. `level` column distinguishes `explicit` from `inductive`.

### 1.4 Durability requirement

SQLite WAL is CLEO standard (all brain.db ops via `getBrainNativeDb()`). Queue table:
- `status IN ('pending','in_progress','done','failed')` state machine
- Timestamp `claimed_at` for stale detection (heartbeat)
- Cron trigger via sentient tick (5 min, `sentient/tick.ts:17`)
- NOT a separate daemon — tick can call `runDeriverBatch(projectRoot)` analogously to `checkAndDream`

No p-queue/BullMQ. SQLite WAL + exclusive tx sufficient for single-node CLI.

### 1.5 Connection to Waves 4 outputs

Wave 4 `buildRetrievalBundle` reads:
- `brain_learnings` (warm)
- `brain_patterns` (warm)
- `brain_decisions` (warm)
- `session_narrative` (hot)
- `brain_observations` (hot, recent 10)

W5 deriver writes TO `session_narrative` (enhanced) + creates new `brain_observations` with `level='inductive'`. Outputs consumable by Wave 4's warm/hot passes immediately — no E3 re-wiring needed for W5.

**M6 gate** on T1260: `buildRetrievalBundle` emits `provenanceClass`. W5 deriver-created entries should carry `provenanceClass='deriver-synthesized'` to satisfy M6.

---

## 2. W6 Dreamer Surface

### 2.1 Bayesian surprisal — current state

**No surprisal code exists.** Existing `dream-cycle.ts` uses:
- Volume threshold: `COUNT(*) > VOLUME_THRESHOLD_DEFAULT` (10 obs)
- Idle threshold: `minutesSince(lastRetrievalTs) > IDLE_MINUTES_DEFAULT` (30 min)

Neither uses surprisal scoring.

PSYCHE `surprisal.py` (492 LOC) computes geometric surprisal: `-log(P(observation | prior_context))`. CLEO ADAPT adds **temporal decay** + **confidence weighting** (sourceConfidence multiplier from `BRAIN_SOURCE_CONFIDENCE`).

**No external library.** Pure TypeScript: log probability from cosine similarity to stored embeddings + recency decay. Target: `packages/core/src/memory/surprisal.ts`. High surprisal (novel) = high priority for consolidation; low (redundant) = skip/merge.

### 2.2 Consolidation specialists — design

**Existing analog**: `sleep-consolidation.ts` (T555) at `packages/core/src/memory/sleep-consolidation.ts` has 4 functions:
- `mergeDuplicates(db)` — dedup by embedding similarity
- `pruneStale(db)` — evict low-quality short-tier
- `strengthenPatterns(db)` — synthesize learnings into patterns
- `generateInsights(db)` — cluster observations into cross-cutting insights

Deterministic functions called inline from `runSleepConsolidation()`. No multi-agent dispatch.

W6 ADAPT adds 4 CLEO specialists beyond PSYCHE's Deduction + Induction:
- `UserPreferenceSpecialist` — extracts preference signals from user_profile traits
- `DecisionSpecialist` — routes high-surprisal observations to `brain_decisions`
- `CodePatternSpecialist` — synthesizes `brain_patterns` from code-change observations
- `TaskOutcomeSpecialist` — links consolidation to task completion events

**Pattern**: extend `sleep-consolidation.ts` OR create `packages/core/src/memory/specialists.ts` with `BaseSpecialist` interface + 6 implementations. `runSleepConsolidation` becomes Dreamer orchestrator dispatching specialists in surprisal-priority order.

PORT-AND-RENAME-SYNTHESIS.md §1.1 targets `packages/core/src/memory/specialists.ts` (no new directory). Keep consistent.

### 2.3 Hierarchical trees

**No tree structure exists.** Target: `packages/core/src/memory/surprisal-tree.ts` (port of `trees/rptree.py`, 157 LOC).

RPTree (Random Projection Tree) partitions embedding space into hierarchical clusters. Each leaf = group of semantically-similar observations.

**Persistence**: new `brain_memory_trees` table. ALTER on `brain_observations.tree_id` (PORT-AND-RENAME-SYNTHESIS.md §2) is FK into this table. Schema:

```sql
CREATE TABLE brain_memory_trees (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  depth     INTEGER NOT NULL DEFAULT 0,
  leaf_ids  TEXT NOT NULL,   -- JSON array of brain_observations.id
  centroid  BLOB,            -- serialized float32 centroid
  parent_id INTEGER REFERENCES brain_memory_trees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
```

Trees rebuilt each dream cycle (not incrementally). Table truncated and repopulated. `tree_id` on `brain_observations` marks leaf cluster after last cycle.

### 2.4 Trigger

Sentient tick implements Volume + Idle triggers via `checkAndDream` (`dream-cycle.ts:285`). W6 upgrade does NOT need new daemon/trigger — it upgrades what happens INSIDE the dream cycle.

Current flow:
```
sentient/tick.ts → maybeTriggerDream() → checkAndDream() → runConsolidation() → runSleepConsolidation()
```

W6 flow:
```
sentient/tick.ts → maybeTriggerDream() → checkAndDream() → runConsolidation()
  └─ runSleepConsolidation() (upgraded)
       ├─ computeSurprisalScores(observations) → surprisal.ts
       ├─ buildSurprisalTree(high_surprisal_obs) → surprisal-tree.ts
       └─ dispatchSpecialists(tree, observations) → specialists.ts
            ├─ DeductionSpecialist
            ├─ InductionSpecialist
            ├─ UserPreferenceSpecialist
            ├─ DecisionSpecialist
            ├─ CodePatternSpecialist
            └─ TaskOutcomeSpecialist
```

No new cron/daemon. Tick provides cadence (5 min). Quiet-period idle works (`IDLE_MINUTES_DEFAULT = 30`).

---

## 3. Test Surface

### 3.1 Existing tests to follow

| File | Coverage | Pattern |
|------|----------|---------|
| `packages/core/src/memory/__tests__/psyche-wave4.test.ts` | Wave 4 multi-pass retrieval E2E | Real SQLite temp dir, `mkdtemp`, env-redirect `CLEO_DIR` + `CLEO_HOME`, `afterEach` close + rm |
| `packages/core/src/memory/__tests__/dream-cycle.test.ts` | Volume + idle triggers, cooldown, manual trigger | `vi.mock('../sleep-consolidation.js')` to avoid Anthropic API; `_resetDreamState()` between tests |
| `packages/core/src/sentient/__tests__/tick.test.ts` | Tick loop with injected `checkAndDream` | Options injection — pass override in `TickOptions` |

### 3.2 New tests needed

**W5 Deriver Queue** (`packages/core/src/deriver/__tests__/deriver-queue.test.ts`):
- Enqueue → claim → complete happy path
- Stale claim recovery (older than N minutes → re-queued)
- Priority ordering
- Concurrent claim safety

**W6 Dreamer** (`packages/core/src/memory/__tests__/specialists.test.ts`):
- Surprisal: high-novelty > 0.7
- Surprisal: duplicate < 0.3
- RPTree: 10 obs → depth ≥ 2
- Specialist dispatch: DeductionSpecialist creates brain_learnings entry
- Full dream cycle: upgraded path produces `brain_memory_trees` rows

Mocks: `vi.mock('../surprisal.ts', ...)` for tests not needing real embeddings; `vi.mock('./llm-backend-resolver.js', () => ({ resolveLlmBackend: () => null }))` for specialist tests bypassing LLM.

---

## 4. Schema Impact

### 4.1 W5 Deriver Queue migration

`packages/core/migrations/drizzle-brain/TIMESTAMP_t1145-add-deriver-queue/migration.sql`:

```sql
CREATE TABLE deriver_queue (
  id           TEXT PRIMARY KEY,
  item_type    TEXT NOT NULL,                 -- 'observation'|'session'|'narrative'|'embedding'
  item_id      TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|in_progress|done|failed
  claimed_at   TEXT,
  claimed_by   TEXT,
  error_msg    TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX idx_deriver_queue_status_priority
  ON deriver_queue(status, priority DESC, created_at ASC);
CREATE INDEX idx_deriver_queue_item ON deriver_queue(item_type, item_id);
```

Add Drizzle schema def to `packages/core/src/store/memory-schema.ts` (additive).

### 4.2 W5 brain_observations ALTER

PORT-AND-RENAME-SYNTHESIS.md §2. File: `TIMESTAMP_t1145-extend-brain-observations/migration.sql`:

```sql
ALTER TABLE brain_observations ADD COLUMN source_ids TEXT;       -- JSON array of ancestor IDs
ALTER TABLE brain_observations ADD COLUMN times_derived INTEGER DEFAULT 1;
ALTER TABLE brain_observations ADD COLUMN level TEXT DEFAULT 'explicit';
ALTER TABLE brain_observations ADD COLUMN tree_id INTEGER;       -- FK to brain_memory_trees
```

Add Drizzle column defs to `memory-schema.ts`. `level` column has in-app CHECK; do not add SQLite CHECK constraint (Lesson 3 fragility).

### 4.3 W6 brain_memory_trees migration

`TIMESTAMP_t1146-add-brain-memory-trees/migration.sql`:

```sql
CREATE TABLE brain_memory_trees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  depth      INTEGER NOT NULL DEFAULT 0,
  leaf_ids   TEXT NOT NULL DEFAULT '[]',
  centroid   BLOB,
  parent_id  INTEGER REFERENCES brain_memory_trees(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX idx_brain_trees_parent ON brain_memory_trees(parent_id);
CREATE INDEX idx_brain_trees_depth ON brain_memory_trees(depth);
```

### 4.4 Migration ordering risk

W5 must land (and `brain_observations.tree_id` column exist) BEFORE W6 populates `tree_id`. Same slot (.131); order migrations explicitly:
1. `t1145-add-deriver-queue`
2. `t1145-extend-brain-observations`
3. `t1146-add-brain-memory-trees`

Run `pnpm db:check` after each.

---

## 5. Atomic Decomposition — 10 worker tasks

### Wave 5 (5 tasks)

| Task | File(s) | Size | Acceptance |
|------|---------|------|------------|
| **W5-T1** Schema: deriver_queue + brain_observations ALTER | `memory-schema.ts` (additive) + 2 migrations | small | `pnpm db:check` passes; Drizzle snapshot updated; zero existing test failures |
| **W5-T2** `deriver/enqueue.ts` + `status.ts` | 2 new files, ~150 LOC | small | `enqueue()` returns queue ID; `getQueueStatus()` returns count by status; 4 unit tests |
| **W5-T3** `deriver/queue-manager.ts` | 1 new, ~250 LOC | medium | Claim + complete + stale-recovery; 6 unit tests including concurrent claim safety |
| **W5-T4** `deriver/consumer.ts` + `deriver.ts` | 2 new, ~300 LOC | medium | Worker loop processes batch; emits `level='inductive'` observations; 4 integration tests with real SQLite |
| **W5-T5** Wire deriver into sentient tick + maintenance | `sentient/tick.ts` + `brain-maintenance.ts` | small | `runBrainMaintenance` includes deriver step; tick calls deriver when queue non-empty; existing tick tests pass |

### Wave 6 (5 tasks)

| Task | File(s) | Size | Acceptance |
|------|---------|------|------------|
| **W6-T1** Schema: brain_memory_trees | `memory-schema.ts` + 1 migration | small | `pnpm db:check` passes; zero existing test failures |
| **W6-T2** `memory/surprisal.ts` | 1 new, ~200 LOC | medium | High-novelty > 0.7, duplicate < 0.3; degrades gracefully when embeddings unavailable (returns 0.5 neutral) |
| **W6-T3** `memory/surprisal-tree.ts` | 1 new, ~100 LOC | small | RPTree builds from N embeddings; depth ≥ 2 for N ≥ 8; leaf_ids correctly partitioned; persists to brain_memory_trees |
| **W6-T4** `memory/specialists.ts` | 1 new, ~350 LOC | medium | `BaseSpecialist` interface + 6 implementations; LLM backend fallbacks gracefully; 6 unit tests |
| **W6-T5** Upgrade `sleep-consolidation.ts` to Dreamer orchestrator | `sleep-consolidation.ts` (extend) | medium | `runSleepConsolidation` calls surprisal → tree → specialists; dream-cycle.test.ts still passes; new specialists.test.ts |

---

## 6. Risk Callouts

### 6.1 Longest workers
- **W5-T4** (consumer + deriver, real SQLite integration): expect 2-3 hours; flag for IVTR retry if quality fails
- **W6-T4** (6 specialists + BaseSpecialist): brittle test surface — require `vi.mock` for all LLM calls
- **W6-T5** (sleep-consolidation upgrade): existing `vi.mock('../sleep-consolidation.js')` MUST continue exporting `runSleepConsolidation`. Add `specialists.test.ts` separately rather than modifying `dream-cycle.test.ts`

### 6.2 Schema migration ordering
W5-T1 must complete + cherry-pick to main BEFORE W6-T1 starts. Enforce via dependency: W6-T1 blocks on W5-T1 gate. Drizzle snapshot rule (Lesson 3): never delete+regenerate; only add new migration files with new timestamps.

### 6.3 Cross-package boundary
- All deriver → `packages/core/src/deriver/` (runtime SDK domain)
- All memory specialists/surprisal → `packages/core/src/memory/`
- CLI dispatch for `cleo brain deriver status` → `packages/cleo/src/dispatch/` (thin wrapper)
- New types → `packages/contracts/src/operations/memory.ts` or new `packages/contracts/src/operations/deriver.ts`

Anti-pattern: placing `deriver/` under `packages/core/src/brain/` — directory does not exist, do not create. Use `packages/core/src/deriver/` per PORT-AND-RENAME-SYNTHESIS.md.

### 6.4 Surprisal without embeddings
If no provider available (no Ollama, no `ANTHROPIC_API_KEY`), surprisal can't compute cosine similarity. Mitigation: return neutral 0.5, log warning, don't throw. Pattern from `sleep-consolidation.ts` (no API key = silent no-op for LLM steps).

### 6.5 M6 gate on T1260 E3
T1260 E3 requires `buildRetrievalBundle` to emit `provenanceClass` and refuse `provenanceClass='unswept-pre-T1151'`. W5 deriver-created entries get `provenanceClass='deriver-synthesized'` at write time. Since E3 ships in slot .128 before W5+W6 in slot .131, W5 worker adopts whatever `provenanceClass` API E3 establishes.

---

## 7. Key Files Reference

| File | Purpose |
|------|---------|
| `packages/core/src/store/memory-schema.ts` | Add deriver_queue, brain_memory_trees + ALTER columns |
| `packages/core/src/memory/brain-retrieval.ts` | `buildRetrievalBundle` (W4 upstream) |
| `packages/core/src/memory/sleep-consolidation.ts` | EXISTING dreamer — W6 extends |
| `packages/core/src/memory/dream-cycle.ts` | Trigger host — W6 upgrades dispatch path |
| `packages/core/src/memory/brain-lifecycle.ts` | `runConsolidation` orchestrator |
| `packages/core/src/memory/brain-maintenance.ts` | `runBrainMaintenance` — W5 deriver step inserted |
| `packages/core/src/memory/llm-backend-resolver.ts` | LLM backend for specialist calls |
| `packages/core/src/sentient/tick.ts` | W5 deriver trigger (analogous to `maybeTriggerDream`) |
| `packages/core/src/memory/__tests__/dream-cycle.test.ts` | Test pattern + must-not-break |
| `packages/core/src/memory/__tests__/psyche-wave4.test.ts` | Integration pattern (real SQLite, temp dirs) |
| `.cleo/agent-outputs/T1075-psyche-integration-plan/PORT-AND-RENAME-SYNTHESIS.md` | Authoritative file destinations + schema deltas |
