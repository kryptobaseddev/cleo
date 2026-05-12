# T1000 BRAIN Advanced — Worker Decomposition Specs

**Lead**: Lead B (brain-advanced)
**Session**: ses_20260419003330_22e46b
**Date**: 2026-04-19
**Epic**: T1000 — BRAIN Advanced (Typed Promotion + Transcript Ingestion + Staged Backfill + Pre-Compact Flush + Diary + Missing CLI)

---

## Codebase Survey Findings

### Migration Convention (CRITICAL for T1001/T1002/T1003)

There is NO `/packages/core/src/store/migrations/` directory. All schema additions use one of two patterns found in `memory-sqlite.ts`:

1. **`ensureColumns(nativeDb, table, [{name, ddl}], 'brain')`** — for adding columns to existing tables. Idempotent, runs inside `runBrainMigrations()`.
2. **`nativeDb.exec('CREATE TABLE IF NOT EXISTS ...')`** — for adding brand-new tables. Also inside `runBrainMigrations()`.

Convention: the Drizzle schema file (`memory-schema.ts`) declares the canonical shape; `memory-sqlite.ts:runBrainMigrations()` applies the self-healing DDL at startup. This is the T673-M1 through T673-M4 pattern. All new tables for T1001/T1002/T1003 MUST follow this pattern:

- Add Drizzle table declaration to `packages/core/src/store/memory-schema.ts`
- Add `CREATE TABLE IF NOT EXISTS` block inside `runBrainMigrations()` in `packages/core/src/store/memory-sqlite.ts`
- Export type aliases at the bottom of `memory-schema.ts`

**No separate migration file directory exists. Do NOT create one.**

### BRAIN_OBSERVATION_TYPES Consumers (T1005 impact scope)

The enum at `memory-schema.ts:104` is consumed in these files — all must be updated or validated after adding 'diary':

| File | Usage |
|------|-------|
| `packages/core/src/store/memory-schema.ts:104` | Source constant + brainObservations.type column constraint |
| `packages/core/src/store/validation-schemas.ts:160` | `brainObservationTypeSchema = z.enum(BRAIN_OBSERVATION_TYPES)` — auto-expands, no edit needed |
| `packages/core/src/memory/brain-retrieval.ts:136` | Re-exports `BrainObservationType` derived type — auto-expands, no edit needed |
| `packages/core/src/memory/claude-mem-migration.ts:97` | `mapObservationType()` — maps incoming strings; must add 'diary' case or verify the fallback handles it |
| `packages/core/src/memory/brain-lifecycle.ts:328` | Type cast — verifies against the enum; auto-expands |
| `packages/contracts/src/facade.ts:33` | **SECOND COPY** — `BRAIN_OBSERVATION_TYPES` is DUPLICATED here; must be updated to stay in sync |
| `packages/contracts/src/index.ts:287` | Re-exports from facade; auto-expands once facade updated |
| `packages/core/dist/store/memory-schema.d.ts` | Built artifact — rebuild fixes |
| `packages/contracts/dist/facade.d.ts` | Built artifact — rebuild fixes |

**Key finding**: `packages/contracts/src/facade.ts` has an independent copy of `BRAIN_OBSERVATION_TYPES`. Both the core schema AND the contracts facade must be updated in T1005.

### runTierPromotion State (T1001 context)

`brain-lifecycle.ts:405` — current `runTierPromotion` uses 3-rule OR union (citationCount >= 3 OR qualityScore >= 0.7 OR verified = 1). This is the function T1001 replaces with a composite 6-signal scorer. The function exists and is called at consolidation Step 10 (`brain-lifecycle.ts:699`). There is NO `brain_promotion_log` table yet.

`stability_score` column already exists on `brain_page_edges` (via T673-M3 `ensureColumns`). T1001 needs a NEW `stability_score` column on `brain_observations` per acceptance criterion — this is a separate column from the edge table's stability_score.

### Transcript Extractor State (T1002 context)

`transcript-extractor.ts` (680 lines) — the `content.filter(b => b.type === 'text')` that drops non-text blocks is located around line 346 (confirmed by grep). The fix is removal of the `filter()` to keep tool_use, tool_result, and thinking blocks. The `brain_transcript_events` table does NOT exist yet.

