# T673: STDP Phase 5 — RCASD Plan

**Task**: T673  
**Epic Parent**: T627 (T-BRAIN-LIVING Stabilization)  
**Date**: 2026-04-15  
**Author**: cleo-subagent (Lead, RCASD)  
**Status**: RCASD complete — decomposed into 6 child subtasks  

---

## §R — Research Findings

### R1. Current Schema (Live brain.db)

**`brain_plasticity_events`** (confirmed via `sqlite3 .cleo/brain.db .schema`):
```sql
CREATE TABLE brain_plasticity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_node TEXT NOT NULL,
  target_node TEXT NOT NULL,
  delta_w REAL NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ltp', 'ltd')),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  session_id TEXT
);
-- 5 indexes: source, target, timestamp, session, kind
```

Row count: **0** (confirmed). Table exists but is never written to.

**`brain_retrieval_log`** (live DDL via sqlite3 .schema):
```sql
CREATE TABLE brain_retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  entry_ids TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  source TEXT NOT NULL,
  tokens_used INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  retrieval_order INTEGER,
  delta_ms INTEGER
);
```

Row count: **38** (real retrievals exist).

**CRITICAL GAP**: Live `brain_retrieval_log` is MISSING `session_id` column. The Drizzle schema at `packages/core/src/store/brain-schema.ts:715` declares `session_id text` but this column was never applied via migration. The self-healing CREATE TABLE in `brain-retrieval.ts:logRetrieval` (line 1492) does include `session_id TEXT` in its CREATE, but this path only runs for brand-new tables — not for upgrades to existing tables. The live table predates the session_id addition.

**`brain_page_edges`** (live):
```sql
CREATE TABLE brain_page_edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  provenance TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT brain_page_edges_pk PRIMARY KEY(from_id, to_id, edge_type)
);
```

`co_retrieved` edges: **0** (no Hebbian edges exist yet; no STDP basis exists).

**Missing columns from plan §3.2 and §3.3** (per `docs/plans/stdp-feasibility.md`):
- `brain_page_edges.last_reinforced_at` — NOT present
- `brain_page_edges.reinforcement_count` — NOT present  
- `brain_page_edges.plasticity_class` — NOT present
- `brain_retrieval_log.session_id` — NOT present in live table
- `brain_retrieval_log.reward_signal` — NOT present (never added)
- `brain_plasticity_events.session_id` — present in schema, but INSERT at `brain-stdp.ts:277` does NOT pass it

### R2. STDP Implementation State

File: `packages/core/src/memory/brain-stdp.ts`

**`applyStdpPlasticity`** (line 169) — FULLY IMPLEMENTED:
- LTP path: computes `Δw = A_PRE * exp(-deltaT / TAU_PRE_MS)`, upserts `co_retrieved` edge, logs to `brain_plasticity_events`
- LTD path: computes `deltaWNeg = -(A_POST * exp(-deltaT / TAU_POST_MS))`, weakens existing reverse edges
- Inserts into `brain_plasticity_events` but WITHOUT `session_id` (bug: line 277 omits session_id from INSERT)

**`getPlasticityStats`** (line 357) — FULLY IMPLEMENTED, works correctly.

**Integration**: `brain-lifecycle.ts:710-714` calls `applyStdpPlasticity(projectRoot)` as Step 9 of `runConsolidation`. This is wired correctly.

**R3. Root Cause of 0 Events (CONFIRMED)**

Live diagnosis: `cleo brain maintenance` + `cleo session end` both ran — still 0 plasticity events.

Root cause: `applyStdpPlasticity` defaults to `sessionWindowMs = 5 * 60 * 1000` (5 minutes). The code uses this SAME value as both (a) the lookback cutoff for retrieval rows AND (b) the pair comparison window. The 38 live retrieval rows span 2026-04-13 to 2026-04-15 — all older than 5 minutes. Zero rows qualify → zero plasticity events.

The plan at `docs/plans/stdp-feasibility.md §4` specifies a **30-day lookback** for retrieval events. This is inconsistent with the 5-minute default in the implementation.

**Fix**: The lookback window (how far back to read retrieval rows) must be separated from the pair comparison window (the Δt threshold for spike-pair eligibility). The lookback should default to 30 days; the pair window can remain configurable.

### R4. Hebbian Co-Retrieval Strengthener (Reference)

