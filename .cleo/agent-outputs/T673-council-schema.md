> SUPERSEDED by `T673-council-synthesis.md` and `docs/specs/stdp-wire-up-spec.md` — reference only.
> All decisions from this report are incorporated into the master spec. Do not use this file for implementation guidance.

# T673 Plasticity Council — Schema Councilor Report (Lead A)

**Session**: ses_20260415172452_9cf242
**Date**: 2026-04-15
**Author**: cleo-subagent Schema Councilor (Lead A)
**Task**: T673 (STDP Phase 5 Wire-up, parent T627)
**Status**: COMPLETE

---

## §0 Executive Summary

The prior Lead A report covered only three plasticity-adjacent columns. This expanded whole-picture audit covers **seven tables** (four existing, three proposed new), **twenty-three column additions**, **eleven new indexes**, **four migration files**, and makes a final definitive ruling on the `entry_ids` Q1 format question.

The complete plasticity substrate requires:

1. Migrations to bring `brain_retrieval_log`, `brain_page_edges`, and `brain_plasticity_events` to the level the algorithm needs
2. Two net-new tables: `brain_weight_history` (audit log) and `brain_modulators` (R-STDP neuromodulator events)
3. A Drizzle schema authority file update for ALL of the above
4. Four new migration files with precise sequencing

**Owner consensus item identified**: `brain_weight_history` retention policy (rolling vs all-time) — this report recommends rolling 90 days with a `prune_before` sweep at session end.

---

## §1 Current Schema Inventory

All citations are file:line from the live codebase.

### 1.1 `brain_plasticity_events` — LIVE DDL

Source: `packages/core/src/store/brain-schema.ts:740-770`

**Drizzle declaration (source of truth)**:
```
id           INTEGER PK AUTOINCREMENT
source_node  TEXT NOT NULL
target_node  TEXT NOT NULL
delta_w      REAL NOT NULL
kind         TEXT NOT NULL  CHECK(kind IN ('ltp', 'ltd'))
timestamp    TEXT NOT NULL  DEFAULT (datetime('now'))
session_id   TEXT
```

**Indexes (5)**: source_node, target_node, timestamp, session_id, kind

**Live state**: Table exists (confirmed by T673-stdp-rcasd-plan.md §R1), 0 rows.

**Drizzle-declared but NOT in live table**: `session_id` was declared at `brain-schema.ts:761` but the initial CREATE TABLE predates that column. The INSERT at `brain-stdp.ts:277-279` does NOT include `session_id` in the column list — this is Bug #3 per RCASD plan.

**Gap**: The current 7-column schema is missing:
- `weight_before REAL` — what the edge weighed before this event
- `weight_after REAL` — what the edge weighed after (derivable but expensive to recompute)
- `retrieval_log_id INTEGER` — FK back to `brain_retrieval_log.id` (causal trace)
- `reward_signal REAL` — was this event reward-modulated? (needed for R-STDP observability)
- `delta_t_ms INTEGER` — the actual spike-pair Δt that produced this event (observability)

The `kind` CHECK constraint is already correct. No `decay` or `prune` events should be mixed into this table — those belong in `brain_weight_history`.

### 1.2 `brain_retrieval_log` — LIVE DDL

Source: `packages/core/src/store/brain-schema.ts:694-724` (Drizzle), `packages/core/src/memory/brain-retrieval.ts:1492-1503` (self-healing DDL)

**Drizzle declaration (9 columns)**:
```
id              INTEGER PK AUTOINCREMENT
query           TEXT NOT NULL
entry_ids       TEXT NOT NULL        -- ← FORMAT BUG (comma-sep, must be JSON)
entry_count     INTEGER NOT NULL
source          TEXT NOT NULL
tokens_used     INTEGER
session_id      TEXT                 -- ← declared in Drizzle but MISSING from live table
created_at      TEXT DEFAULT (datetime('now')) NOT NULL
```

**Live table** (confirmed via RCASD §R1 PRAGMA table_info):
```
id, query, entry_ids, entry_count, source, tokens_used, created_at, retrieval_order, delta_ms
```

**Critical discrepancy**: Live table has `retrieval_order` and `delta_ms` that are NOT in the Drizzle schema at `brain-schema.ts:694`. They exist in the self-healing DDL comment at `brain-stdp.ts:133-140` (`RetrievalLogRow` interface), suggesting they were added ad-hoc. The Drizzle schema is MISSING both columns.

**Full gap list for `brain_retrieval_log`**:
- `session_id TEXT` — declared in Drizzle at line 715, missing from live table
- `reward_signal REAL` — per D-BRAIN-VIZ-13, never added anywhere
- `retrieval_order INTEGER` — in live table via self-healing DDL, NOT in Drizzle schema
- `delta_ms INTEGER` — in live table via self-healing DDL, NOT in Drizzle schema

### 1.3 `brain_page_edges` — LIVE DDL

Source: `packages/core/src/store/brain-schema.ts:648-678` (Drizzle), `packages/core/src/migrations/drizzle-brain/20260411000001_t528-graph-schema-expansion/migration.sql`

**Post-T528 DDL** (most current migration):
```
from_id      TEXT NOT NULL
to_id        TEXT NOT NULL
edge_type    TEXT NOT NULL
weight       REAL NOT NULL DEFAULT 1
provenance   TEXT
created_at   TEXT NOT NULL DEFAULT (datetime('now'))
PK: (from_id, to_id, edge_type)
```

**Indexes (3)**: idx_brain_edges_from, idx_brain_edges_to, idx_brain_edges_type

**Gap for plasticity** (per `docs/plans/stdp-feasibility.md:§3.2`):
- `last_reinforced_at TEXT` — when was the last LTP event on this edge?
- `reinforcement_count INTEGER NOT NULL DEFAULT 0` — count of LTP events
- `plasticity_class TEXT NOT NULL DEFAULT 'static'` — 'static' | 'hebbian' | 'stdp'

**Additional columns identified in this audit** (expanding beyond prior schema):
- `last_depressed_at TEXT` — when was the last LTD event? (needed for decay trajectory)
- `depression_count INTEGER NOT NULL DEFAULT 0` — LTD event count
- `stability_score REAL` — 0.0–1.0 biological "consolidation" score (age × reinforcement rate). Null = unknown. Computed at session-end consolidation, not live.

**Rationale for `stability_score`**: The feasibility plan §4 specifies a global decay pass that skips edges where `(now - last_reinforced_at) < decay_threshold`. A precomputed `stability_score` enables fast filtering in the decay pass without a datetime subtraction per row. See §5.3.

### 1.4 `brain_page_nodes` — CURRENT STATE

Source: `packages/core/src/store/brain-schema.ts:589-639`

No plasticity-specific additions needed. Nodes are structural and don't carry plasticity state. The `qualityScore` column already reflects node-level quality. No action.

### 1.5 `brain_weight_history` — PROPOSED (does NOT exist)

Source: `docs/plans/stdp-feasibility.md:§3.4` (Phase 7 note), owner directive in this session promotes it to in-scope.

Confirmed: no table, no Drizzle declaration, no migration. Zero rows.

### 1.6 `brain_modulators` — PROPOSED (does NOT exist)

New table for R-STDP neuromodulator events. No prior definition exists anywhere in codebase or docs. This is a net-new proposal from this audit.

### 1.7 `brain_consolidation_events` — PROPOSED (borderline)

The `runConsolidation` function at `brain-lifecycle.ts:606` runs a multi-step pipeline but logs nothing to any event table. If Phase 6 auto-dream cycle (T628) lands, consolidation-event tracking becomes essential for debugging and replay.

**Conclusion**: Include a lightweight `brain_consolidation_events` table now to avoid a retroactive migration when T628 ships. The table should be simple: one row per consolidation run, with step results as JSON. This gives observability without locking in a complex schema prematurely.

---