### Precompact Hook State (T1004 context)

`packages/core/templates/hooks/precompact-safestop.sh` exists and currently calls only `cleo safestop`. The new `precompact-flush.ts` module needs to be called from this hook via `cleo memory precompact-flush`. The module does NOT exist yet in `packages/core/src/memory/`.

### Missing CLI Commands (T1006 context)

None of the 7 new commands (memory digest/recent/diary/watch, nexus top-entries, nexus impact --why, task verify --explain) exist in:
- `packages/cleo/src/dispatch/domains/memory.ts` (no 'digest', 'recent', 'diary', 'watch' operations)
- `packages/cleo/src/dispatch/domains/nexus.ts` (no 'top-entries' or impact --why)
- `packages/cleo/src/dispatch/domains/tasks.ts` (no 'verify.explain' operation; 'verify' is a separate cleo CLI command dispatched to a check domain, not tasks)

The `cleo task verify --explain` command routes through the check domain (`packages/cleo/src/dispatch/domains/check.ts` / `check/` subdirectory), not `tasks.ts`. Worker must target the correct domain.

---

## Dependency Order

```
Wave 1 (parallel-safe):
  T1001 — Typed Promotion
  T1002 — Transcript Ingestion
  T1003 — Staged Backfill
  T1004 — Pre-compact Flush
  T1005 — Add 'diary' type  ← smallest, must land first before T1006

Wave 2 (after T1005 done):
  T1006 — Missing CLI commands (memory diary needs the diary enum type)
```

---

## T1001 — Typed Promotion — Worker Spec

### Files to Touch (absolute paths)

```
packages/core/src/store/memory-schema.ts
packages/core/src/store/memory-sqlite.ts
packages/core/src/memory/brain-lifecycle.ts
packages/core/src/memory/promotion-score.ts          (NEW)
packages/core/src/memory/__tests__/brain-lifecycle-typed-promotion.test.ts  (NEW)
```

### Approach

Create `promotion-score.ts` implementing a composite 6-signal scorer (citation_count, quality_score, stability_score, recency, user_verified, outcome_correlated). Add `brain_promotion_log` table to `memory-schema.ts` and wire it into `memory-sqlite.ts:runBrainMigrations()` with `CREATE TABLE IF NOT EXISTS`. Add `stability_score` column to `brain_observations` via `ensureColumns()`. Replace the 3-rule OR union in `runTierPromotion` with a call to the composite scorer; write an audit row to `brain_promotion_log` on each promotion.

**NOTE**: `stability_score` on `brain_observations` is a NEW column (distinct from `brain_page_edges.stability_score` which already exists). Add via `ensureColumns(nativeDb, 'brain_observations', [{name:'stability_score', ddl:'real'}], 'brain')`.

### New Table Schema

```sql
CREATE TABLE IF NOT EXISTS brain_promotion_log (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL,
  from_tier TEXT NOT NULL,
  to_tier TEXT NOT NULL,
  score REAL NOT NULL,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by TEXT NOT NULL DEFAULT 'composite-scorer'
);
CREATE INDEX IF NOT EXISTS idx_promotion_log_observation
  ON brain_promotion_log (observation_id);
CREATE INDEX IF NOT EXISTS idx_promotion_log_decided_at
  ON brain_promotion_log (decided_at);
```

### Tests (file: `packages/core/src/memory/__tests__/brain-lifecycle-typed-promotion.test.ts`)

1. Seed 20 brain_observations with varied citation_count/quality_score/verified values; run `runTierPromotion`; assert the top-N by composite score are promoted and the lowest are not.
2. After promotion, assert `brain_promotion_log` has one row per promoted entry with correct from_tier/to_tier/score.
3. Assert `promotion-score.ts` computePromotionScore returns higher scores for verified+high-citation vs unverified+zero-citation entries.
4. Assert `stability_score` column exists on `brain_observations` after migration runs.
5. Assert idempotency: running `runTierPromotion` twice does not double-promote or create duplicate `brain_promotion_log` rows.
6. Assert entries already in 'long' tier are not affected by promotion logic.

### Evidence Atoms