`packages/core/src/memory/brain-lifecycle.ts:930` — `strengthenCoRetrievedEdges`:
- Queries `brain_retrieval_log` for last 30 days
- Builds co-occurrence counts (pairs that appear ≥ 3 times)
- Inserts/updates `brain_page_edges` with `edge_type = 'co_retrieved'`
- **Also produces 0 edges** in current state (likely because entry_ids are stored as comma-separated strings but STDP expects JSON arrays; or because the co_retrieved edges haven't been created yet because 0 edges in brain_page_edges)

Note: `logRetrieval` at line 1513 stores `entry_ids` as `entryIds.join(',')` — comma-separated, not JSON. But `strengthenCoRetrievedEdges` at line 971 does `JSON.parse(row.entry_ids)`. This is a second bug: the format stored by the writer (`join(',')`) is incompatible with the format expected by the reader (`JSON.parse`).

### R5. Reward Signal (R-STDP) Current State

`reward_signal` column does NOT exist anywhere in the codebase. The Drizzle schema at `brain-schema.ts:694-724` does not declare it. No INSERT or UPDATE references it. This is purely additive work per decision D-BRAIN-VIZ-13.

### R6. Migration State

`brain_plasticity_events` and `brain_retrieval_log` are NOT managed by the Drizzle migration system. They are created via self-healing DDL in application code:
- `brain_plasticity_events`: no CREATE TABLE DDL found in source (likely created in a migration that was not merged, or was created via direct SQL when the tests ran). It exists in live DB — origin unclear.
- `brain_retrieval_log`: created by `logRetrieval` self-healing CREATE TABLE (line 1493) but this schema is older than the current Drizzle schema.

**Action required**: Add both tables to the formal Drizzle migration system so the schema is authoritative and all columns exist after migration.

### R7. Existing Unit Tests

`packages/core/src/memory/__tests__/brain-stdp.test.ts` — 100% mocked DB. Uses `vi.mock('../../store/brain-sqlite.js')`. Tests LTP/LTD math, window cutoff, weight clamping. Tests are sound for unit verification but cannot detect real-world wiring failures (which is exactly what happened here).

---

## §C — Consensus Proposals

### C1. Spike Source

**Proposal**: A "spike" = one row in `brain_retrieval_log`. Each row represents one retrieval event — one memory access that produced N entry_ids. The temporal sequence of rows (ordered by `created_at`) is the spike train.

**Rationale**: This is what the existing `applyStdpPlasticity` implementation already uses. No change needed on spike definition. Confirmed correct per `docs/plans/stdp-feasibility.md §4`.

### C2. Timing Windows

**Proposal** (two separate parameters):
- `lookbackDays = 30`: how far back to fetch retrieval rows (matching Hebbian's 30-day window)
- `sessionWindowMs = 5 * 60 * 1000` (5 min): max Δt between a pair of spikes to be considered co-activated

**Rationale**: The current code conflates these into one `sessionWindowMs` parameter which must be 5 minutes for pair proximity but 30 days for lookback. Separating them fixes the "0 events" root cause without changing the STDP math.

### C3. Reward Signal

**Proposal**: `reward_signal REAL` on `brain_retrieval_log`, range `-1.0` to `+1.0`, null = unlabeled. Populated in a backfill pass at session end that correlates retrieval rows with task outcomes:
- `+1.0`: task that was active during retrieval completed with `verification.passed = true`
- `+0.5`: task completed without full verification
- `-0.5`: task was abandoned/cancelled after retrieval
- `null`: no task correlation found (default)

**Measurable hook**: At session end, join `brain_retrieval_log.session_id` with completed tasks that ended in that session. This requires `session_id` to be populated in `brain_retrieval_log` (currently missing — addressed in STDP-W1).

---

## §A — Architecture Decision

### A1. Writer Location: Batch at Session-End Consolidation (Step 9)

**Decision**: Keep the existing architecture — `applyStdpPlasticity` runs as Step 9 of `runConsolidation`, called from `brain-lifecycle.ts:710`. This is already wired; the fix is correctness not location.

**Alternatives considered**:
- Real-time retrieval callback: would require thread-safe DB access and couples hot path to plasticity math. Rejected — high complexity, low value.
- Observer summary pipeline (async): would add latency and break the causal link between retrieval session and plasticity update. Rejected.
- Session-end consolidation (batch): already implemented, matches the biological "sleep consolidation" model from the plan. **Chosen**.

### A2. Write Path

`applyStdpPlasticity` uses `getBrainNativeDb()` for raw SQL inserts — bypasses Drizzle ORM but is consistent with the rest of `brain-lifecycle.ts` (which also uses nativeDb for performance). This is correct — do not change.

### A3. R-STDP Reward Signal Computation

Reward backfill runs as a new sub-step within `runConsolidation` (Step 9a, before STDP runs in Step 9b). Steps:
1. Get active session ID from session context
2. Query `tasks.db` for tasks completed in the last 30 days where `verification.passed = true`
3. For each completed task, update `brain_retrieval_log.reward_signal` where `session_id` matches and `created_at` falls within the task's active window
4. STDP then reads `reward_signal` to modulate Δw

**Dependency**: requires `session_id` in `brain_retrieval_log` (STDP-W1) and `reward_signal` column (STDP-W1).

### A4. entry_ids Format Bug

The `logRetrieval` function stores `entry_ids` as `entryIds.join(',')` (comma-separated string). The `strengthenCoRetrievedEdges` function attempts `JSON.parse(row.entry_ids)` which will fail on comma-separated strings. The `applyStdpPlasticity` function also uses `JSON.parse(row.entry_ids)` — same bug.

**Fix**: `logRetrieval` MUST store `entry_ids` as `JSON.stringify(entryIds)` (JSON array). A one-time migration must update existing rows. This is addressed in STDP-W1 (migration) and STDP-W2 (writer fix).

---

## §S — Specification Summary

Full formal spec: `docs/specs/stdp-wire-up-spec.md`

Key points:
- RFC 2119 language throughout
- Covers: migration, writer fix, lookback/window separation, reward backfill, functional test acceptance criteria
- Explicitly prohibits mocked DB in functional tests

---

## §D — Decomposition

### STDP-W1: Migration — schema columns + entry_ids format fix
- Add `session_id TEXT` to `brain_retrieval_log` (live table is missing it)
- Add `reward_signal REAL` to `brain_retrieval_log` (D-BRAIN-VIZ-13)
- Add `last_reinforced_at TEXT`, `reinforcement_count INTEGER DEFAULT 0`, `plasticity_class TEXT DEFAULT 'static'` to `brain_page_edges` (per plan §3.2)
- Fix `entry_ids` format: migrate existing rows from `'a,b,c'` to `'["a","b","c"]'` (JSON)
- Add corresponding indexes
- Wire these columns into the Drizzle schema and the `ensureColumns` safety net in `brain-sqlite.ts`
- Size: small

### STDP-W2: Writer — fix applyStdpPlasticity lookback window + session_id
- Separate `lookbackDays` (30d) from `sessionWindowMs` (5min) in `applyStdpPlasticity`
- Pass `session_id` in the `INSERT INTO brain_plasticity_events` statement
- Fix `logRetrieval` to store `entry_ids` as JSON array (not comma-separated)
- Update `RetrievalLogRow` interface to include `session_id` and `reward_signal`
- Size: medium

### STDP-W3: Math — implement R-STDP reward modulation
- Read `reward_signal` from `brain_retrieval_log` rows
- Apply the modulation formula: `Δw_ltp *= (1 + r)`, `Δw_ltd *= (1 - r)` (per plan §4)
- Handle `null` reward_signal (skip modulation for unlabeled rows)
- Update `StdpPlasticityResult` to include `rewardModulatedEvents: number`
- Size: medium

### STDP-W4: R-STDP reward_signal backfill pipeline
- New function `backfillRewardSignals(projectRoot, sessionId)` in `brain-stdp.ts`
- Queries tasks.db for tasks completed in last 30 days with verification outcome
- Maps task session to retrieval log rows via `session_id`
- Assigns `+1.0 / +0.5 / -0.5` based on completion + verification state
- Runs as Step 9a of `runConsolidation` (before STDP in Step 9b)
- Size: medium

### STDP-W5: Functional test — end-to-end CLI test against real brain.db
- Creates a temp project dir with real `.cleo/brain.db`
- Inserts ≥ 3 retrieval log rows within the session window using `INSERT INTO brain_retrieval_log`
- Runs `cleo brain maintenance` against the temp project via `execSync`
- Asserts `brain_plasticity_events` contains ≥ 1 LTP row
- Asserts edge weights updated in `brain_page_edges`
- Asserts `cleo brain plasticity stats` JSON output shows `totalEvents > 0`
- Uses REAL binary — no mocks (owner directive)
- Located at: `packages/core/src/memory/__tests__/brain-stdp-functional.test.ts`
- Size: medium

### STDP-W6: ADR + plan doc update
- Write `docs/adrs/ADR-STDP-WIRE-UP.md` (or `.cleo/adrs/` if that's the canonical location)
- Update `docs/plans/stdp-feasibility.md` §10 to mark Phase 5 DONE with evidence link
- Update CHANGELOG.md with Phase 5 wire-up entry
- Size: small

---

## §Open Questions for Owner

1. **entry_ids format migration**: The existing 38 rows in `brain_retrieval_log` store `entry_ids` as comma-separated strings. Migrating to JSON arrays requires a one-time UPDATE. If these rows have historical value, the migration must be applied. If they can be discarded, a DELETE and fresh start is simpler. Owner: migrate existing rows or truncate?

2. **lookbackDays vs sessionWindowMs**: The current STDP design treats "session window" as the pair-comparison Δt. The 30-day lookback is a separate concept. Should the pair comparison window remain at 5 minutes (real-time session), or should it be extended to allow cross-session spike pairs? The plan is ambiguous on this point.

3. **plasticity_class columns on brain_page_edges**: Plan §3.2 specifies `last_reinforced_at`, `reinforcement_count`, and `plasticity_class` columns. These are not in the current schema. Adding them is straightforward. Is this in scope for T673 (Phase 5) or deferred to a later phase?

4. **brain_weight_history table**: Plan §3.4 specifies an optional weight audit log. Plan marks it as Phase 7. Confirm: NOT in scope for T673.

5. **ADR location**: `.cleo/adrs/` or `docs/adrs/`? (Both directories exist in the project.)

---

## §Research Evidence (file:line citations)

| Claim | Evidence |
|-------|----------|
| brain_plasticity_events has 0 rows | `sqlite3 .cleo/brain.db "SELECT COUNT(*) FROM brain_plasticity_events"` → 0 |
| brain_retrieval_log has 38 rows | `sqlite3 .cleo/brain.db "SELECT COUNT(*) FROM brain_retrieval_log"` → 38 |
| brain_retrieval_log missing session_id | `PRAGMA table_info(brain_retrieval_log)` — no session_id column |
| STDP wired in lifecycle | `packages/core/src/memory/brain-lifecycle.ts:710-714` |
| 5-min window default | `packages/core/src/memory/brain-stdp.ts:171` |
| logRetrieval comma-sep format | `packages/core/src/memory/brain-retrieval.ts:1513` — `entryIds.join(',')` |
| strengthenCoRetrievedEdges JSON.parse | `packages/core/src/memory/brain-lifecycle.ts:971` — `JSON.parse(row.entry_ids)` |
| session_id in Drizzle schema | `packages/core/src/store/brain-schema.ts:715` |
| reward_signal in plan | `docs/plans/stdp-feasibility.md:§3.3` and `§6` |
| plan 30-day lookback | `docs/plans/stdp-feasibility.md:§4` line 133 |
| INSERT omits session_id | `packages/core/src/memory/brain-stdp.ts:277-279` |
| brain_page_edges missing plasticity cols | `PRAGMA table_info(brain_page_edges)` — only 6 columns |

---

## §ADR Outline (for STDP-W6)

**ADR-STDP-WIRE-UP: STDP Phase 5 Wire-Up Decisions**

- **Context**: Phase 5 shipped half-built (table exists, no writer events). Root cause analysis revealed 3 bugs.
- **Decision 1**: Separate `lookbackDays` from `sessionWindowMs` in `applyStdpPlasticity`. Lookback = 30d; pair window = 5min.
- **Decision 2**: Fix `logRetrieval` to store `entry_ids` as JSON arrays.
- **Decision 3**: Add `session_id` to `brain_retrieval_log` via migration + ensureColumns.
- **Decision 4**: Add `reward_signal` to `brain_retrieval_log` per D-BRAIN-VIZ-13.
- **Decision 5**: Functional test MUST use real brain.db via real CLI binary — no mocked DB.
- **Consequences**: Existing comma-separated `entry_ids` rows become incompatible. Migration required.

---

## §Child Tasks Created

| ID | Title | Size |
|----|-------|------|
| STDP-W1 | Migration: session_id + reward_signal + entry_ids format fix | small |
| STDP-W2 | Writer: fix lookback window + session_id in INSERT | medium |
| STDP-W3 | Math: R-STDP reward modulation implementation | medium |
| STDP-W4 | R-STDP reward_signal backfill pipeline | medium |
| STDP-W5 | Functional test: end-to-end CLI test vs real brain.db | medium |
| STDP-W6 | ADR + plan doc update (Phase 5 DONE with evidence) | small |

IDs populated after `cleo add` runs — see MANIFEST.jsonl.