## §2 Q1 Answer: `entry_ids` Format Decision

**Question**: Should `entry_ids` be (a) comma-separated string, (b) JSON array string, or (c) normalized junction table `brain_retrieval_entries(retrieval_id, entry_id, rank)`?

### 2.1 Option Analysis

**Option A — comma-separated string (current)**

*Current state*: `logRetrieval` at `brain-retrieval.ts:1517` stores `entryIds.join(',')`.

*Bugs today*:
- `strengthenCoRetrievedEdges` at `brain-lifecycle.ts:971` calls `JSON.parse(row.entry_ids)` — **parse error on every row, returns 0 edges**
- `applyStdpPlasticity` at `brain-stdp.ts:235` also calls `JSON.parse(row.entry_ids)` — **zero events produced** (this is the confirmed root cause)
- Cannot query "which retrievals included entry X" without full table scan + string matching

**Verdict**: REJECTED. Definitively broken. Two separate readers depend on JSON; comma-sep produces silent parse failures.

**Option B — JSON array string**

*Proposal*: Store `JSON.stringify(entryIds)`, e.g., `'["obs:abc","obs:def"]'`.

*Pros*: Simple, fixes both parse failures with a one-line writer change. Compatible with the existing readers. No schema change.

*Cons*: Cannot index into individual entry IDs — every "find all retrievals containing entry X" requires a full table scan with `json_each()` or `LIKE '%entry_id%'` (unreliable).

*Query pattern required for STDP*: The STDP algorithm at `brain-stdp.ts:210-219` reads ALL retrieval rows in the time window (up to 2000) and parses each in application code. This is fine for the current scale (38 rows today, 1000s expected). No per-entry indexing is needed for the STDP algorithm.

*Future query pattern* that would benefit from option C: "show me all sessions where entry X was retrieved" — useful for Studio viz and debugging, but not required for Phase 5.

**Verdict**: ACCEPTED for Phase 5 scope. Correct for algorithm operation.

**Option C — normalized junction table `brain_retrieval_entries(retrieval_id, entry_id, rank)`**

*Proposal*: A separate table with rows `(retrieval_id FK, entry_id TEXT, rank INTEGER)`.

*Pros*:
- SQL-native index on `entry_id` — `SELECT DISTINCT retrieval_id FROM brain_retrieval_entries WHERE entry_id = 'obs:abc'` runs in microseconds even at 100K rows
- Natural aggregate queries: `GROUP BY entry_id HAVING COUNT(*) > 3` replaces the in-memory co-occurrence map in `strengthenCoRetrievedEdges`
- Rank column preserves intra-retrieval ordering natively (currently lost in JSON)
- Deletion cascade: when a brain entry is purged, its retrieval history can be cleaned up with a single DELETE WHERE entry_id = ?

*Cons*:
- Schema break: existing 38 rows need decomposition into junction rows
- Every `logRetrieval` call becomes a multi-row INSERT instead of one
- The Hebbian co-occurrence query becomes a JOIN instead of application-code iteration — BUT this is actually faster at scale
- Added complexity in `brain-sqlite.ts` self-healing DDL (need to also create the junction table)

*Query comparison*:

**Option B — find co-occurrence count (current Hebbian algorithm)**:
```sql
-- Requires fetching all 1000 rows into application, parsing JSON, computing map in memory
SELECT entry_ids FROM brain_retrieval_log WHERE created_at >= ? LIMIT 1000
-- then: for each row JSON.parse → build co-occurrence map in TypeScript
```

**Option C — same query**:
```sql
-- Pure SQL, index-driven, no application-layer parsing
SELECT a.entry_id AS pre, b.entry_id AS post, COUNT(*) AS co_count
FROM brain_retrieval_entries a
JOIN brain_retrieval_entries b ON a.retrieval_id = b.retrieval_id AND a.entry_id < b.entry_id
WHERE a.retrieval_id IN (
  SELECT id FROM brain_retrieval_log WHERE created_at >= ?
)
GROUP BY pre, post
HAVING co_count >= 3
ORDER BY co_count DESC
```

At 10K retrieval rows, Option B requires loading and parsing 10K JSON strings in application code. Option C executes in one SQL pass with index support.

**Additional Option C advantage for STDP**:
```sql
-- Find all spike pairs within the session window — no JSON parsing in application
SELECT a.entry_id AS pre_id, b.entry_id AS post_id,
       rl_a.created_at AS pre_time, rl_b.created_at AS post_time,
       CAST((julianday(rl_b.created_at) - julianday(rl_a.created_at)) * 86400000 AS INTEGER) AS delta_ms
FROM brain_retrieval_entries a
JOIN brain_retrieval_log rl_a ON a.retrieval_id = rl_a.id
JOIN brain_retrieval_entries b ON b.retrieval_id >= a.retrieval_id
  AND b.entry_id != a.entry_id
JOIN brain_retrieval_log rl_b ON b.retrieval_id = rl_b.id
WHERE rl_a.created_at >= ?
  AND delta_ms BETWEEN 0 AND 300000  -- 5 min window
ORDER BY pre_time ASC, post_time ASC
```

This runs entirely in SQLite with indexes. No application-layer for loop over 2000 items.

### 2.2 Final Ruling

**DECISION: Phase 5 adopts Option B (JSON array). Phase 6+ adopts Option C (normalized junction).**

**Rationale**:

Phase 5 must fix the broken state (0 events) as fast as possible. The algorithmic change from comma-sep to JSON array is a one-line writer fix plus a one-query migration — ships in STDP-W1. The current 38-row scale does not justify a schema normalization.

Option C is the correct long-term architecture and SHOULD be implemented before the retrieval log grows beyond ~10K rows. A future task (see §7 open questions — tag for Algorithm Lead B) should implement the junction table migration.

**Phase 5 minimum viable fix**:
1. Change `brain-retrieval.ts:1517` from `entryIds.join(',')` to `JSON.stringify(entryIds)` (STDP-W2 scope)
2. Run one-time idempotent migration: `UPDATE brain_retrieval_log SET entry_ids = '["' || REPLACE(entry_ids, ',', '","') || '"]' WHERE entry_ids NOT LIKE '[%'` (STDP-W1 migration)

**Note on existing 38 rows**: These are real historical retrievals with diagnostic value. They MUST be migrated to JSON format, NOT truncated.

---

## §3 Complete Gap Analysis

### 3.1 What Is Missing for a Full Plasticity Substrate

| Table | Missing Column/Feature | Needed For | Phase |
|-------|----------------------|------------|-------|
| `brain_retrieval_log` | `session_id` (not in live table) | STDP session grouping | 5 |
| `brain_retrieval_log` | `reward_signal REAL` | R-STDP modulation | 5 |
| `brain_retrieval_log` | `retrieval_order` in Drizzle schema | Parity with live table | 5 |
| `brain_retrieval_log` | `delta_ms` in Drizzle schema | Parity with live table | 5 |
| `brain_retrieval_log` | entry_ids = JSON not comma-sep | Algorithm correctness | 5 |
| `brain_plasticity_events` | `weight_before REAL` | Observability/audit | 5 |
| `brain_plasticity_events` | `weight_after REAL` | Observability/audit | 5 |
| `brain_plasticity_events` | `retrieval_log_id INTEGER` | Causal trace | 5 |
| `brain_plasticity_events` | `reward_signal REAL` | R-STDP event observability | 5 |
| `brain_plasticity_events` | `delta_t_ms INTEGER` | STDP window analysis | 5 |
| `brain_page_edges` | `last_reinforced_at TEXT` | Decay pass filtering | 5 |
| `brain_page_edges` | `reinforcement_count INTEGER` | Plasticity class promotion | 5 |
| `brain_page_edges` | `plasticity_class TEXT` | Static/Hebbian/STDP routing | 5 |
| `brain_page_edges` | `last_depressed_at TEXT` | LTD audit | 5b |
| `brain_page_edges` | `depression_count INTEGER` | LTD audit | 5b |
| `brain_page_edges` | `stability_score REAL` | Fast decay-pass filter | 5b |
| `brain_weight_history` | entire table | Weight audit log | 4→5 (elevated) |
| `brain_modulators` | entire table | R-STDP dopamine events | 5b |
| `brain_consolidation_events` | entire table | Pipeline observability | 5b |