```
commit:<sha>;files:packages/core/src/store/memory-schema.ts,packages/core/src/store/memory-sqlite.ts,packages/core/src/memory/brain-lifecycle.ts,packages/core/src/memory/promotion-score.ts;tool:pnpm-test;tool:biome
```

---

## T1002 — Transcript Ingestion — Worker Spec

### Files to Touch (absolute paths)

```
packages/core/src/store/memory-schema.ts
packages/core/src/store/memory-sqlite.ts
packages/core/src/memory/transcript-extractor.ts
packages/core/src/memory/transcript-ingestor.ts     (NEW)
packages/core/src/memory/redaction.ts               (NEW)
packages/core/src/memory/auto-research.ts           (NEW)
packages/core/src/memory/__tests__/transcript-ingestor.test.ts  (NEW)
```

### Approach

Add `brain_transcript_events` table to `memory-schema.ts`; wire `CREATE TABLE IF NOT EXISTS` in `runBrainMigrations()`. In `transcript-extractor.ts`, remove the `.filter(b => b.type === 'text')` call (confirmed ~line 346) to achieve full-fidelity block capture. Create `redaction.ts` for PII/secret scrubbing before persist. Create `transcript-ingestor.ts` that parses Claude JSONL transcripts keeping all block types (tool_use, tool_result, thinking) and persists to `brain_transcript_events`. Create `auto-research.ts` for thrash-detection (recurring-failure patterns) and golden-path mining from ingested transcripts.

### New Table Schema

```sql
CREATE TABLE IF NOT EXISTS brain_transcript_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  block_type TEXT NOT NULL,
  content TEXT NOT NULL,
  tokens INTEGER,
  redacted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_transcript_events_session
  ON brain_transcript_events (session_id);
CREATE INDEX IF NOT EXISTS idx_transcript_events_role
  ON brain_transcript_events (role);
CREATE INDEX IF NOT EXISTS idx_transcript_events_block_type
  ON brain_transcript_events (block_type);
```

### Tests (file: `packages/core/src/memory/__tests__/transcript-ingestor.test.ts`)

1. Ingest a synthetic Claude JSONL with text, tool_use, tool_result, and thinking blocks; assert all 4 block types are persisted to `brain_transcript_events` (not just text).
2. Assert `redaction.ts` strips known secret patterns: strings matching `sk-ant-...`, `ANTHROPIC_API_KEY=...`, paths like `/home/username/.ssh/`.
3. Assert `auto-research.ts` thrash-detection identifies recurring-failure patterns when the same error message appears 3+ times across sessions.
4. Assert `transcript-extractor.ts` no longer drops tool_use/tool_result/thinking blocks (regression test for the removed filter).
5. Assert the `brain_transcript_events` table schema exists after `runBrainMigrations()` runs on a fresh DB.
6. Ingest the same session twice; assert duplicate rows are not created (idempotency via session_id + seq composite check).

### Evidence Atoms

```
commit:<sha>;files:packages/core/src/store/memory-schema.ts,packages/core/src/store/memory-sqlite.ts,packages/core/src/memory/transcript-extractor.ts,packages/core/src/memory/transcript-ingestor.ts,packages/core/src/memory/redaction.ts,packages/core/src/memory/auto-research.ts;tool:pnpm-test;tool:biome
```

---

## T1003 — Staged Backfill — Worker Spec

### Files to Touch (absolute paths)

```
packages/core/src/store/memory-schema.ts
packages/core/src/store/memory-sqlite.ts
packages/core/src/memory/brain-backfill.ts
packages/cleo/src/dispatch/domains/memory.ts
packages/core/src/memory/__tests__/brain-backfill-staged.test.ts  (NEW)
```

### Approach

Add `brain_backfill_runs` table to `memory-schema.ts`; wire `CREATE TABLE IF NOT EXISTS` in `runBrainMigrations()`. Refactor `brain-backfill.ts:backfillBrainGraph()` to support a staged mode: instead of direct `INSERT OR IGNORE`, write a pending record to `brain_backfill_runs` first. Add three new dispatch operations in `memory.ts`: `backfill.run`, `backfill.approve`, `backfill.rollback`. Each must return LAFS envelopes (`{success, data, meta}`). Map CLI verbs `cleo memory backfill run/approve/rollback` to these operations.

### New Table Schema

```sql
CREATE TABLE IF NOT EXISTS brain_backfill_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,
  target_table TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_backfill_runs_status
  ON brain_backfill_runs (status);
CREATE INDEX IF NOT EXISTS idx_backfill_runs_started_at
  ON brain_backfill_runs (started_at);
```

### Tests (file: `packages/core/src/memory/__tests__/brain-backfill-staged.test.ts`)

1. Call `backfill.run` with a test source path; assert a `brain_backfill_runs` row with status='pending' is created and no rows are yet committed to the target table.
2. Call `backfill.approve <run_id>`; assert the pending rows are committed to brain tables and the `brain_backfill_runs` row updates to status='approved'.
3. Call `backfill.rollback <run_id>` on a pending run; assert the pending rows are removed and `brain_backfill_runs` status is 'rolled_back'.
4. Assert all 3 CLI operations return LAFS envelopes (`{success: true, data: {...}, meta: {...}}`).
5. Assert rollback is idempotent: rolling back an already-rolled-back run returns success with a no-op message.
6. Assert the `brain_backfill_runs` table exists after `runBrainMigrations()` on a fresh DB.

### Evidence Atoms

```
commit:<sha>;files:packages/core/src/store/memory-schema.ts,packages/core/src/store/memory-sqlite.ts,packages/core/src/memory/brain-backfill.ts,packages/cleo/src/dispatch/domains/memory.ts;tool:pnpm-test;tool:biome
```

---

## T1004 — Pre-compact Flush — Worker Spec

### Files to Touch (absolute paths)

```
packages/core/src/memory/precompact-flush.ts         (NEW)
packages/core/templates/hooks/precompact-safestop.sh
packages/cleo/src/dispatch/domains/memory.ts
packages/core/src/memory/__tests__/precompact-flush.test.ts  (NEW)
```

### Approach

Create `packages/core/src/memory/precompact-flush.ts` that queries the current process's pending in-flight observations (if any buffered in the sentient daemon or session memory queue) and flushes them to `brain_observations`. Add `precompact-flush` as a new dispatch operation in `memory.ts`. Update `precompact-safestop.sh` to add `cleo memory precompact-flush` call before the existing `cleo safestop` call. Implement graceful no-op when no pending observations exist.

**Key constraint**: The flush must be fast (< 5s) because it runs in a 30-second hook timeout window. Use synchronous-style flushing where possible.

### Tests (file: `packages/core/src/memory/__tests__/precompact-flush.test.ts`)

1. Invoke `precompactFlush()` with zero pending observations; assert it returns `{flushed: 0}` without error.
2. Stub 3 pending observations in session memory; invoke `precompactFlush()`; assert all 3 are persisted to `brain_observations`.
3. Assert the dispatch operation 'precompact-flush' is registered in `memory.ts` getSupportedOperations().mutate.
4. Assert the `precompact-safestop.sh` file contains the string `cleo memory precompact-flush`.
5. Invoke `precompactFlush()` twice in sequence; assert the second call is a no-op (pending queue cleared after first flush).
6. Assert `precompact-flush.ts` exports a `precompactFlush` function with explicit return type.

### Evidence Atoms

```
commit:<sha>;files:packages/core/src/memory/precompact-flush.ts,packages/core/templates/hooks/precompact-safestop.sh,packages/cleo/src/dispatch/domains/memory.ts;tool:pnpm-test;tool:biome
```

---

## T1005 — BRAIN_OBSERVATION_TYPES: add 'diary' type — Worker Spec

### Files to Touch (absolute paths)

```
packages/core/src/store/memory-schema.ts
packages/contracts/src/facade.ts
packages/core/src/memory/claude-mem-migration.ts
packages/core/src/memory/__tests__/brain-observations-diary-type.test.ts  (NEW)
```

### Approach

Add 'diary' to `BRAIN_OBSERVATION_TYPES` array in `memory-schema.ts:104` (6 → 7 types). CRITICAL: also update the duplicated copy in `packages/contracts/src/facade.ts:33` — these two arrays must stay in sync. Review `claude-mem-migration.ts:mapObservationType()` to handle 'diary' incoming strings. The Drizzle CHECK constraint on `brain_observations.type` is an enum derived from the array; updating the array is sufficient — no manual SQL needed (Drizzle enforces at the ORM level, not SQLite DDL CHECK level for SQLite).