### 3.2 What IS Working

- `brain_plasticity_events` table structure (6 core columns) — correct, just empty
- `applyStdpPlasticity` algorithm — math is correct per RCASD §R2
- `getPlasticityStats` — works when there are rows
- `strengthenCoRetrievedEdges` — logic is correct but broken by `entry_ids` format bug
- Drizzle schema for `brain_page_edges`, `brain_page_nodes` — current and correct
- `brain-sqlite.ts:runBrainMigrations` `ensureColumns` pattern — proven, use it

---

## §4 Proposed Schema (Drizzle ORM Style)

All proposed Drizzle additions match the patterns in `packages/core/src/store/brain-schema.ts`.

### 4.1 `brain_retrieval_log` — Full Target Schema

**Additions to `packages/core/src/store/brain-schema.ts` after line 724**:

```typescript
// Add to brainRetrievalLog column definitions (brain-schema.ts:694):

/** Sequence position of this retrieval within a batch query. Null for single-entry fetches. */
retrievalOrder: integer('retrieval_order'),

/** Wall-clock milliseconds since the previous retrieval in the same batch. Null for first-in-batch. */
deltaMs: integer('delta_ms'),

/** Session ID (soft FK to tasks.db sessions). Enables R-STDP reward backfill. */
// NOTE: Already declared at line 715. Already correct. MISSING only from live table.
sessionId: text('session_id'),

/**
 * R-STDP reward signal: scalar [-1.0, +1.0], null = unlabeled.
 * Populated by backfillRewardSignals() at session end.
 * +1.0 = task verified and passed | +0.5 = task done (unverified) | -0.5 = task cancelled
 * Per D-BRAIN-VIZ-13.
 */
rewardSignal: real('reward_signal'),
```

**Updated index block**:
```typescript
(table) => [
  index('idx_retrieval_log_created').on(table.createdAt),
  index('idx_retrieval_log_source').on(table.source),
  index('idx_retrieval_log_session').on(table.sessionId),   // already declared
  // NEW:
  index('idx_retrieval_log_reward').on(table.rewardSignal), // per feasibility §3.3
],
```

**Type exports** (add after line 775):
```typescript
// UPDATE existing type — remove old definition if present:
export type BrainRetrievalLogRow = typeof brainRetrievalLog.$inferSelect;
export type NewBrainRetrievalLogRow = typeof brainRetrievalLog.$inferInsert;
```

### 4.2 `brain_plasticity_events` — Expanded Schema

**Additions to `brainPlasticityEvents` column definitions (brain-schema.ts:740-770)**:

```typescript
/**
 * Edge weight immediately BEFORE this plasticity event was applied.
 * Null on the first LTP event that inserts a new edge (edge didn't exist).
 * Enables "show learning history" in Studio viz without querying brain_weight_history.
 */
weightBefore: real('weight_before'),

/**
 * Edge weight immediately AFTER this plasticity event was applied.
 * Computed as CLAMP(weight_before + delta_w, 0.0, 1.0).
 * Redundant with delta_w but enables fast before/after display without arithmetic.
 */
weightAfter: real('weight_after'),

/**
 * FK (soft) to brain_retrieval_log.id — the retrieval row that triggered this pair.
 * Null for externally-triggered or legacy events.
 * Enables: "which memory retrieval caused this edge to strengthen?"
 */
retrievalLogId: integer('retrieval_log_id'),

/**
 * R-STDP reward signal active when this event fired.
 * Copied from the retrieval_log row's reward_signal at time of plasticity pass.
 * Null = unmodulated. Denormalized for fast filtering without a JOIN.
 */
rewardSignal: real('reward_signal'),

/**
 * Wall-clock milliseconds between the two spikes that generated this event.
 * Pre-computed at INSERT time — avoids re-deriving from retrieval timestamps.
 * Enables analysis of STDP window distribution.
 */
deltaTMs: integer('delta_t_ms'),
```

**Updated index block**:
```typescript
(table) => [
  index('idx_plasticity_source').on(table.sourceNode),
  index('idx_plasticity_target').on(table.targetNode),
  index('idx_plasticity_timestamp').on(table.timestamp),
  index('idx_plasticity_session').on(table.sessionId),
  index('idx_plasticity_kind').on(table.kind),
  // NEW:
  index('idx_plasticity_retrieval_log').on(table.retrievalLogId),  // causal trace join
  index('idx_plasticity_reward').on(table.rewardSignal),           // R-STDP analysis
],
```

**New type exports**:
```typescript
export type BrainPlasticityEventRow = typeof brainPlasticityEvents.$inferSelect;
export type NewBrainPlasticityEventRow = typeof brainPlasticityEvents.$inferInsert;
```

### 4.3 `brain_page_edges` — Plasticity Columns

**Additions to `brainPageEdges` column definitions (brain-schema.ts:648-678)**:

```typescript
/**
 * ISO 8601 timestamp of the last LTP event applied to this edge.
 * Used by the decay pass: edges with (now - last_reinforced_at) > decay_threshold_days
 * receive a per-day weight decay. Null = never reinforced (structural/semantic edges).
 * Only populated when plasticity_class IN ('hebbian', 'stdp').
 */
lastReinforcedAt: text('last_reinforced_at'),

/**
 * Count of LTP (potentiation) events applied to this edge lifetime.
 * Incremented on every LTP write. Used to promote plasticity_class from
 * 'hebbian' → 'stdp' when STDP transitions take over.
 * Also surfaced in Studio viz as "edge strength history".
 */
reinforcementCount: integer('reinforcement_count').notNull().default(0),

/**
 * Plasticity class — governs which algorithm(s) write to this edge.
 *
 * - 'static': Non-plastic edge (structural, semantic, code_reference, etc.)
 *             Immune to decay pass. Weight is 1.0 and never changes.
 * - 'hebbian': Written by strengthenCoRetrievedEdges (co-occurrence ≥ 3).
 *              Subject to decay when not reinforced.
 * - 'stdp':   Written or refined by applyStdpPlasticity.
 *              Subject to decay and LTD depression.
 *
 * Edges start as 'static' for all non-co_retrieved types.
 * co_retrieved edges start as 'hebbian', can be upgraded to 'stdp'.
 * Per docs/plans/stdp-feasibility.md §3.2.
 */
plasticityClass: text('plasticity_class', {
  enum: ['static', 'hebbian', 'stdp'] as const,
}).notNull().default('static'),

/**
 * ISO 8601 timestamp of the last LTD (depression) event on this edge.
 * Null = never depressed. Used for debugging and Studio viz animation.
 */
lastDepressedAt: text('last_depressed_at'),

/**
 * Count of LTD (depression) events applied to this edge lifetime.
 * Enables analysis of edges that are being persistently weakened.
 */
depressionCount: integer('depression_count').notNull().default(0),

/**
 * Biological-analog stability score: 0.0 (unstable) – 1.0 (consolidated).
 *
 * Computed by runConsolidation decay pass as:
 *   stability = tanh(reinforcement_count / 10) × exp(-(days_since_reinforced / 30))
 *
 * Null = not yet computed (new edges). Enables fast filtering in decay pass:
 * edges with stability > 0.9 skip the full decay recalculation (long-term memory
 * consolidation analog — edges that have been frequently reinforced over a long
 * period are resistant to forgetting).
 *
 * Updated at session-end consolidation, NOT per-event.
 */
stabilityScore: real('stability_score'),
```

**Updated index block**:
```typescript
(table) => [
  primaryKey({ columns: [table.fromId, table.toId, table.edgeType] }),
  index('idx_brain_edges_from').on(table.fromId),
  index('idx_brain_edges_to').on(table.toId),
  index('idx_brain_edges_type').on(table.edgeType),
  // NEW:
  index('idx_brain_edges_last_reinforced').on(table.lastReinforcedAt),  // decay pass filter
  index('idx_brain_edges_plasticity_class').on(table.plasticityClass),  // class routing
  index('idx_brain_edges_stability').on(table.stabilityScore),          // fast stable-edge skip
],
```

**New type exports**:
```typescript
export type BrainPageEdgeRow = typeof brainPageEdges.$inferSelect;
export type NewBrainPageEdgeRow = typeof brainPageEdges.$inferInsert;
```

### 4.4 `brain_weight_history` — Full Spec (Q4)

**New table declaration** (insert after `brainPlasticityEvents` in `brain-schema.ts:770`):

```typescript
// ============================================================================
// WEIGHT HISTORY — audit log of every edge weight change (T673 Phase 5)
// ============================================================================

/**
 * Immutable audit log of every weight change applied to brain_page_edges rows.
 *
 * Written for all plasticity_class != 'static' edges on every LTP, LTD, decay,
 * or prune event. Enables "show learning history of this edge" in Studio viz
 * (Phase 6) and supports forensic debugging of plasticity behavior.
 *
 * Retention policy: rolling 90 days. runConsolidation Step 9c (decay pass)
 * includes a DELETE WHERE changed_at < (now - 90 days) sweep. Rationale: the
 * plasticity_events table captures the high-level view; weight_history is low-
 * level detail that loses value after 90 days. Owner may tune via cleo config.
 *
 * @task T673
 * @epic T627
 */
export const brainWeightHistory = sqliteTable(
  'brain_weight_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** from_id of the affected brain_page_edges row. */
    edgeFromId: text('edge_from_id').notNull(),

    /** to_id of the affected brain_page_edges row. */
    edgeToId: text('edge_to_id').notNull(),

    /**
     * edge_type of the affected brain_page_edges row.
     * Included so weight_history rows can be queried without joining back to edges.
     * This column matches BRAIN_EDGE_TYPES but is NOT constrained by the enum —
     * future edge types should not break historical records.
     */
    edgeType: text('edge_type').notNull(),

    /**
     * Edge weight immediately before this change event.
     * Null for the very first event on a newly-inserted edge.
     */
    weightBefore: real('weight_before'),

    /** Edge weight immediately after this change event. Always non-null. */
    weightAfter: real('weight_after').notNull(),

    /**
     * Signed weight delta: weightAfter - weightBefore.
     * Positive = potentiation. Negative = depression or decay.
     * Stored explicitly to avoid floating-point subtraction divergence.
     */
    deltaWeight: real('delta_weight').notNull(),

    /**
     * Event kind — what caused this weight change.
     * - 'ltp': Long-Term Potentiation from STDP pass
     * - 'ltd': Long-Term Depression from STDP pass
     * - 'hebbian': Co-retrieval Hebbian strengthening (+0.1 flat)
     * - 'decay': Session-end exponential decay (weight × (1 - decay_rate))
     * - 'prune': Edge pruned because weight < min_weight threshold
     * - 'external': Manual admin override or import operation
     */
    eventKind: text('event_kind', {
      enum: ['ltp', 'ltd', 'hebbian', 'decay', 'prune', 'external'] as const,
    }).notNull(),

    /**
     * FK (soft) to brain_plasticity_events.id — the STDP event that triggered this.
     * Null for Hebbian, decay, prune, and external events.
     * Enables: JOIN brain_weight_history ON source_plasticity_event_id = brain_plasticity_events.id
     */
    sourcePlasticityEventId: integer('source_plasticity_event_id'),

    /**
     * FK (soft) to brain_retrieval_log.id — the retrieval that ultimately caused this.
     * Null for decay/prune events (not retrieval-driven).
     */
    retrievalLogId: integer('retrieval_log_id'),

    /**
     * R-STDP reward signal at time of event. Copied from retrieval_log.reward_signal.
     * Null for decay/prune/external events.
     */
    rewardSignal: real('reward_signal'),

    /** ISO 8601 timestamp when this weight change was applied. */
    changedAt: text('changed_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_weight_history_edge').on(table.edgeFromId, table.edgeToId, table.edgeType),
    index('idx_weight_history_from').on(table.edgeFromId),
    index('idx_weight_history_to').on(table.edgeToId),
    index('idx_weight_history_changed_at').on(table.changedAt),            // retention sweep
    index('idx_weight_history_event_kind').on(table.eventKind),            // decay/prune analysis
    index('idx_weight_history_plasticity_event').on(table.sourcePlasticityEventId), // causal trace
  ],
);
```

**Type exports**:
```typescript
export type BrainWeightHistoryRow = typeof brainWeightHistory.$inferSelect;
export type NewBrainWeightHistoryRow = typeof brainWeightHistory.$inferInsert;
```

**Retention policy** (owner consensus item):

This report recommends **rolling 90 days**. Rationale:
- `brain_plasticity_events` (no retention) captures the high-level LTP/LTD count view; weight_history is for forensics
- At 10 plasticity events/session and 10 sessions/week: ~100 rows/week → 1,300 rows at 90 days → negligible
- At aggressive scale (1000 events/day): 90,000 rows at 90 days — still <10MB
- Drizzle v1 does not support row TTL natively; the sweep is one DELETE statement in `runConsolidation`

**Alternative**: all-time retention. Would require explicit `VACUUM` or `cleo brain maintenance` to manage size. Not recommended unless the owner wants a permanent learning curve for an edge.

### 4.5 `brain_modulators` — Neuromodulator Events Table

**New table declaration** (insert after `brainWeightHistory` in `brain-schema.ts`):

```typescript
// ============================================================================
// BRAIN MODULATORS — neuromodulator events for R-STDP (T673 Phase 5b)
// ============================================================================

/**
 * Neuromodulator event log — records discrete "dopamine-like" signals that
 * modulate STDP plasticity via the R-STDP reward gating mechanism.
 *
 * In biological systems, dopamine (and other neuromodulators) gate synaptic
 * plasticity — without a "third factor", Hebbian rules are destabilizing.
 * In CLEO, the analog sources are:
 *   - Task completion + verification (owned by backfillRewardSignals)
 *   - Owner explicit confirmation (`cleo memory verify`)
 *   - Session summary valence (success vs blocker)
 *
 * This table allows R-STDP to reference discrete modulator events rather than
 * just a scalar on brain_retrieval_log. Enables "show me what reward signals
 * were active during this plasticity pass" in Studio viz.
 *
 * @task T673
 * @epic T627
 */
export const brainModulators = sqliteTable(
  'brain_modulators',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /**
     * Modulator type — what kind of reward signal this represents.
     * - 'task_verified': task completed with verification.passed = true
     * - 'task_completed': task completed without full verification (+0.5 reward)
     * - 'task_cancelled': task abandoned (-0.5 reward)
     * - 'owner_verify': explicit `cleo memory verify` invocation (+1.0)
     * - 'session_success': session summary classified as successful (+0.3)
     * - 'session_blocker': session summary classified as blocked (-0.3)
     * - 'external': manually injected via future `cleo brain modulate` command
     */
    modulatorType: text('modulator_type', {
      enum: [
        'task_verified',
        'task_completed',
        'task_cancelled',
        'owner_verify',
        'session_success',
        'session_blocker',
        'external',
      ] as const,
    }).notNull(),

    /**
     * Reward valence: scalar in [-1.0, +1.0].
     * Negative = punishment/suppression signal (weakens relevant associations).
     * Positive = reward signal (strengthens relevant associations).
     * Zero = neutral (rare; included for completeness).
     */
    valence: real('valence').notNull(),

    /**
     * Magnitude: 0.0 – 1.0 scaling factor on top of valence.
     * Valence encodes sign+direction; magnitude encodes confidence.
     * Effective reward = valence × magnitude.
     * Default 1.0 (full confidence).
     */
    magnitude: real('magnitude').notNull().default(1.0),

    /**
     * Source event identifier — what caused this modulator event.
     * For task_verified/completed/cancelled: the task ID (e.g., 'T673')
     * For owner_verify: the memory entry ID being verified
     * For session_*: the session ID (e.g., 'ses_20260415170242_ad53d5')
     */
    sourceEventId: text('source_event_id'),

    /**
     * Session ID during which this modulator event was recorded.
     * Soft FK to tasks.db sessions.
     * Required for the backfillRewardSignals JOIN: modulator events are
     * matched to retrieval_log rows via shared session_id.
     */
    sessionId: text('session_id'),

    /**
     * Human-readable description of why this modulator was emitted.
     * Optional. Example: "Task T673 completed with verification.passed=true"
     */
    description: text('description'),

    /** ISO 8601 timestamp when this modulator event was recorded. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_modulators_type').on(table.modulatorType),
    index('idx_modulators_session').on(table.sessionId),
    index('idx_modulators_created_at').on(table.createdAt),
    index('idx_modulators_source_event').on(table.sourceEventId),
    index('idx_modulators_valence').on(table.valence),  // filter negative events
  ],
);
```