**No schema migration needed**: SQLite has no runtime CHECK constraint on enum columns via Drizzle for SQLite; adding to the TS const is sufficient for new inserts. Existing rows are unaffected.

### Tests (file: `packages/core/src/memory/__tests__/brain-observations-diary-type.test.ts`)

1. Assert `BRAIN_OBSERVATION_TYPES` array (from `memory-schema.ts`) has length 7 and includes 'diary'.
2. Assert `BRAIN_OBSERVATION_TYPES` in `packages/contracts/src/facade.ts` also includes 'diary' (both copies in sync).
3. Call `memoryObserve({text: 'diary entry', type: 'diary'})` via the engine; assert the row is stored with type='diary'.
4. Assert that an unknown type (e.g. 'invalid-type') is rejected by the zod validation schema.
5. Assert `mapObservationType('diary')` in `claude-mem-migration.ts` returns 'diary' without falling back to default.
6. Assert `BrainObservationType` union (derived type) includes 'diary' as a valid member at compile time (TypeScript type-level test via `satisfies` or similar).

### Evidence Atoms

```
commit:<sha>;files:packages/core/src/store/memory-schema.ts,packages/contracts/src/facade.ts,packages/core/src/memory/claude-mem-migration.ts;tool:pnpm-test;tool:biome
```

---

## T1006 — Missing CLI Commands — Worker Spec

**DEPENDENCY**: T1005 must be merged before T1006 starts (memory diary command needs the diary enum type).

### Files to Touch (absolute paths)

```
packages/cleo/src/dispatch/domains/memory.ts
packages/cleo/src/dispatch/domains/nexus.ts
packages/cleo/src/dispatch/domains/check.ts          (or check/ subdirectory)
packages/core/src/memory/brain-lifecycle.ts          (digest/recent query logic)
packages/core/src/memory/__tests__/cli-missing-commands.test.ts  (NEW)
```

### Approach

**Memory commands** — add 4 new query/mutate operations to `memory.ts`:

- `digest` (query): call a new `memoryDigest()` function that summarizes the last-N observations from the current session into a briefing.
- `recent` (query): tail recent observations with optional filters (type, limit, session, tier).
- `diary` (mutate): write an observation with `type='diary'` — thin wrapper over existing `memoryObserve`. Gated: reject if BRAIN_OBSERVATION_TYPES does not include 'diary' (guarded by T1005).
- `watch` (query): long-poll stream of brain writes to stdout. Implement as SSE-style polling (not a real persistent connection — query latest rows since a cursor, return them, client loops).

**Nexus commands** — add 2 operations to `nexus.ts`:

- `top-entries` (query): query `brain_page_nodes` ordered by qualityScore DESC, return top-N highest-weight symbols.
- `impact.explain` or add `explain: true` flag to existing `impact` operation: annotate the impact response with paths that make a symbol impactful. Check whether `impact` operation exists first — if so, add `explain` as an optional param rather than a new operation name.

**Task verify --explain** — add `verify.explain` (query) to `check.ts` or the relevant check domain handler: return the full evidence atoms + gate state for a given task ID in human-readable format. This is read-only — query `verification` field from task record + format gate states.

**LAFS requirement**: All 7 operations must return `{success, data, meta}` envelopes. All must support `--json` mode.

### Tests (file: `packages/core/src/memory/__tests__/cli-missing-commands.test.ts`)

1. Assert `MemoryHandler.getSupportedOperations()` lists 'digest', 'recent', 'diary', 'watch' in its supported operations.
2. Call `memory.recent` with limit=5; assert response is `{success: true, data: {observations: [...], count: N}}`.
3. Call `memory.diary` with text='test diary entry'; assert response is `{success: true}` and brain_observations has a row with type='diary'.
4. Call `memory.digest`; assert response includes a non-empty summary string.
5. Assert `NexusHandler.getSupportedOperations()` lists 'top-entries'.
6. Call `nexus.top-entries` with limit=10; assert response has `{success: true, data: {entries: [...], count: N}}`.
7. Assert `verify.explain` operation returns gate state object with at minimum `{taskId, gates: {implemented, testsPassed, qaPassed}, evidence: [...]}`.