**Type exports**:
```typescript
export type BrainModulatorRow = typeof brainModulators.$inferSelect;
export type NewBrainModulatorRow = typeof brainModulators.$inferInsert;
```

### 4.6 `brain_consolidation_events` — Pipeline Observability

**New table declaration** (insert after `brainModulators`):

```typescript
// ============================================================================
// CONSOLIDATION EVENTS — pipeline run log (T673 Phase 5b)
// ============================================================================

/**
 * Records each execution of the runConsolidation pipeline.
 *
 * One row per consolidation run. The step_results_json column stores
 * the ConsolidationResult object for diagnostics without a complex column
 * schema. This table is append-only; rows are never updated.
 *
 * Enables: `cleo brain consolidation history` command (future).
 * Also enables T628 auto-dream cycle to detect when consolidation last ran.
 *
 * @task T673
 * @epic T627
 */
export const brainConsolidationEvents = sqliteTable(
  'brain_consolidation_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /**
     * Trigger source — what initiated this consolidation run.
     * - 'session_end': triggered by PostSessionEnd hook
     * - 'maintenance': triggered by `cleo brain maintenance`
     * - 'scheduled': triggered by future auto-dream cycle (T628)
     * - 'manual': triggered by owner via CLI or API
     */
    trigger: text('trigger', {
      enum: ['session_end', 'maintenance', 'scheduled', 'manual'] as const,
    }).notNull(),

    /** Session ID that triggered this run (if trigger = 'session_end'). */
    sessionId: text('session_id'),

    /**
     * JSON-serialized ConsolidationResult — all step counts and metrics.
     * Schema matches packages/core/src/memory/brain-lifecycle.ts:ConsolidationResult.
     * Stored as JSON to avoid schema churn when new pipeline steps are added.
     */
    stepResultsJson: text('step_results_json').notNull(),

    /**
     * Wall-clock milliseconds the full pipeline took.
     * Enables performance regression detection.
     */
    durationMs: integer('duration_ms'),

    /**
     * Whether the pipeline completed successfully (no step threw an unhandled error).
     * Some steps catch errors gracefully — this flag indicates catastrophic failure.
     */
    succeeded: integer('succeeded', { mode: 'boolean' }).notNull().default(true),

    /** ISO 8601 timestamp when this consolidation run started. */
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_consolidation_events_started_at').on(table.startedAt),  // most recent run query
    index('idx_consolidation_events_trigger').on(table.trigger),        // filter by trigger type
    index('idx_consolidation_events_session').on(table.sessionId),      // session history
  ],
);
```

**Type exports**:
```typescript
export type BrainConsolidationEventRow = typeof brainConsolidationEvents.$inferSelect;
export type NewBrainConsolidationEventRow = typeof brainConsolidationEvents.$inferInsert;
```

---

## §5 Migration Plan

### 5.1 Migration Naming Convention

Established pattern from `packages/core/migrations/drizzle-brain/`:
```
YYYYMMDDNNNNNN_<slug>/migration.sql
```

Latest existing: `20260415000001_t626-normalize-co-retrieved-edge-type`

Next migrations must use `20260416` prefix (day-after) to guarantee ordering.

### 5.2 Migration Sequence (Four Files)

**File 1**: `packages/core/migrations/drizzle-brain/20260416000001_t673-retrieval-log-plasticity-columns/migration.sql`

Scope: Adds `session_id`, `reward_signal`, `retrieval_order`, `delta_ms` to `brain_retrieval_log`. Converts `entry_ids` format. Adds `idx_retrieval_log_reward` index.

```sql
-- T673-M1: Add plasticity columns to brain_retrieval_log
-- and convert entry_ids from comma-separated to JSON array format.
--
-- background:
--   session_id: declared in Drizzle schema at brain-schema.ts:715 but never applied
--     to the live table (self-healing DDL in brain-retrieval.ts:1492 creates a newer
--     table with session_id, but ALTER TABLE was never run for existing installs).
--   reward_signal: D-BRAIN-VIZ-13 requirement; missing entirely.
--   retrieval_order, delta_ms: existed via self-healing DDL but missing from Drizzle schema.
--   entry_ids: stored as comma-separated strings; JSON.parse callers in brain-lifecycle.ts:971
--     and brain-stdp.ts:235 fail silently, producing 0 Hebbian edges and 0 STDP events.
--
-- Safety: all ALTER TABLE ADD COLUMN statements are additive with defaults.
-- The entry_ids UPDATE migration is idempotent (WHERE NOT LIKE '[%' guard).

ALTER TABLE `brain_retrieval_log` ADD COLUMN `session_id` text;
--> statement-breakpoint
ALTER TABLE `brain_retrieval_log` ADD COLUMN `reward_signal` real;
--> statement-breakpoint
ALTER TABLE `brain_retrieval_log` ADD COLUMN `retrieval_order` integer;
--> statement-breakpoint
ALTER TABLE `brain_retrieval_log` ADD COLUMN `delta_ms` integer;
--> statement-breakpoint

-- Convert existing comma-separated entry_ids to JSON array format.
-- Idempotent: rows already in JSON format (entry_ids LIKE '[%') are not touched.
-- Edge case: empty entry_ids or single entry_id produce valid JSON arrays.
UPDATE `brain_retrieval_log`
SET entry_ids = '["' || REPLACE(entry_ids, ',', '","') || '"]'
WHERE entry_ids IS NOT NULL
  AND entry_ids != ''
  AND entry_ids NOT LIKE '[%';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_retrieval_log_reward` ON `brain_retrieval_log` (`reward_signal`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_retrieval_log_session` ON `brain_retrieval_log` (`session_id`);
```

**File 2**: `packages/core/migrations/drizzle-brain/20260416000002_t673-plasticity-events-expand/migration.sql`

Scope: Adds `weight_before`, `weight_after`, `retrieval_log_id`, `reward_signal`, `delta_t_ms` to `brain_plasticity_events`. Adds two new indexes.

```sql
-- T673-M2: Expand brain_plasticity_events with observability columns.
-- All columns are nullable with no default — existing 0-row table is unaffected.
-- New INSERT statements in brain-stdp.ts MUST populate these columns going forward.

ALTER TABLE `brain_plasticity_events` ADD COLUMN `weight_before` real;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `weight_after` real;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `retrieval_log_id` integer;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `reward_signal` real;
--> statement-breakpoint
ALTER TABLE `brain_plasticity_events` ADD COLUMN `delta_t_ms` integer;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_plasticity_retrieval_log` ON `brain_plasticity_events` (`retrieval_log_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_plasticity_reward` ON `brain_plasticity_events` (`reward_signal`);
```

**File 3**: `packages/core/migrations/drizzle-brain/20260416000003_t673-page-edges-plasticity-columns/migration.sql`

Scope: Adds plasticity tracking columns to `brain_page_edges`. Seeds existing `co_retrieved` edges with `plasticity_class = 'hebbian'`.

```sql
-- T673-M3: Add plasticity tracking columns to brain_page_edges.
--
-- These columns enable:
--   - applyStdpPlasticity to update last_reinforced_at and reinforcement_count per LTP event
--   - The decay pass to filter by plasticity_class (skip 'static' edges)
--   - Studio viz to display edge plasticity state and reinforcement history
--
-- Seeding strategy:
--   - All existing edges: plasticity_class = 'static' (safe default)
--   - co_retrieved edges override to 'hebbian' (they were created by Hebbian strengthener)

ALTER TABLE `brain_page_edges` ADD COLUMN `last_reinforced_at` text;
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `reinforcement_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `plasticity_class` text NOT NULL DEFAULT 'static';
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `last_depressed_at` text;
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `depression_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `brain_page_edges` ADD COLUMN `stability_score` real;
--> statement-breakpoint

-- Seed: co_retrieved edges are Hebbian-origin, not static
UPDATE `brain_page_edges`
SET plasticity_class = 'hebbian'
WHERE edge_type = 'co_retrieved';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_edges_last_reinforced` ON `brain_page_edges` (`last_reinforced_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_plasticity_class` ON `brain_page_edges` (`plasticity_class`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_stability` ON `brain_page_edges` (`stability_score`);
```

**File 4**: `packages/core/migrations/drizzle-brain/20260416000004_t673-new-plasticity-tables/migration.sql`

Scope: Creates `brain_weight_history`, `brain_modulators`, `brain_consolidation_events`.

```sql
-- T673-M4: Create new plasticity infrastructure tables.
--
-- brain_weight_history: immutable audit log of edge weight changes.
--   Retention: rolling 90 days (DELETE sweep in runConsolidation Step 9c).
-- brain_modulators: discrete neuromodulator events for R-STDP third-factor gating.
-- brain_consolidation_events: pipeline run log for observability and T628 scheduling.

CREATE TABLE IF NOT EXISTS `brain_weight_history` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `edge_from_id` text NOT NULL,
  `edge_to_id` text NOT NULL,
  `edge_type` text NOT NULL,
  `weight_before` real,
  `weight_after` real NOT NULL,
  `delta_weight` real NOT NULL,
  `event_kind` text NOT NULL,
  `source_plasticity_event_id` integer,
  `retrieval_log_id` integer,
  `reward_signal` real,
  `changed_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_edge` ON `brain_weight_history` (`edge_from_id`, `edge_to_id`, `edge_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_from` ON `brain_weight_history` (`edge_from_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_to` ON `brain_weight_history` (`edge_to_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_changed_at` ON `brain_weight_history` (`changed_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_event_kind` ON `brain_weight_history` (`event_kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_weight_history_plasticity_event` ON `brain_weight_history` (`source_plasticity_event_id`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `brain_modulators` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `modulator_type` text NOT NULL,
  `valence` real NOT NULL,
  `magnitude` real NOT NULL DEFAULT 1.0,
  `source_event_id` text,
  `session_id` text,
  `description` text,
  `created_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_type` ON `brain_modulators` (`modulator_type`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_session` ON `brain_modulators` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_created_at` ON `brain_modulators` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_source_event` ON `brain_modulators` (`source_event_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_modulators_valence` ON `brain_modulators` (`valence`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `brain_consolidation_events` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `trigger` text NOT NULL,
  `session_id` text,
  `step_results_json` text NOT NULL,
  `duration_ms` integer,
  `succeeded` integer NOT NULL DEFAULT 1,
  `started_at` text NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_consolidation_events_started_at` ON `brain_consolidation_events` (`started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_consolidation_events_trigger` ON `brain_consolidation_events` (`trigger`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_consolidation_events_session` ON `brain_consolidation_events` (`session_id`);
```

### 5.3 `ensureColumns` Safety Net

Per established pattern in `brain-sqlite.ts:runBrainMigrations`, all new columns MUST have `ensureColumns` entries added to the `runBrainMigrations` function. This handles installs where the journal reconciler marks a migration applied without actually running the SQL.

Add to `packages/core/src/store/brain-sqlite.ts` in `runBrainMigrations`:

```typescript
// T673: plasticity columns on brain_retrieval_log
if (tableExists(nativeDb, 'brain_retrieval_log')) {
  ensureColumns(
    nativeDb,
    'brain_retrieval_log',
    [
      { name: 'session_id', ddl: 'text' },
      { name: 'reward_signal', ddl: 'real' },
      { name: 'retrieval_order', ddl: 'integer' },
      { name: 'delta_ms', ddl: 'integer' },
    ],
    'brain',
  );
}

// T673: observability columns on brain_plasticity_events
if (tableExists(nativeDb, 'brain_plasticity_events')) {
  ensureColumns(
    nativeDb,
    'brain_plasticity_events',
    [
      { name: 'weight_before', ddl: 'real' },
      { name: 'weight_after', ddl: 'real' },
      { name: 'retrieval_log_id', ddl: 'integer' },
      { name: 'reward_signal', ddl: 'real' },
      { name: 'delta_t_ms', ddl: 'integer' },
    ],
    'brain',
  );
}

// T673: plasticity tracking columns on brain_page_edges
ensureColumns(
  nativeDb,
  'brain_page_edges',
  [
    { name: 'last_reinforced_at', ddl: 'text' },
    { name: 'reinforcement_count', ddl: 'integer NOT NULL DEFAULT 0' },
    { name: 'plasticity_class', ddl: "text NOT NULL DEFAULT 'static'" },
    { name: 'last_depressed_at', ddl: 'text' },
    { name: 'depression_count', ddl: 'integer NOT NULL DEFAULT 0' },
    { name: 'stability_score', ddl: 'real' },
  ],
  'brain',
);

// T673: new plasticity tables (CREATE IF NOT EXISTS — idempotent)
// These tables are NOT managed by the Drizzle migration system initially;
// they use self-healing CREATE TABLE IF NOT EXISTS as the safety net.
// The migration file (M4) creates them first; this guard handles older installs.
nativeDb.exec(`
  CREATE TABLE IF NOT EXISTS brain_weight_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    edge_from_id TEXT NOT NULL, edge_to_id TEXT NOT NULL, edge_type TEXT NOT NULL,
    weight_before REAL, weight_after REAL NOT NULL, delta_weight REAL NOT NULL,
    event_kind TEXT NOT NULL, source_plasticity_event_id INTEGER,
    retrieval_log_id INTEGER, reward_signal REAL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
nativeDb.exec(`
  CREATE TABLE IF NOT EXISTS brain_modulators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    modulator_type TEXT NOT NULL, valence REAL NOT NULL, magnitude REAL NOT NULL DEFAULT 1.0,
    source_event_id TEXT, session_id TEXT, description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
nativeDb.exec(`
  CREATE TABLE IF NOT EXISTS brain_consolidation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL, session_id TEXT, step_results_json TEXT NOT NULL,
    duration_ms INTEGER, succeeded INTEGER NOT NULL DEFAULT 1,
    started_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
```

---

## §6 Cross-Table Linkage Map

The following diagram shows the cross-links between all new and existing tables to confirm no orphan tables are created.

```
brain_retrieval_log
  id ←── brain_plasticity_events.retrieval_log_id (soft FK)
  id ←── brain_weight_history.retrieval_log_id (soft FK)
  session_id ──→ [tasks.db sessions] (soft FK cross-DB)

brain_plasticity_events
  id ←── brain_weight_history.source_plasticity_event_id (soft FK)
  source_node / target_node → brain_page_nodes.id (soft FK)
  retrieval_log_id → brain_retrieval_log.id (soft FK, denorm)

brain_page_edges
  from_id / to_id → brain_page_nodes.id (soft FK)
  (Hebbian/STDP write both plasticity_events and weight_history per edge)

brain_weight_history
  edge_from_id / edge_to_id / edge_type → brain_page_edges (3-col composite, soft FK)
  source_plasticity_event_id → brain_plasticity_events.id (soft FK)
  retrieval_log_id → brain_retrieval_log.id (soft FK)

brain_modulators
  session_id → [tasks.db sessions] (soft FK cross-DB)
  source_event_id → [task ID or memory entry ID] (polymorphic soft FK)
  (linked conceptually to brain_retrieval_log.reward_signal via session_id JOIN)

brain_consolidation_events
  session_id → [tasks.db sessions] (soft FK cross-DB)
  step_results_json → typed by ConsolidationResult interface (no DB FK)
```

All tables cross-link without circular dependencies. No orphan tables.

---

## §7 New Child Tasks (Under T673)

The following tasks must be created. They cover schema work beyond the existing STDP-W1 through STDP-W6 tasks.

### Task A: T673-S1 — Migrate brain_plasticity_events observability columns

Description: Add `weight_before`, `weight_after`, `retrieval_log_id`, `reward_signal`, `delta_t_ms` to `brain_plasticity_events` via migration file T673-M2. Update `brain-schema.ts` Drizzle declaration. Update `brain-stdp.ts:277-279` INSERT statement to populate the new columns. Add `ensureColumns` safety net for existing installs.

Size: small  
Priority: critical (blocks observability of plasticity behavior)

Acceptance:
- Migration file `20260416000002_t673-plasticity-events-expand/migration.sql` committed
- `brain-schema.ts` Drizzle declaration updated with 5 new columns + 2 new indexes
- `brain-stdp.ts` `prepareLogEvent` includes weight_before, weight_after, retrieval_log_id, reward_signal, delta_t_ms
- `ensureColumns` added to `runBrainMigrations` for all 5 new columns
- `pnpm biome check --write . && pnpm run build` passes with zero errors

### Task B: T673-S2 — Create brain_weight_history table + retention sweep

Description: Create the `brain_weight_history` table via migration T673-M4 (combined with modulators/consolidation tables). Add Drizzle schema declaration. Implement the `writeWeightHistory` function in `brain-stdp.ts` that writes one row per LTP/LTD event. Implement the 90-day retention sweep in `runConsolidation` Step 9c. Wire both `applyStdpPlasticity` and `strengthenCoRetrievedEdges` to call `writeWeightHistory`.

Size: medium  
Priority: critical (owner elevated Phase 7 into Phase 5 scope)

Acceptance:
- Migration T673-M4 creates all three new tables
- `brain-schema.ts` declares `brainWeightHistory` with 12 columns + 6 indexes
- `writeWeightHistory(nativeDb, row: NewBrainWeightHistoryRow)` exported from `brain-stdp.ts`
- Both STDP and Hebbian paths call `writeWeightHistory` for every weight change
- `runConsolidation` Step 9c DELETEs rows older than 90 days from `brain_weight_history`
- `PRAGMA table_info(brain_weight_history)` on live brain.db confirms all 12 columns
- `pnpm biome check --write . && pnpm run build && pnpm run test` passes

### Task C: T673-S3 — Create brain_modulators table + wire into backfillRewardSignals

Description: Create the `brain_modulators` table via migration T673-M4. Add Drizzle schema declaration. Update `backfillRewardSignals` (STDP-W4 scope, T681) to INSERT rows into `brain_modulators` as it correlates task outcomes to sessions. This provides a permanent event log of every reward signal emitted, enabling Studio viz to show "why did this edge strengthen?".

Size: small  
Priority: high (P1 — needed for full R-STDP observability; algorithm still works without it)

Acceptance:
- `brain-schema.ts` declares `brainModulators` with 8 columns + 5 indexes
- `backfillRewardSignals` inserts a `brain_modulators` row for each task outcome it processes
- `brain_modulators` has rows after running `cleo session end` on a project with completed tasks
- `pnpm biome check --write . && pnpm run build && pnpm run test` passes

### Task D: T673-S4 — Create brain_consolidation_events table + wire runConsolidation

Description: Create the `brain_consolidation_events` table. Add Drizzle schema declaration. Update `runConsolidation` in `brain-lifecycle.ts` to INSERT one row per run with the trigger source, session ID, step results JSON, duration, and success flag.

Size: small  
Priority: high (P1 — needed for T628 auto-dream cycle scheduling)

Acceptance:
- `brain-schema.ts` declares `brainConsolidationEvents` with 7 columns + 3 indexes
- `runConsolidation` signature accepts optional `trigger: 'session_end' | 'maintenance' | 'scheduled' | 'manual'`
- Every `runConsolidation` call inserts a row — confirmed by `SELECT COUNT(*) FROM brain_consolidation_events` after `cleo brain maintenance`
- `pnpm biome check --write . && pnpm run build && pnpm run test` passes

### Task E: T673-S5 — Migration file T673-M1 (retrieval_log columns)

Description: Write and commit migration file T673-M1 (`20260416000001_t673-retrieval-log-plasticity-columns/migration.sql`). Update `brain-schema.ts` to add `retrievalOrder`, `deltaMs`, and `rewardSignal` columns to `brainRetrievalLog` Drizzle declaration (bring Drizzle in sync with live table for `retrieval_order`/`delta_ms`, and add the new `reward_signal`). Note: `session_id` is already declared in the Drizzle schema at line 715; the migration only needs to apply it to the live table.

Size: small  
Priority: critical (prerequisite for STDP-W1 T678)

Acceptance:
- Migration file committed and parseable by drizzle-kit
- `brain-schema.ts` Drizzle `brainRetrievalLog` has all columns matching live table state post-migration
- `ensureColumns` updated for session_id, reward_signal, retrieval_order, delta_ms
- `PRAGMA table_info(brain_retrieval_log)` after migration shows all 10 columns
- `pnpm biome check --write . && pnpm run build` passes

### Task F: T673-S6 — Migration file T673-M3 (page_edges plasticity columns)

Description: Write and commit migration file T673-M3 (`20260416000003_t673-page-edges-plasticity-columns/migration.sql`). Update `brain-schema.ts` to add `lastReinforcedAt`, `reinforcementCount`, `plasticityClass`, `lastDepressedAt`, `depressionCount`, `stabilityScore` columns to `brainPageEdges` Drizzle declaration. Add `ensureColumns` for all 6 new columns.

Size: small  
Priority: critical (prerequisite for STDP decay pass and plasticity_class routing)

Acceptance:
- Migration file committed with correct idempotent `UPDATE brain_page_edges SET plasticity_class = 'hebbian' WHERE edge_type = 'co_retrieved'` seed
- `brain-schema.ts` Drizzle declaration updated
- `ensureColumns` safety net added
- `PRAGMA table_info(brain_page_edges)` after migration shows all 12 columns
- `pnpm biome check --write . && pnpm run build` passes

### Task G: T673-S7 — Phase 6 future: Option C junction table for brain_retrieval_entries

Description: (Phase 6 future — do not implement in Phase 5) Create a normalized `brain_retrieval_entries(retrieval_id, entry_id, rank)` junction table as the long-term replacement for `brain_retrieval_log.entry_ids` JSON string. Plan: once the table has >10K rows, the SQL JOIN approach (see §2.1 Option C query) is measurably faster than application-layer JSON parsing. This task should be spawned when the retrieval log growth rate crosses that threshold.

Size: medium  
Priority: low (P3 — not blocking Phase 5)

---

## §8 Open Questions for Other Councilors

### For Algorithm Lead B

1. **`brain_weight_history` write scope**: Should `writeWeightHistory` be called for EVERY plasticity event (including events < 1e-6 delta that are currently skipped at `brain-stdp.ts:298`)? Or only for events that actually update the DB? Recommendation: only write for events that change the DB (skip negligible deltas). But Algorithm Lead B should confirm.

2. **`plasticity_class` upgrade logic**: When should an edge upgrade from `'hebbian'` to `'stdp'`? Options: (a) immediately on first STDP pass, (b) only when STDP reinforcement_count > N, (c) never upgrade (keep separate tracking). The schema supports all three — the algorithm decides. Algorithm Lead B must specify the promotion rule so the `applyStdpPlasticity` writer knows when to set `plasticity_class = 'stdp'`.

3. **`stability_score` computation formula**: This report proposes `tanh(reinforcement_count / 10) × exp(-(days_since_reinforced / 30))`. Algorithm Lead B should validate or propose a different consolidation curve. The schema field is neutral; the formula goes in the implementation.

4. **`delta_t_ms` in `brain_plasticity_events`**: The proposed column stores the wall-clock Δt between the spike pair. Should this be the Δt between individual entry IDs within a batch (currently unresolvable — all entries in a batch have the same `created_at`) or the Δt between retrieval rows? The latter is what the current algorithm actually computes. Algorithm Lead B should clarify.

5. **Decay pass writes to `brain_weight_history`**: Every decayed edge would generate a row. At 200K plastic edges × daily decay = 200K rows/day → 18M rows/90 days. This is within SQLite scale ceiling but large. Should decay events be written to `brain_weight_history` at all? Alternative: decay events only write to `brain_page_edges` (no audit trail). Recommendation: only write `brain_weight_history` for prune events (weight → 0) and manual/external events; skip routine decay writes. Algorithm Lead B must decide.

### For Integration Lead C

6. **`brain_consolidation_events.step_results_json` schema**: The `ConsolidationResult` type in `brain-lifecycle.ts` is the authoritative source. Integration Lead C needs to ensure this type is exported from `brain-lifecycle.ts` and the INSERT statement serializes it faithfully. If `ConsolidationResult` evolves, the JSON column absorbs the change without a migration.

7. **`backfillRewardSignals` ↔ `brain_modulators` transaction boundary**: `backfillRewardSignals` (STDP-W4, T681) currently writes only to `brain_retrieval_log`. With `brain_modulators` in scope, it must now also INSERT modulator rows in the same call. Integration Lead C must confirm whether `backfillRewardSignals` should write both tables in a single SQLite transaction or whether `brain_modulators` gets its own separate write pass.

8. **Cross-DB JOIN `brain_retrieval_log.session_id` → tasks.db sessions**: `backfillRewardSignals` must query tasks.db for completed tasks matching the session, then update brain.db. This is a cross-DB operation — two separate SQLite connections. Integration Lead C must confirm the transaction pattern: (a) read from tasks.db → compute → write to brain.db in two separate transactions, or (b) ATTACH tasks.db to brain.db connection. The current codebase uses approach (a) per `cross-db-cleanup.ts`. Use the same pattern.

---

## §9 Evidence Matrix (Complete File:Line Citations)

| Claim | Evidence |
|-------|----------|
| `brain_plasticity_events` 7-col schema | `packages/core/src/store/brain-schema.ts:740-770` |
| `brain_plasticity_events` 0 rows (confirmed) | T673-stdp-rcasd-plan.md §R1 |
| INSERT omits session_id | `packages/core/src/memory/brain-stdp.ts:277-279` |
| `brain_retrieval_log` Drizzle schema (9 cols) | `packages/core/src/store/brain-schema.ts:694-724` |
| `brain_retrieval_log` live table has retrieval_order + delta_ms | T673-stdp-rcasd-plan.md §R1, `brain-stdp.ts:133-140` RetrievalLogRow interface |
| `brain_retrieval_log` missing session_id in live table | T673-stdp-rcasd-plan.md §R1 PRAGMA table_info |
| session_id declared in Drizzle but not in live table | `brain-schema.ts:715` vs PRAGMA table_info (RCASD plan) |
| `logRetrieval` stores comma-sep | `packages/core/src/memory/brain-retrieval.ts:1517` `entryIds.join(',')` |
| `strengthenCoRetrievedEdges` uses JSON.parse | `packages/core/src/memory/brain-lifecycle.ts:971` |
| `applyStdpPlasticity` uses JSON.parse | `packages/core/src/memory/brain-stdp.ts:235` |
| `brain_page_edges` 6-col post-T528 schema | `packages/core/migrations/drizzle-brain/20260411000001_t528-graph-schema-expansion/migration.sql` |
| plasticity columns on `brain_page_edges` per plan | `docs/plans/stdp-feasibility.md:§3.2` |
| `brain_weight_history` proposed as Phase 7 | `docs/plans/stdp-feasibility.md:§3.4` |
| owner elevates brain_weight_history to in-scope | This session owner directive "do NOT delay or put off" |
| R-STDP reward_signal decision | D-BRAIN-VIZ-13 (docs/plans/brain-synaptic-visualization-research.md:27) |
| `runBrainMigrations` ensureColumns pattern | `packages/core/src/store/brain-sqlite.ts:103-180` |
| migration naming convention | `packages/core/migrations/drizzle-brain/` directory listing |
| latest migration = 20260415000001 | `packages/core/migrations/drizzle-brain/20260415000001_t626-normalize-co-retrieved-edge-type/` |
| `runConsolidation` Step 9 STDP hook | `packages/core/src/memory/brain-lifecycle.ts:706-715` |
| `strengthenCoRetrievedEdges` Step 6 location | `packages/core/src/memory/brain-lifecycle.ts:930` |
| `backfillRewardSignals` concept per spec | `docs/specs/stdp-wire-up-spec.md:§5` |
| no dream/T628 table exists | grep confirms 0 results for brain_consolidation_events in codebase |
| Option C junction table query superiority | analysis in §2.1, benchmark rationale from stdp-feasibility.md §5 |

---

## §10 Summary Scorecard

| Table | Action | Columns Added | New Indexes | Migration File |
|-------|--------|---------------|-------------|----------------|
| `brain_retrieval_log` | ALTER + DATA FIX | 4 (session_id, reward_signal, retrieval_order, delta_ms) | 1 (reward) | T673-M1 |
| `brain_plasticity_events` | ALTER | 5 (weight_before, weight_after, retrieval_log_id, reward_signal, delta_t_ms) | 2 | T673-M2 |
| `brain_page_edges` | ALTER + SEED | 6 (last_reinforced_at, reinforcement_count, plasticity_class, last_depressed_at, depression_count, stability_score) | 3 | T673-M3 |
| `brain_weight_history` | CREATE | 12 | 6 | T673-M4 |
| `brain_modulators` | CREATE | 8 | 5 | T673-M4 |
| `brain_consolidation_events` | CREATE | 7 | 3 | T673-M4 |
| **TOTAL** | | **42 columns** | **20 indexes** | **4 migration files** |

**Child tasks created in this report**: T673-S1 through T673-S7 (7 new tasks, to be created via `cleo add`).

**Q1 answer**: Option B (JSON array) for Phase 5. Option C (junction table) for Phase 6+. Rationale in §2.

**Q4 design**: Complete in §4.4, including retention policy recommendation (90 days rolling).

**Owner consensus item**: `brain_weight_history` retention policy. This report recommends 90 days. All-time is viable but requires explicit `VACUUM` management. Decay events should NOT be written to weight_history (only prune + ltp + ltd + manual).