### Evidence Atoms

```
commit:<sha>;files:packages/cleo/src/dispatch/domains/memory.ts,packages/cleo/src/dispatch/domains/nexus.ts,packages/cleo/src/dispatch/domains/check.ts;tool:pnpm-test;tool:biome
```

---

## Scope Update Attempts

Attempted to apply file scopes to T1001-T1006 via `cleo update T### --files "..."`. Results recorded here (T1014 is fixing the update-files CLI):

```bash
# Attempted — record outcome in this section after running
cleo update T1001 --files "packages/core/src/store/memory-schema.ts,packages/core/src/store/memory-sqlite.ts,packages/core/src/memory/brain-lifecycle.ts,packages/core/src/memory/promotion-score.ts" 2>&1
cleo update T1002 --files "packages/core/src/store/memory-schema.ts,packages/core/src/store/memory-sqlite.ts,packages/core/src/memory/transcript-extractor.ts,packages/core/src/memory/transcript-ingestor.ts,packages/core/src/memory/redaction.ts,packages/core/src/memory/auto-research.ts" 2>&1
cleo update T1003 --files "packages/core/src/store/memory-schema.ts,packages/core/src/store/memory-sqlite.ts,packages/core/src/memory/brain-backfill.ts,packages/cleo/src/dispatch/domains/memory.ts" 2>&1
cleo update T1004 --files "packages/core/src/memory/precompact-flush.ts,packages/core/templates/hooks/precompact-safestop.sh,packages/cleo/src/dispatch/domains/memory.ts" 2>&1
cleo update T1005 --files "packages/core/src/store/memory-schema.ts,packages/contracts/src/facade.ts,packages/core/src/memory/claude-mem-migration.ts" 2>&1
cleo update T1006 --files "packages/cleo/src/dispatch/domains/memory.ts,packages/cleo/src/dispatch/domains/nexus.ts,packages/cleo/src/dispatch/domains/check.ts,packages/core/src/memory/brain-lifecycle.ts" 2>&1
```

---

## Migration Naming-Convention Notes

**No dedicated migrations folder exists.** The project uses inline self-healing DDL inside `memory-sqlite.ts:runBrainMigrations()`. Workers should NOT:
- Create a `packages/core/src/store/migrations/` directory
- Create numbered `.sql` files
- Use Drizzle's `migrate()` function directly for new tables

Workers SHOULD:
- Add Drizzle table definitions to `memory-schema.ts` (for TypeScript types + ORM)
- Add `CREATE TABLE IF NOT EXISTS` blocks inside `runBrainMigrations()` in `memory-sqlite.ts`
- Add any new column additions via `ensureColumns()` in the same function

This pattern is battle-tested (T673-M1 through T673-M4) and handles partial-apply/journal-reconcile scenarios.

---

## Key Findings Summary

1. **No migrations folder** — all schema additions are self-healing DDL in `memory-sqlite.ts:runBrainMigrations()`.
2. **Contracts facade duplicate** — `BRAIN_OBSERVATION_TYPES` is independently declared in BOTH `packages/core/src/store/memory-schema.ts` AND `packages/contracts/src/facade.ts`. T1005 Worker must update both.
3. **stability_score is NOT on brain_observations** — it exists only on `brain_page_edges`. T1001 needs to add it to `brain_observations` via `ensureColumns()`.
4. **transcript-extractor.ts filter** — the `.filter(b => b.type === 'text')` to remove is confirmed around line 346.
5. **precompact-safestop.sh** exists at `packages/core/templates/hooks/precompact-safestop.sh` and currently only calls `cleo safestop` — T1004 adds the flush call.
6. **task verify --explain** routes to check domain, not tasks domain — T1006 Worker must target `packages/cleo/src/dispatch/domains/check.ts` (or its subdirectory).
7. **T1006 depends on T1005** — the `memory diary` command calls `memoryObserve({type:'diary'})` which requires the 'diary' enum value to already be in `BRAIN_OBSERVATION_TYPES`.
