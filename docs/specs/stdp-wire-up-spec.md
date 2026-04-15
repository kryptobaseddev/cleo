# STDP Phase 5 Wire-Up — Master Specification

> **Spec ID**: STDP-WIRE-UP-V2
> **Status**: AUTHORITATIVE — supersedes STDP-WIRE-UP-V1
> **Date**: 2026-04-15
> **Author**: T673 Plasticity Council Synthesis Lead (session ses_20260415172452_9cf242)
> **Parent task**: T673
> **Epic**: T627 (T-BRAIN-LIVING Stabilization)
> **Synthesized from**:
> - Lead A Schema Council (`T673-council-schema.md`)
> - Lead B Algorithm Council (`T673-council-algorithm.md`)
> - Lead C Integration Council (`T673-council-integration.md`)
> - RCASD Plan (`T673-stdp-rcasd-plan.md`)
> **Locked decisions**: D-BRAIN-VIZ-04, D-BRAIN-VIZ-05, D-BRAIN-VIZ-08, D-BRAIN-VIZ-09,
>   D-BRAIN-VIZ-12, D-BRAIN-VIZ-13, D013 (owner Q1–Q5 answers 2026-04-15)

---

## §1 Purpose, Scope, and Broken State

### §1.1 Purpose

This specification is the single authoritative source of truth for completely wiring CLEO BRAIN's
STDP-inspired plasticity substrate. It replaces all prior partial specifications and council
reports. Workers MUST implement this specification straight-through without consulting the
superseded council reports for decisions.

### §1.2 Scope

This specification governs:

1. Schema migrations that make the writer functional and complete
2. Algorithm correctness — cross-session spike pairs, tiered τ decay, LTP/LTD math
3. R-STDP reward modulation via `backfillRewardSignals`
4. Homeostatic decay + synaptic pruning
5. Novelty-boosted LTP for first-ever spike pairs
6. Integration hooks — writer location, observer ordering, session_id passthrough
7. Session_id backfill for the 38 historical `brain_retrieval_log` rows
8. CLI surface additions
9. Studio UI integration requirements (planning-level for Phase 6)
10. Functional test architecture (real brain.db, no mocks)
11. Migration sequence with rollback
12. Observability and health metrics
13. Acceptance criteria for the full STDP epic

### §1.3 Explicit Non-Goals

This specification does NOT govern:

- Phase 6+ Studio visualization details beyond those noted in §4.5
- Biological SNN frameworks (BindsNET, Brian2) — excluded per D-BRAIN-VIZ-09
- Cross-project meta-brain plasticity (future phase)
- `brain_retrieval_entries` junction table (Option C) — Phase 6+ only, tracked in T709
- Auto-dream cycle scheduler implementation (T628) — noted as integration point only

### §1.4 Root Causes of Broken State (Phase 5 Shipped Half-Built)

Three confirmed root-cause bugs prevent any plasticity events from firing:

**BUG-1 — Lookback/Pairing Window Conflation**

`applyStdpPlasticity` (line 171 of `brain-stdp.ts`) defaults `sessionWindowMs = 5 * 60 * 1000`.
This single value is used as BOTH (a) the SQL lookback cutoff for fetching rows AND (b) the
spike-pair Δt comparison gate. The 38 live `brain_retrieval_log` rows span 2026-04-13 to
2026-04-15 — all older than 5 minutes. Zero rows qualify. Zero events fire.

The plan at `docs/plans/stdp-feasibility.md §4` specifies a 30-day lookback. The implementation
contradicts the plan.

**BUG-2 — `entry_ids` Format Mismatch**

`logRetrieval` at `brain-retrieval.ts:1517` stores `entryIds.join(',')` (comma-separated).
`strengthenCoRetrievedEdges` at `brain-lifecycle.ts:971` calls `JSON.parse(row.entry_ids)`.
`applyStdpPlasticity` at `brain-stdp.ts:235` also calls `JSON.parse(row.entry_ids)`.
Both readers fail silently on comma-separated input. Result: 0 Hebbian edges, 0 STDP events.

**BUG-3 — Missing `session_id` in Live Table**

`brain_retrieval_log.session_id` is declared in the Drizzle schema (`brain-schema.ts:715`) and
in the self-healing DDL, but the ALTER TABLE was never applied to the live table. The live table
(confirmed via `PRAGMA table_info`) has no `session_id` column. The `applyStdpPlasticity` INSERT
at `brain-stdp.ts:277` omits `session_id` even in the Drizzle declaration.

**Consequence of all three bugs**: `applyStdpPlasticity` fetches 0 rows (BUG-1), parses nothing
(BUG-2), and writes events with no session attribution (BUG-3). `brain_plasticity_events` remains
permanently empty.

---

## §2 Schema

### §2.1 Target Schema — Complete Column Inventory

All additions use the patterns established in `packages/core/src/store/brain-schema.ts`.
The `ensureColumns` safety net in `packages/core/src/store/brain-sqlite.ts:runBrainMigrations`
MUST be extended for every column addition per §5.3.

#### §2.1.1 `brain_retrieval_log` — Target (post-migration)

**File**: `packages/core/src/store/brain-schema.ts:694–724` plus additions.

| Column | Type | Constraint | Notes |
|--------|------|------------|-------|
| `id` | INTEGER | PK AUTOINCREMENT | Existing |
| `query` | TEXT | NOT NULL | Existing |
| `entry_ids` | TEXT | NOT NULL | Existing — MUST be JSON array post-M1 |
| `entry_count` | INTEGER | NOT NULL | Existing |
| `source` | TEXT | NOT NULL | Existing |
| `tokens_used` | INTEGER | nullable | Existing |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | Existing |
| `retrieval_order` | INTEGER | nullable | In live table via self-healing DDL; NOT in Drizzle — M1 adds to Drizzle |
| `delta_ms` | INTEGER | nullable | In live table via self-healing DDL; NOT in Drizzle — M1 adds to Drizzle |
| `session_id` | TEXT | nullable | Declared in Drizzle at :715, MISSING from live table — M1 adds via ALTER |
| `reward_signal` | REAL | nullable | NOT in Drizzle, NOT in live table — M1 adds both |

**Drizzle additions** (add to `brainRetrievalLog` column block):

```typescript
/** Sequence position of this retrieval within a batch query. */
retrievalOrder: integer('retrieval_order'),

/** Wall-clock ms since the previous retrieval in the same batch. */
deltaMs: integer('delta_ms'),

// sessionId already declared at :715 — no duplicate

/**
 * R-STDP reward signal: scalar [-1.0, +1.0], null = unlabeled.
 * Populated by backfillRewardSignals() at session end (Step 9a).
 * +1.0 = task verified and passed | +0.5 = done (unverified) | -0.5 = cancelled
 * Per D-BRAIN-VIZ-13.
 */
rewardSignal: real('reward_signal'),
```

**New indexes** (add to `brainRetrievalLog` index block):

```typescript
index('idx_retrieval_log_reward').on(table.rewardSignal),
```

#### §2.1.2 `brain_plasticity_events` — Target (post-migration)

**File**: `packages/core/src/store/brain-schema.ts:740–770` plus additions.

| Column | Type | Constraint | Notes |
|--------|------|------------|-------|
| `id` | INTEGER | PK AUTOINCREMENT | Existing |
| `source_node` | TEXT | NOT NULL | Existing |
| `target_node` | TEXT | NOT NULL | Existing |
| `delta_w` | REAL | NOT NULL | Existing |
| `kind` | TEXT | NOT NULL CHECK('ltp','ltd') | Existing |
| `timestamp` | TEXT | NOT NULL DEFAULT datetime('now') | Existing |
| `session_id` | TEXT | nullable | Existing in Drizzle; INSERT must now include it |
| `weight_before` | REAL | nullable | NEW — M2 |
| `weight_after` | REAL | nullable | NEW — M2 |
| `retrieval_log_id` | INTEGER | nullable (soft FK) | NEW — M2 |
| `reward_signal` | REAL | nullable | NEW — M2 |
| `delta_t_ms` | INTEGER | nullable | NEW — M2 |

**Drizzle additions** (add to `brainPlasticityEvents` column block):

```typescript
/** Edge weight immediately before this event. Null on first-ever INSERT for an edge. */
weightBefore: real('weight_before'),

/** Edge weight immediately after this event. Equals CLAMP(weightBefore + delta_w, 0, 1). */
weightAfter: real('weight_after'),

/** Soft FK to brain_retrieval_log.id — the retrieval that caused this event. */
retrievalLogId: integer('retrieval_log_id'),

/** R-STDP reward signal at time of event. Copied from retrieval_log.reward_signal. */
rewardSignal: real('reward_signal'),

/** Δt in ms between the two spikes that generated this event. Pre-computed at INSERT. */
deltaTMs: integer('delta_t_ms'),
```

**New indexes**:

```typescript
index('idx_plasticity_retrieval_log').on(table.retrievalLogId),
index('idx_plasticity_reward').on(table.rewardSignal),
```

#### §2.1.3 `brain_page_edges` — Target (post-migration)

**File**: `packages/core/src/store/brain-schema.ts:648–678` plus additions.

| Column | Type | Constraint | Notes |
|--------|------|------------|-------|
| `from_id` | TEXT | NOT NULL | Existing |
| `to_id` | TEXT | NOT NULL | Existing |
| `edge_type` | TEXT | NOT NULL | Existing |
| `weight` | REAL | NOT NULL DEFAULT 1 | Existing |
| `provenance` | TEXT | nullable | Existing |
| `created_at` | TEXT | NOT NULL DEFAULT datetime('now') | Existing |
| `last_reinforced_at` | TEXT | nullable | NEW — M3 |
| `reinforcement_count` | INTEGER | NOT NULL DEFAULT 0 | NEW — M3 |
| `plasticity_class` | TEXT | NOT NULL DEFAULT 'static' | NEW — M3 |
| `last_depressed_at` | TEXT | nullable | NEW — M3 |
| `depression_count` | INTEGER | NOT NULL DEFAULT 0 | NEW — M3 |
| `stability_score` | REAL | nullable | NEW — M3 |

**Drizzle additions**:

```typescript
/** ISO 8601 timestamp of last LTP event on this edge. Null = never reinforced. */
lastReinforcedAt: text('last_reinforced_at'),

/** Count of LTP events applied lifetime. Incremented on every LTP write. */
reinforcementCount: integer('reinforcement_count').notNull().default(0),

/**
 * Plasticity class governing which algorithm(s) write to this edge.
 * 'static': structural — immune to decay. 'hebbian': co-occurrence.
 * 'stdp': timing-dependent plasticity. Edges start 'static'; STDP upgrades to 'stdp'.
 */
plasticityClass: text('plasticity_class', {
  enum: ['static', 'hebbian', 'stdp'] as const,
}).notNull().default('static'),

/** ISO 8601 timestamp of last LTD (depression) event. Null = never depressed. */
lastDepressedAt: text('last_depressed_at'),

/** Count of LTD events applied lifetime. */
depressionCount: integer('depression_count').notNull().default(0),

/**
 * Stability score 0.0–1.0. Computed at session-end as:
 *   tanh(reinforcement_count / 10) × exp(-(days_since_reinforced / 30))
 * Null = not yet computed. Enables fast decay-pass filtering (skip stability > 0.9).
 */
stabilityScore: real('stability_score'),
```

**New indexes**:

```typescript
index('idx_brain_edges_last_reinforced').on(table.lastReinforcedAt),
index('idx_brain_edges_plasticity_class').on(table.plasticityClass),
index('idx_brain_edges_stability').on(table.stabilityScore),
```

**M3 data seed**: On migration, existing `co_retrieved` edges MUST be updated:
```sql
UPDATE brain_page_edges SET plasticity_class = 'hebbian' WHERE edge_type = 'co_retrieved';
```

#### §2.1.4 `brain_weight_history` — NEW TABLE (M4)

Immutable audit log of every edge weight change. Retention: rolling 90 days via DELETE sweep in
`runConsolidation` Step 9d. Decay events are NOT written here (only ltp/ltd/hebbian/prune/external
events). Routine daily decay writes only to `brain_page_edges`.

```typescript
export const brainWeightHistory = sqliteTable('brain_weight_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  edgeFromId: text('edge_from_id').notNull(),
  edgeToId: text('edge_to_id').notNull(),
  edgeType: text('edge_type').notNull(),
  weightBefore: real('weight_before'),
  weightAfter: real('weight_after').notNull(),
  deltaWeight: real('delta_weight').notNull(),
  /** 'ltp' | 'ltd' | 'hebbian' | 'decay' | 'prune' | 'external' */
  eventKind: text('event_kind').notNull(),
  sourcePlasticityEventId: integer('source_plasticity_event_id'),
  retrievalLogId: integer('retrieval_log_id'),
  rewardSignal: real('reward_signal'),
  changedAt: text('changed_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_weight_history_edge').on(table.edgeFromId, table.edgeToId, table.edgeType),
  index('idx_weight_history_from').on(table.edgeFromId),
  index('idx_weight_history_to').on(table.edgeToId),
  index('idx_weight_history_changed_at').on(table.changedAt),
  index('idx_weight_history_event_kind').on(table.eventKind),
  index('idx_weight_history_plasticity_event').on(table.sourcePlasticityEventId),
]);
```

**Write scope decision** (resolved from Lead A open question Q-A1):
`writeWeightHistory` MUST be called for every LTP and LTD event that actually changes the DB
(skip events below the `1e-6` negligibility threshold). Hebbian events MUST also write history.
Routine exponential decay events MUST NOT write history rows (too voluminous). Prune events
(weight → 0 and DELETE) MUST write a final history row with `eventKind = 'prune'`.

#### §2.1.5 `brain_modulators` — NEW TABLE (M4)

Discrete neuromodulator event log for R-STDP third-factor gating.

```typescript
export const brainModulators = sqliteTable('brain_modulators', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 'task_verified'|'task_completed'|'task_cancelled'|'owner_verify'|'session_success'|'session_blocker'|'external' */
  modulatorType: text('modulator_type').notNull(),
  /** Reward valence [-1.0, +1.0] */
  valence: real('valence').notNull(),
  /** Magnitude 0.0–1.0 confidence scaling. Effective reward = valence × magnitude. */
  magnitude: real('magnitude').notNull().default(1.0),
  sourceEventId: text('source_event_id'),
  sessionId: text('session_id'),
  description: text('description'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_modulators_type').on(table.modulatorType),
  index('idx_modulators_session').on(table.sessionId),
  index('idx_modulators_created_at').on(table.createdAt),
  index('idx_modulators_source_event').on(table.sourceEventId),
  index('idx_modulators_valence').on(table.valence),
]);
```

`backfillRewardSignals` MUST insert a `brain_modulators` row for each task outcome it processes.
Both writes (retrieval_log UPDATE and modulators INSERT) MUST occur in the same conceptual pass,
using two separate transactions (approach (a): read tasks.db → compute → write brain.db
separately), matching the pattern in `cross-db-cleanup.ts`. Do NOT use ATTACH.

#### §2.1.6 `brain_consolidation_events` — NEW TABLE (M4)

One row per `runConsolidation` execution. Enables T628 scheduling and pipeline observability.

```typescript
export const brainConsolidationEvents = sqliteTable('brain_consolidation_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 'session_end' | 'maintenance' | 'scheduled' | 'manual' */
  trigger: text('trigger').notNull(),
  sessionId: text('session_id'),
  /** JSON-serialized ConsolidationResult — all step counts and metrics */
  stepResultsJson: text('step_results_json').notNull(),
  durationMs: integer('duration_ms'),
  succeeded: integer('succeeded', { mode: 'boolean' }).notNull().default(true),
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_consolidation_events_started_at').on(table.startedAt),
  index('idx_consolidation_events_trigger').on(table.trigger),
  index('idx_consolidation_events_session').on(table.sessionId),
]);
```

`runConsolidation` in `brain-lifecycle.ts` MUST accept an optional `trigger` parameter
(`'session_end' | 'maintenance' | 'scheduled' | 'manual'`) and MUST insert one row per run.
`ConsolidationResult` MUST be exported from `brain-lifecycle.ts` so the INSERT can serialize it.

### §2.2 `entry_ids` Format — Final Ruling (Q1 Resolved)

**Phase 5 (now)**: Option B — JSON array string (`'["obs:A","obs:B"]'`).

The `logRetrieval` function at `brain-retrieval.ts:1517` MUST store `JSON.stringify(entryIds)`
instead of `entryIds.join(',')`. Both readers (`strengthenCoRetrievedEdges:971` and
`applyStdpPlasticity:235`) already call `JSON.parse()` — this fixes BUG-2 with a one-line
writer change.

**Phase 6+ (T709)**: Option C — normalized junction table `brain_retrieval_entries(retrieval_id,
entry_id, rank)`. Scheduled when `brain_retrieval_log` exceeds ~10K rows. Not in scope for T673.

### §2.3 `entry_ids` Migration for Existing 38 Rows

The 38 historical rows MUST be migrated (NOT truncated — they contain diagnostic value).
Migration MUST be idempotent (rows already in JSON format are untouched):

```sql
UPDATE brain_retrieval_log
SET entry_ids = '["' || REPLACE(entry_ids, ',', '","') || '"]'
WHERE entry_ids IS NOT NULL
  AND entry_ids != ''
  AND entry_ids NOT LIKE '[%';
```

### §2.4 `session_id` Backfill for Existing 38 Rows

The 38 historical rows have `session_id = NULL`. These MUST receive synthetic session IDs
via date-bucketing (one `ses_backfill_YYYY-MM-DD` per calendar day in `created_at`).
Rationale: three real distinct working days exist in the data; date-bucketing provides
cross-session pairs without application-layer clustering complexity.

```sql
UPDATE brain_retrieval_log
SET session_id = 'ses_backfill_' || substr(created_at, 1, 10)
WHERE session_id IS NULL;
```

This MUST run as part of M1. It is idempotent.

**Reward backfill constraint**: `backfillRewardSignals` MUST NOT attempt reward correlation
for sessions with `session_id` starting with `'ses_backfill_'` — no real task correlation
exists for synthetic sessions.

### §2.5 Cross-Table Linkage Map (Integrity Reference)

```
brain_retrieval_log
  id ←── brain_plasticity_events.retrieval_log_id (soft FK)
  id ←── brain_weight_history.retrieval_log_id (soft FK)
  session_id ──→ [tasks.db sessions] (soft FK cross-DB)

brain_plasticity_events
  id ←── brain_weight_history.source_plasticity_event_id (soft FK)
  source_node / target_node → brain_page_nodes.id (soft FK)
  retrieval_log_id → brain_retrieval_log.id (soft FK, denorm)

brain_page_edges (plasticity fields)
  from_id / to_id → brain_page_nodes.id (soft FK)
  (LTP writes plasticity_events + weight_history per event)

brain_weight_history
  edge_from_id / edge_to_id / edge_type → brain_page_edges (3-col composite, soft FK)
  source_plasticity_event_id → brain_plasticity_events.id (soft FK)
  retrieval_log_id → brain_retrieval_log.id (soft FK)

brain_modulators
  session_id → [tasks.db sessions] (soft FK cross-DB)
  source_event_id → [task ID or memory entry ID] (polymorphic soft FK)

brain_consolidation_events
  session_id → [tasks.db sessions] (soft FK cross-DB)
```

All tables cross-link without circular dependencies.

---

## §3 Algorithm

### §3.1 Spike Definition

A **spike** is a discrete memory access event — one entry ID within one `brain_retrieval_log` row:

```
spike := {
  entryId:     string,     // brain entry identifier e.g. "observation:abc"
  retrievedAt: epoch_ms,   // wall-clock timestamp of the retrieval batch row
  sessionId:   string|null,
  rowId:       integer,    // FK back to brain_retrieval_log.id
  order:       integer,    // retrieval_order within batch (0-based)
  reward:      float|null  // reward_signal from brain_retrieval_log (−1..+1)
}
```

Each `brain_retrieval_log` row expands to N spikes (one per entry_id in the JSON array).
Cross-session pairing: ALL spike pairs within `pairingWindowMs` (default 24 h) are eligible
regardless of session boundary. Session boundary is NOT a hard cutoff for pair formation.

**Events that are NOT spikes** (excluded from pair computation):
- Memory saves / `brain_observation` INSERTs — encoding, not retrieval
- Observer summary INSERTs — downstream product
- Task-completion events alone — modulator only, no entryId

### §3.2 Two-Window Architecture (BUG-1 Fix)

The algorithm MUST use two independent parameters:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `lookbackDays` | 30 | SQL cutoff for fetching `brain_retrieval_log` rows |
| `pairingWindowMs` | 86,400,000 ms (24 h) | Maximum Δt between two spikes for pair formation |

The `sessionWindowMs` parameter name is DEPRECATED. Any call site passing `sessionWindowMs`
MUST emit a deprecation warning and map the value to `pairingWindowMs`. The parameter is NOT
silently ignored.

### §3.3 Tiered Time Constant τ(Δt)

The decay function `f(Δt) = exp(−Δt / τ)` uses a context-sensitive τ:

| Gap class | Δt range | τ | Biological analogy |
|-----------|----------|---|-------------------|
| Intra-batch | 0 — 30 s | τ_near = 20,000 ms | Classical STDP window |
| Intra-session | 30 s — 2 h | τ_session = 1,800,000 ms | Working memory consolidation |
| Cross-session | 2 h — 24 h | τ_episodic = 43,200,000 ms | Episodic reconsolidation (~12 h) |

```typescript
function computeTau(deltaT: number, opts: PlasticityOptions): number {
  if (deltaT <= 30_000)     return opts.tauNearMs;      // 20 s
  if (deltaT <= 7_200_000)  return opts.tauSessionMs;   // 2 h
  return opts.tauEpisodicMs;                             // 12 h
}
```

**Rationale for τ_episodic = 12 h**: Pairs 12 hours apart contribute `A × exp(−1) ≈ 0.37 × A`
weight change — meaningful but smaller than same-session pairs. Pairs 36 hours apart contribute
`A × exp(−3) ≈ 0.05 × A` — near the `1e-6` skip threshold. Aligns with biological episodic
consolidation windows (Walker & Stickgold 2004).

### §3.4 LTP Formula

```
Δw_ltp(Δt) = A_pre × exp(−Δt / τ(Δt))
```

- `A_pre = 0.05` (default)
- Skip if `Δw_ltp < 1e-6`
- **Effect on edge A→B** (`co_retrieved`):
  - If edge exists: `weight = CLAMP(weight + Δw_ltp, 0, 1)`; `reinforcement_count += 1`;
    `last_reinforced_at = now`; `plasticity_class = 'stdp'`
  - If edge does NOT exist: INSERT with `weight = CLAMP(Δw_ltp × k_novelty, 0, 1)`;
    `reinforcement_count = 1`; `plasticity_class = 'stdp'`

### §3.5 LTD Formula

```
Δw_ltd(Δt) = −(A_post × exp(−Δt / τ(Δt)))
```

- `A_post = 0.06` (asymmetric: `A_post > A_pre` per Bi & Poo 1998)
- **Effect on edge B→A**: if edge exists, `weight = CLAMP(weight + Δw_ltd, 0, 1)`;
  `depression_count += 1`; `last_depressed_at = now`; `plasticity_class = 'stdp'`
- LTD MUST NOT insert new edges.

SQL for UPDATE:
```sql
UPDATE brain_page_edges
SET weight = MAX(0.0, MIN(1.0, weight + ?)),
    depression_count = depression_count + 1,
    last_depressed_at = ?,
    plasticity_class = 'stdp'
WHERE from_id = ? AND to_id = ? AND edge_type = 'co_retrieved';
```

### §3.6 R-STDP Reward Modulation

When `reward_signal r` is non-null on the pre-spike's retrieval row:

```
Δw_ltp_effective = CLAMP(Δw_ltp × (1 + r), 0, 2 × A_pre)   = CLAMP(..., 0, 0.10)
Δw_ltd_effective = CLAMP(Δw_ltd × (1 − r), −2 × A_post, 0)  = CLAMP(..., −0.12, 0)
```

| r | LTP effect | LTD effect |
|---|-----------|-----------|
| +1.0 (verified correct) | ×2.0 → maximal | ×0 → zeroed |
| +0.5 (done, unverified) | ×1.5 | ×0.5 |
| 0.0 (explicit neutral) | ×1.0 (unchanged) | ×1.0 |
| null (unlabeled) | unmodulated | unmodulated |
| −0.5 (cancelled) | ×0.5 | ×1.5 |
| −1.0 (correction) | ×0 → zeroed | ×2.0 → maximal |

**Reward signal inputs** (populated by `backfillRewardSignals`):

| Input | Value |
|-------|-------|
| Task: `status='done'`, `verification.passed=true` | +1.0 |
| Task: `status='done'`, verification not passed | +0.5 |
| Task: `status='cancelled'` | −0.5 |
| `cleo memory verify <id>` | +1.0 |
| `cleo memory invalidate <id>` | −1.0 |
| No signal | null |

### §3.7 Novelty Boost

On edge INSERT (first-ever co-activation of A→B), apply novelty multiplier:

```
k_novelty = 1.5
initial_weight = CLAMP(Δw_ltp × k_novelty, 0, A_pre × k_novelty)
```

`k_novelty` applies ONLY on the INSERT path. On UPDATE (existing edge), standard Δw_ltp is used.
`reinforcement_count` starts at 1 on INSERT.

### §3.8 Self-Pair Guard

If `spikeA.entryId === spikeB.entryId`, skip the pair. Self-loops have no semantic value.

### §3.9 Homeostatic Decay (Step 9c)

After STDP (Step 9b), apply temporal decay to all non-static edges idle beyond the threshold:

```
For each edge where plasticity_class IN ('hebbian', 'stdp')
  AND last_reinforced_at IS NOT NULL
  AND (now − last_reinforced_at) > decay_threshold_days:

  new_weight = weight × POWER(1 − decay_rate, days_idle)

  if new_weight < min_weight:
    DELETE edge
    writeWeightHistory(edge, eventKind='prune')
  else:
    UPDATE weight = new_weight
```

**Default parameters**:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `decay_rate` | 0.02 per day | Weight halves in ~35 days without reinforcement |
| `decay_threshold_days` | 7 | No decay for first week; keeps weekly-session edges alive |
| `min_weight` | 0.05 | Prune below 5% — no meaningful signal |

SQL implementation:

```sql
UPDATE brain_page_edges
SET weight = weight * POWER(1.0 - 0.02,
    CAST((julianday('now') - julianday(last_reinforced_at)) AS REAL))
WHERE plasticity_class IN ('hebbian', 'stdp')
  AND last_reinforced_at IS NOT NULL
  AND julianday('now') - julianday(last_reinforced_at) > 7
  AND weight > 0.05;

DELETE FROM brain_page_edges
WHERE plasticity_class IN ('hebbian', 'stdp')
  AND last_reinforced_at IS NOT NULL
  AND julianday('now') - julianday(last_reinforced_at) > 7
  AND weight * POWER(1.0 - 0.02,
      CAST((julianday('now') - julianday(last_reinforced_at)) AS REAL)) <= 0.05;
```

**Static edge protection**: Edges with `plasticity_class = 'static'` (structural types:
`contains`, `defines`, `imports`, `extends`, `implements`, `documents`, `applies_to`,
`references`, `code_reference`) MUST NEVER be subject to decay.

### §3.10 `plasticity_class` Assignment Rules

| Trigger | Assignment |
|---------|-----------|
| Edge INSERT by `strengthenCoRetrievedEdges` (Hebbian) | `'hebbian'` |
| Edge INSERT by `applyStdpPlasticity` (LTP) | `'stdp'` |
| Edge UPDATE by `applyStdpPlasticity` (LTP or LTD) | `'stdp'` (upgrades from 'hebbian') |
| All other structural edge INSERTs | `'static'` (DEFAULT) |

### §3.11 Cross-Session Spike Grouping — Performance Guard

With `lookbackDays=30`, the spike array may contain 30,000+ rows × 5 entries/row = 150,000
spikes. The `O(n²)` pair loop with the `break` optimization requires spikes to be sorted by
`retrievedAt`. With `pairingWindowMs=24h`, the inner loop runs longer before breaking.

Mitigation REQUIRED: chunk the spike array by `session_id` (null session = single bucket).
Cross-session pairs are only compared between adjacent session buckets, not all-pairs globally.

**Performance target**: 30,000 log rows × 5 entries = 150,000 spikes → consolidation MUST
complete in < 30 seconds.

### §3.12 Complete Algorithm Pseudocode

```typescript
export async function applyStdpPlasticity(
  projectRoot: string,
  options?: {
    lookbackDays?: number;      // default: 30
    pairingWindowMs?: number;   // default: 86_400_000 (24h)
  }
): Promise<StdpPlasticityResult>

// Implementation sketch:
const cutoff = Date.now() - (opts.lookbackDays * 86_400_000);
const logRows = fetchRetrievalRows(cutoff);       // includes reward_signal
const spikes = expandToSpikes(logRows);           // one spike per entry_id per row
spikes.sort((a, b) => a.retrievedAt - b.retrievedAt || a.order - b.order);

// Group by session for cross-session chunking (§3.11)
const sessionBuckets = groupBySession(spikes);

for (const [sessionId, sessionSpikes] of adjacentBucketPairs(sessionBuckets)) {
  for (let i = 0; i < sessionSpikes.length; i++) {
    const spikeA = sessionSpikes[i];
    const rewardA = logRows.get(spikeA.rowId)?.reward_signal ?? null;

    for (let j = i + 1; j < sessionSpikes.length; j++) {
      const spikeB = sessionSpikes[j];
      const deltaT = spikeB.retrievedAt - spikeA.retrievedAt;

      if (deltaT > opts.pairingWindowMs) break;     // sorted → safe early exit
      if (spikeA.entryId === spikeB.entryId) continue; // §3.8 self-pair guard

      const tau = computeTau(deltaT, opts);
      let deltaWLtp = opts.aPre * Math.exp(-deltaT / tau);
      if (Math.abs(deltaWLtp) < 1e-6) continue;

      // R-STDP modulation (§3.6)
      let deltaWLtd = -(opts.aPost * Math.exp(-deltaT / tau));
      if (rewardA !== null) {
        deltaWLtp = Math.min(deltaWLtp * (1 + rewardA), 2 * opts.aPre);
        deltaWLtd = Math.max(deltaWLtd * (1 - rewardA), -2 * opts.aPost);
      }

      // LTP: A→B (novelty boost on first-ever pair)
      const isNovel = !edgeExists(spikeA.entryId, spikeB.entryId);
      const effectiveLtp = isNovel
        ? Math.min(deltaWLtp * opts.noveltyBoost, opts.aPre * opts.noveltyBoost)
        : deltaWLtp;
      upsertEdge(spikeA.entryId, spikeB.entryId, effectiveLtp, 'stdp');
      writePlasticityEvent('ltp', spikeA, spikeB, effectiveLtp, rewardA, deltaT);
      writeWeightHistory(spikeA.entryId, spikeB.entryId, effectiveLtp, 'ltp');

      // LTD: B→A (only weaken existing)
      if (edgeExists(spikeB.entryId, spikeA.entryId) && Math.abs(deltaWLtd) >= 1e-6) {
        updateEdgeWeight(spikeB.entryId, spikeA.entryId, deltaWLtd);
        writePlasticityEvent('ltd', spikeB, spikeA, deltaWLtd, rewardA, deltaT);
        writeWeightHistory(spikeB.entryId, spikeA.entryId, deltaWLtd, 'ltd');
      }
    }
  }
}
```

### §3.13 `StdpPlasticityResult` Interface

```typescript
export interface StdpPlasticityResult {
  ltpEvents: number;
  ltdEvents: number;
  edgesCreated: number;
  pairsExamined: number;
  rewardModulatedEvents: number; // pairs where reward_signal was non-null
}
```

### §3.14 Complete Hyperparameter Reference

| Symbol | Default | Config path |
|--------|---------|-------------|
| `A_pre` | 0.05 | `brain.plasticity.a_pre` |
| `A_post` | 0.06 | `brain.plasticity.a_post` |
| `τ_near` | 20,000 ms | `brain.plasticity.tau_near_ms` |
| `τ_session` | 1,800,000 ms | `brain.plasticity.tau_session_ms` |
| `τ_episodic` | 43,200,000 ms | `brain.plasticity.tau_episodic_ms` |
| `pairingWindowMs` | 86,400,000 ms | `brain.plasticity.pairing_window_ms` |
| `lookbackDays` | 30 | `brain.plasticity.lookback_days` |
| `k_novelty` | 1.5 | `brain.plasticity.novelty_boost` |
| `decay_rate` | 0.02 per day | `brain.plasticity.decay_rate_per_day` |
| `decay_threshold_days` | 7 | `brain.plasticity.decay_threshold_days` |
| `min_weight` | 0.05 | `brain.plasticity.min_weight` |

All parameters are Phase 5 hardcoded defaults. Config-based tuning is Phase 6+.

---

## §4 Integration

### §4.1 Writer Hook Location — Session-End Batch (LOCKED)

**Decision**: `applyStdpPlasticity` runs as Step 9b of `runConsolidation`, called from
`handleSessionEndConsolidation` at hook priority 5. This is already wired at
`brain-lifecycle.ts:710`. The fix is correctness (lookback window, session_id, τ tiers),
not relocation.

**Justification**:
1. Already wired — no new wiring required
2. Biological correctness — STDP requires processing the complete spike sequence; session-end is
   the natural "sleep consolidation" boundary
3. No hot-path impact — runs `setImmediate` after session response returns
4. Cross-session pairs — `lookbackDays=30` spans multiple sessions; Step 9 detects them on
   every consolidation run
5. Idempotency — UPSERT on `brain_page_edges (from_id, to_id, edge_type)` is idempotent by PK

**Fallback for crashed sessions**: The next session's consolidation processes missed rows via the
30-day lookback. No retrieval data is permanently lost.

### §4.2 Observer/Reflector Ordering

```
priority 100  brain-session-end         handleSessionEnd          (transcript extraction, memory bridge)
priority 10   backup-session-end        handleSessionEndBackup    (SQLite VACUUM INTO)
priority 5    consolidation-session-end handleSessionEndConsolidation (runConsolidation incl. STDP)
priority 4    reflector-session-end     handleSessionEndReflector (runReflector — LLM synthesis)
```

Plasticity (priority 5) MUST run BEFORE the LLM reflector (priority 4). Correct causal
direction: plasticity reads retrievals → updates edges → reflector synthesizes from updated graph.

**Sub-step ordering within `runConsolidation`**:

```
Step 6    strengthenCoRetrievedEdges   (Hebbian co-occurrence — 30-day window)
Step 9a   backfillRewardSignals        (R-STDP reward assignment from task outcomes)
Step 9b   applyStdpPlasticity          (STDP timing-dependent Δw using reward_signal)
Step 9c   applyHomeostaticDecay        (synaptic scaling + pruning)
Step 9d   [weight_history retention]  (DELETE FROM brain_weight_history WHERE changed_at < 90d)
Step 9e   logConsolidationEvent        (INSERT into brain_consolidation_events)
```

Step 6 MUST precede Step 9b (Hebbian creates edges; STDP refines them via LTD).
Step 9a MUST precede Step 9b (reward signals must exist before STDP reads them).

**Minimum-pair gate**: Before running Step 9b, check if `brain_retrieval_log` has fewer than
2 new rows since the last `brain_plasticity_events` timestamp. If so, skip Step 9b — it is a
no-op and avoids unnecessary overhead on sessions with no retrievals.

### §4.3 `backfillRewardSignals` Specification

```typescript
export interface RewardBackfillResult {
  rowsLabeled: number;
  rowsSkipped: number;
}

export async function backfillRewardSignals(
  projectRoot: string,
  sessionId: string,
  lookbackDays?: number, // default: 30
): Promise<RewardBackfillResult>
```

The function MUST:
1. Query `brain_retrieval_log` for rows where `session_id = sessionId` AND `reward_signal IS NULL`
   AND `session_id NOT LIKE 'ses_backfill_%'` (skip synthetic sessions — no task correlation)
2. Query `tasks.db` for tasks completed/cancelled in the last `lookbackDays` days, with
   session attribution matching `sessionId`
3. Assign reward values: +1.0 (verified done), +0.5 (done unverified), −0.5 (cancelled)
4. UPDATE `brain_retrieval_log SET reward_signal = ?` for rows in that session
5. INSERT a `brain_modulators` row for each task outcome processed (in a separate
   `brain.db` transaction after the tasks.db read completes)
6. Return `{ rowsLabeled, rowsSkipped }`

**Transaction pattern**: two separate SQLite connections (not ATTACH). Read tasks.db →
compute reward map → write brain.db in two separate transactions. This matches the
`cross-db-cleanup.ts` pattern.

### §4.4 `session_id` at `logRetrieval` Call Sites

The `logRetrieval` function at `brain-retrieval.ts:1483` accepts `sessionId?: string`.
Every call site MUST pass the active session ID from context. Call sites MUST be audited and
updated. If no session is active, `session_id = NULL` (existing behavior).

### §4.5 T628 Auto-Dream Cycle Integration

Plasticity IS part of the dream cycle. The dream cycle is `runConsolidation` with intelligent
triggers. Since STDP is Step 9b of `runConsolidation`, any dream trigger automatically fires
STDP.

T628 scope expansion (required, not optional):
1. `cleo memory dream` MUST call `runConsolidation(projectRoot)` (which includes STDP)
2. The dream scheduler MUST pass the current `sessionId` to `backfillRewardSignals` (Step 9a)
3. Dream triggers in priority order:
   - Volume threshold (primary): M=10 new `brain_observations` since last consolidation
   - Idle detection (secondary): N=30 min of no retrieval activity
   - Scheduled cron (tertiary): nightly catch-up pass

**Session-end consolidation backstop**: Session end continues to fire `runConsolidation`. The
minimum-pair gate (§4.2) prevents no-op overhead when sessions have no retrievals.

### §4.6 CLI Surface

All new commands add to `packages/cleo/src/cli/commands/brain.ts` under the existing
`brain plasticity` subcommand group.

#### §4.6.1 `cleo brain plasticity events`

```
cleo brain plasticity events [--since <ISO-date>] [--limit <n>] [--session <id>] [--kind ltp|ltd] [--json]
```

Lists recent plasticity events from `brain_plasticity_events`. Default limit 50. Newest-first.
Backend: new `getPlasticityEvents(projectRoot, options)` exported from `brain-stdp.ts`.

#### §4.6.2 `cleo brain plasticity apply`

```
cleo brain plasticity apply [--dry-run] [--json]
```

Manual trigger — calls `applyStdpPlasticity(projectRoot)` immediately. With `--dry-run`,
reports pair count without writing events. Useful for forcing consolidation and verifying
the 0-events bug is fixed.

#### §4.6.3 `cleo brain plasticity history`

```
cleo brain plasticity history --source <node-id> --target <node-id> [--limit <n>] [--json]
```

Shows all plasticity events for a specific source→target pair ordered by timestamp.
Derives weight change series from `brain_plasticity_events`. This is the Phase 5
substitute for the Phase 7 weight history table — the data is already there.

#### §4.6.4 `cleo brain plasticity reset`

```
cleo brain plasticity reset [--confirm] [--json]
```

Destructive: truncates `brain_plasticity_events` and resets `brain_page_edges.weight=1.0`
for `co_retrieved` edges. Requires `--confirm`. MUST print a clear warning. Intended for
testing/debugging only.

#### §4.6.5 `cleo memory dream` (T628 scope)

```
cleo memory dream [--dry-run] [--json]
```

Manually triggers the full dream cycle (= `runConsolidation`). With `--dry-run`, reports
what would run. Output includes per-step counts.

#### §4.6.6 `cleo memory consolidate`

```
cleo memory consolidate [--json]
```

Verify this exists. If missing, add as alias for `cleo memory dream` but executing only
Steps 1–8 (no STDP). Satisfies T628's "disable auto-trigger" requirement.

### §4.7 Studio UI Integration (Phase 6 planning)

These items are NOT in T673 scope. They are planning requirements for Phase 6 (T660 expansion).

**Already working (no changes needed)**: `LivingBrainGraph.svelte` already renders edge
thickness proportional to `edge.weight`. Once STDP writes non-trivial weights, the canvas
automatically shows weight-scaled edges. No renderer changes needed for basic weight viz.

**Phase 6 additions**:
- `PlasticityFeed.svelte` — scrolling feed of recent events polling
  `GET /api/brain/plasticity-events` (new SvelteKit route)
- LTP pulse animation — flash edges where `brain_plasticity_events.timestamp > (now - 60s)`
- Edge weight history sparkline — mini chart of Δw history when clicking a `co_retrieved` edge
- Stub node guard: if `from_id` or `to_id` maps to a stub node (`meta.isStub: true`),
  set `weight: undefined` in the brain substrate adapter. MUST be applied in `adapters/brain.ts`,
  not the renderer. Gated on T663 (stub-node loader) being complete.

**New SvelteKit API route**:
`packages/studio/src/routes/api/brain/plasticity-events/+server.ts` (Phase 6)
- Method: `GET`
- Params: `limit` (default 50), `since` (ISO date), `kind` (ltp|ltd|all)
- Returns: `{ events: PlasticityEvent[], totalEvents: number, lastEventAt: string | null }`

### §4.8 Idempotency Guard for `brain_plasticity_events`

To prevent duplicate events when consolidation runs multiple times against the same session,
`applyStdpPlasticity` MUST check before inserting:

```sql
SELECT 1 FROM brain_plasticity_events
WHERE source_node = ? AND target_node = ? AND session_id = ?
AND timestamp > datetime('now', '-1 hour')
LIMIT 1
```

If a matching recent event exists, skip the INSERT. This makes repeated consolidation runs
safe without requiring a complex global dedup strategy.

---

## §5 Migration Sequence

All migration files go under `packages/core/migrations/drizzle-brain/`.
Latest existing: `20260415000001_t626-normalize-co-retrieved-edge-type`.
New migrations use `20260416` prefix to guarantee ordering.

### §5.1 M1 — `brain_retrieval_log` Columns + Data Fix

**File**: `20260416000001_t673-retrieval-log-plasticity-columns/migration.sql`

**Scope**: Adds `session_id` (via ALTER, already in Drizzle), `reward_signal` (new to both),
`retrieval_order` (exists in live table — adds to Drizzle schema), `delta_ms` (same). Converts
`entry_ids` from comma-sep to JSON array. Backfills `session_id` with synthetic date-bucket IDs.

```sql
-- T673-M1: Plasticity columns for brain_retrieval_log
-- Idempotent: ALTER TABLE ADD COLUMN silently skips if column exists (SQLite behavior)

ALTER TABLE `brain_retrieval_log` ADD COLUMN `session_id` text;
--> statement-breakpoint
ALTER TABLE `brain_retrieval_log` ADD COLUMN `reward_signal` real;
--> statement-breakpoint
ALTER TABLE `brain_retrieval_log` ADD COLUMN `retrieval_order` integer;
--> statement-breakpoint
ALTER TABLE `brain_retrieval_log` ADD COLUMN `delta_ms` integer;
--> statement-breakpoint

-- Convert comma-separated entry_ids to JSON array format (idempotent)
UPDATE `brain_retrieval_log`
SET entry_ids = '["' || REPLACE(entry_ids, ',', '","') || '"]'
WHERE entry_ids IS NOT NULL AND entry_ids != '' AND entry_ids NOT LIKE '[%';
--> statement-breakpoint

-- Backfill synthetic session IDs for historical rows
UPDATE `brain_retrieval_log`
SET session_id = 'ses_backfill_' || substr(created_at, 1, 10)
WHERE session_id IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_retrieval_log_reward` ON `brain_retrieval_log` (`reward_signal`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_retrieval_log_session` ON `brain_retrieval_log` (`session_id`);
```

**Rollback**: `ALTER TABLE DROP COLUMN` is NOT supported in SQLite. Rollback requires
re-creating the table without the new columns — considered impractical. M1 SHOULD be treated
as irreversible. Data is preserved (no rows deleted).

### §5.2 M2 — `brain_plasticity_events` Expansion

**File**: `20260416000002_t673-plasticity-events-expand/migration.sql`

**Scope**: Adds `weight_before`, `weight_after`, `retrieval_log_id`, `reward_signal`,
`delta_t_ms` to `brain_plasticity_events`.

```sql
-- T673-M2: Expand brain_plasticity_events with observability columns
-- Table currently has 0 rows — all new columns nullable, no data impact

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

**Rollback**: Same SQLite limitation as M1. Irreversible in practice.

### §5.3 M3 — `brain_page_edges` Plasticity Columns

**File**: `20260416000003_t673-page-edges-plasticity-columns/migration.sql`

**Scope**: Adds 6 plasticity tracking columns. Seeds `co_retrieved` edges as `plasticity_class='hebbian'`.

```sql
-- T673-M3: Plasticity tracking columns for brain_page_edges
-- Seed: co_retrieved edges are Hebbian-origin, not static

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

UPDATE `brain_page_edges` SET plasticity_class = 'hebbian' WHERE edge_type = 'co_retrieved';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_brain_edges_last_reinforced` ON `brain_page_edges` (`last_reinforced_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_plasticity_class` ON `brain_page_edges` (`plasticity_class`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_brain_edges_stability` ON `brain_page_edges` (`stability_score`);
```

**Rollback**: Irreversible (SQLite ADD COLUMN). The seed UPDATE is idempotent on re-run.

### §5.4 M4 — New Plasticity Tables

**File**: `20260416000004_t673-new-plasticity-tables/migration.sql`

**Scope**: Creates `brain_weight_history`, `brain_modulators`, `brain_consolidation_events`.
All `CREATE TABLE IF NOT EXISTS` — idempotent.

```sql
-- T673-M4: New plasticity infrastructure tables
-- All IF NOT EXISTS — safe to apply multiple times

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

**Rollback**: `DROP TABLE IF EXISTS brain_weight_history; DROP TABLE IF EXISTS brain_modulators;
DROP TABLE IF EXISTS brain_consolidation_events;` — fully reversible.

### §5.5 `ensureColumns` Safety Net

Add to `packages/core/src/store/brain-sqlite.ts:runBrainMigrations`:

```typescript
// T673: plasticity columns on brain_retrieval_log
if (tableExists(nativeDb, 'brain_retrieval_log')) {
  ensureColumns(nativeDb, 'brain_retrieval_log', [
    { name: 'session_id', ddl: 'text' },
    { name: 'reward_signal', ddl: 'real' },
    { name: 'retrieval_order', ddl: 'integer' },
    { name: 'delta_ms', ddl: 'integer' },
  ], 'brain');
}

// T673: observability columns on brain_plasticity_events
if (tableExists(nativeDb, 'brain_plasticity_events')) {
  ensureColumns(nativeDb, 'brain_plasticity_events', [
    { name: 'weight_before', ddl: 'real' },
    { name: 'weight_after', ddl: 'real' },
    { name: 'retrieval_log_id', ddl: 'integer' },
    { name: 'reward_signal', ddl: 'real' },
    { name: 'delta_t_ms', ddl: 'integer' },
  ], 'brain');
}

// T673: plasticity tracking columns on brain_page_edges
ensureColumns(nativeDb, 'brain_page_edges', [
  { name: 'last_reinforced_at', ddl: 'text' },
  { name: 'reinforcement_count', ddl: 'integer NOT NULL DEFAULT 0' },
  { name: 'plasticity_class', ddl: "text NOT NULL DEFAULT 'static'" },
  { name: 'last_depressed_at', ddl: 'text' },
  { name: 'depression_count', ddl: 'integer NOT NULL DEFAULT 0' },
  { name: 'stability_score', ddl: 'real' },
], 'brain');

// T673: new tables — self-healing CREATE IF NOT EXISTS
nativeDb.exec(`CREATE TABLE IF NOT EXISTS brain_weight_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_from_id TEXT NOT NULL, edge_to_id TEXT NOT NULL, edge_type TEXT NOT NULL,
  weight_before REAL, weight_after REAL NOT NULL, delta_weight REAL NOT NULL,
  event_kind TEXT NOT NULL, source_plasticity_event_id INTEGER,
  retrieval_log_id INTEGER, reward_signal REAL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
nativeDb.exec(`CREATE TABLE IF NOT EXISTS brain_modulators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  modulator_type TEXT NOT NULL, valence REAL NOT NULL, magnitude REAL NOT NULL DEFAULT 1.0,
  source_event_id TEXT, session_id TEXT, description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
nativeDb.exec(`CREATE TABLE IF NOT EXISTS brain_consolidation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL, session_id TEXT, step_results_json TEXT NOT NULL,
  duration_ms INTEGER, succeeded INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
```

### §5.6 Migration Ordering and Dependencies

```
M1 (retrieval_log columns) → M2 (plasticity_events columns) → M3 (page_edges columns) → M4 (new tables)
```

M4 has no dependency on M1–M3. M2 has no dependency on M1 or M3. All four can theoretically
run in parallel if applied as one migration bundle. The numbered sequence ensures deterministic
application order.

---

## §6 Test Plan

### §6.1 Owner Directive

"Tested functionally for REAL — no fake mock or just vitests, we need automated testing but
that doesn't test real world."

Existing `brain-stdp.test.ts` uses `vi.mock('../../store/brain-sqlite.js')`. These unit tests
are sound for LTP/LTD math but cannot detect the three root-cause bugs (window conflation,
entry_ids format, missing session_id) — all of which are runtime integration failures invisible
to mocked tests.

### §6.2 Unit Tests (Augment Existing `brain-stdp.test.ts`)

The existing unit tests MUST be augmented (not replaced):

1. LTP formula with tiered τ — test all three τ tiers with known Δt inputs and expected Δw
2. LTD formula with tiered τ — same
3. R-STDP modulation — test r=+1.0, r=-1.0, r=+0.5, r=null with correct Δw output
4. Novelty boost — novel pair gets 1.5× weight; repeated pair gets standard weight
5. `computeTau` function — all three tier boundaries

**No `vi.mock` on brain-sqlite.js in these new tests.** The existing mocked tests remain
but do NOT cover the functional correctness requirements.

### §6.3 Functional Test — Real brain.db, No Mocks

**File**: `packages/core/src/memory/__tests__/brain-stdp-functional.test.ts`

This test MUST NOT call `vi.mock` for any brain or SQLite module.

**Setup**: Each `it()` block gets its own `mkdtemp` directory. `beforeEach` sets
`process.env.CLEO_DIR` to the temp dir. `afterEach` calls `closeBrainDb()` and restores
the env and removes the temp dir.

**Time strategy**: Insert retrieval rows using `datetime('now', '-30 seconds')`,
`datetime('now', '-20 seconds')` etc. — real SQLite expressions evaluated at INSERT time.
No `sleep()` calls. No time mocking. Test runs in < 1 second.

**CI timeout**: Set `vi.setConfig({ testTimeout: 30_000 })` at file level.

**Test cases**:

```typescript
describe('STDP Functional — real brain.db, no mocks', () => {

  it('STDP-F1: LTP event written after two correlated retrievals', async () => {
    // Insert brain_page_nodes for obs:A, obs:B
    // Insert 2 retrieval rows: obs:A at T-30s, obs:B at T-10s (JSON entry_ids)
    // Run applyStdpPlasticity(tempDir)
    // Assert: brain_plasticity_events COUNT > 0; at least one kind='ltp'
    // Assert: brain_page_edges has co_retrieved edge with weight > 0
  });

  it('STDP-F2: brain maintenance CLI command produces events', async () => {
    // Insert retrieval rows as above
    // Execute: cleo brain maintenance --json via execFileSync against real binary
    // Assert: exit code 0; brain_plasticity_events COUNT > 0
    // Assert: cleo brain plasticity stats --json returns totalEvents > 0
    // Guard: if cleo binary not found → test.skip
  });

  it('STDP-F3: cross-session pair detection', async () => {
    // Insert session_id='ses_test_A': obs:A+obs:B at T-2d
    // Insert session_id='ses_test_B': obs:B+obs:C at T-30s
    // Run applyStdpPlasticity(tempDir, { lookbackDays: 30 })
    // Assert: event for obs:B→obs:C and obs:A→obs:B both exist
  });

  it('STDP-F4: LTD weakens reverse edge', async () => {
    // Pre-insert edge obs:B→obs:A at weight=0.8
    // Insert retrieval rows: obs:B at T-30s, obs:A at T-10s (B fires before A)
    // Run applyStdpPlasticity(tempDir)
    // Assert: brain_plasticity_events has kind='ltd'
    // Assert: brain_page_edges (obs:B→obs:A) weight < 0.8
  });

  it('STDP-F5: JSON entry_ids accepted; comma-sep produces no events', async () => {
    // Insert row with entry_ids='["obs:A","obs:B"]' → events fire
    // Insert row with entry_ids='obs:A,obs:B' → no events for that row
    // Assert the distinction
  });

  it('STDP-F6: session_id propagated to brain_plasticity_events', async () => {
    // Insert retrieval rows with session_id='ses_test_functional'
    // Run applyStdpPlasticity
    // Assert: all plasticity events have session_id='ses_test_functional'
  });

  it('STDP-F7: R-STDP reward_signal modulates Δw', async () => {
    // Insert rows with reward_signal=1.0
    // Run applyStdpPlasticity
    // Assert: delta_w > A_pre (0.05) — modulation doubled it toward 0.10
    // Insert rows with reward_signal=-1.0
    // Assert: LTP delta_w ≈ 0
  });

  it('STDP-F8: homeostatic decay prunes idle edges', async () => {
    // Insert brain_page_edges co_retrieved with weight=0.06, last_reinforced_at=30d ago
    // Run applyHomeostaticDecay(tempDir)
    // Assert: edge deleted (weight decayed below min_weight=0.05)
  });

});
```

### §6.4 Integration Test — Consolidation Pipeline

Add to the existing `brain-lifecycle.test.ts` or create `brain-lifecycle-integration.test.ts`:

- Step ordering: verify 9a runs before 9b, 9b before 9c
- `RunConsolidationResult` has `rewardBackfilled`, `ltpEvents`, `ltdEvents`, `edgesPruned`
- Consolidation-event row inserted after each run

### §6.5 Test Placement in CI

All functional tests MUST be discoverable by `pnpm run test` in `packages/core` via the
existing `**/*.test.ts` glob. No separate CI step required. Use `pool: 'forks'` in
`vitest.config.ts` for the functional test file if mock isolation issues arise.

---

## §7 Observability

### §7.1 Metrics Exposed

| Metric | Source | Query |
|--------|--------|-------|
| Total plasticity events | `brain_plasticity_events` | `SELECT COUNT(*), kind FROM brain_plasticity_events GROUP BY kind` |
| LTP/LTD ratio | Same | Derived from above |
| Events per session | Same | `GROUP BY session_id` |
| Reward-modulated events | Same | `WHERE reward_signal IS NOT NULL` |
| Active plastic edges | `brain_page_edges` | `SELECT COUNT(*), plasticity_class FROM brain_page_edges GROUP BY plasticity_class` |
| Edges pruned this session | `brain_weight_history` | `SELECT COUNT(*) WHERE event_kind='prune' AND changed_at > last_session_start` |
| Consolidation run history | `brain_consolidation_events` | All rows, ordered by `started_at DESC` |
| Modulator events | `brain_modulators` | `GROUP BY modulator_type` |

### §7.2 `cleo brain plasticity stats` Enhancements

The existing `getPlasticityStats` function MUST be extended to return:

```typescript
export interface PlasticityStats {
  totalEvents: number;
  ltpEvents: number;
  ltdEvents: number;
  rewardModulatedEvents: number;  // NEW
  edgesCreated: number;           // edges currently in brain_page_edges with plasticity_class != 'static'
  edgesPruned: number;            // from brain_weight_history WHERE event_kind='prune'
  lastEventAt: string | null;
  lastConsolidationAt: string | null;  // NEW — from brain_consolidation_events
}
```

### §7.3 Health Indicators

A healthy plasticity system shows:
- `totalEvents > 0` after the first session end following M1–M4 migration
- `rewardModulatedEvents / totalEvents > 0` if any tasks were completed
- `edgesPruned` is non-zero after sessions where stale edges existed
- `brain_consolidation_events` has a row for every `cleo session end`

---

## §8 Rollback Plan

| Migration | Reversible? | Method |
|-----------|-------------|--------|
| M1 (retrieval_log ALTER) | No (SQLite limitation) | Accept irreversibility; data preserved |
| M1 (entry_ids UPDATE) | Partial — can re-apply but not undo format change | Original comma-sep data is not restorable from JSON after conversion |
| M1 (session_id backfill) | Yes — `UPDATE brain_retrieval_log SET session_id=NULL WHERE session_id LIKE 'ses_backfill_%'` | Full rollback |
| M2 (plasticity_events ALTER) | No (SQLite) | Accept; 0 rows affected |
| M3 (page_edges ALTER) | No (SQLite) | Accept; new columns nullable or have defaults |
| M4 (new tables CREATE) | Yes — `DROP TABLE IF EXISTS ...` for all three | Full rollback |
| ensureColumns guard | Self-idempotent | Safe to re-run |

**Practical rollback**: M1–M3 ALTER TABLE operations are not reversible in SQLite without
table recreation. Given that the live `brain_plasticity_events` has 0 rows and
`brain_retrieval_log` has 38 rows, a full rollback would require restoring from the last
`cleo backup` snapshot. The `cleo backup add` command creates a VACUUM INTO snapshot of
all four CLEO database files and MUST be run before applying migrations.

---

## §9 Acceptance Criteria for the Full STDP Epic

All of the following MUST be true before T673 is marked complete:

| ID | Criterion |
|----|-----------|
| AC-1 | Running `cleo brain maintenance` on a project with at least 2 retrieval log rows in the 30-day window produces `brain_plasticity_events COUNT(*) > 0` |
| AC-2 | `cleo brain plasticity stats` reports `totalEvents > 0` after running the functional test |
| AC-3 | `brain_retrieval_log` has `session_id` and `reward_signal` columns in the live project brain.db (confirmed via `PRAGMA table_info`) |
| AC-4 | `brain_plasticity_events` rows contain `session_id`, `weight_before`, `weight_after`, `retrieval_log_id`, `reward_signal`, `delta_t_ms` values (non-null for events triggered with real session context) |
| AC-5 | Functional test at `brain-stdp-functional.test.ts` passes via `pnpm run test` with ZERO mocked DB components |
| AC-6 | `brain_page_edges` has `last_reinforced_at`, `reinforcement_count`, `plasticity_class` columns; `co_retrieved` edges have `plasticity_class = 'stdp'` after at least one STDP pass |
| AC-7 | `brain_weight_history` table exists and contains rows after running `cleo brain maintenance` (LTP/LTD events write history) |
| AC-8 | `brain_modulators` table exists and contains rows after `cleo session end` on a project with at least one completed task |
| AC-9 | `brain_consolidation_events` table exists and contains one row per `cleo session end` run |
| AC-10 | Homeostatic decay (`applyHomeostaticDecay`) deletes edges idle > 7 days with weight < 0.05 (verified by STDP-F8 test) |
| AC-11 | R-STDP: `reward_signal = +1.0` causes measured delta_w ≈ 0.10 (vs standard 0.05) for a same-batch pair (verified by STDP-F7 test) |
| AC-12 | Cross-session pairs (retrievals in two sessions 2d apart) produce LTP events (verified by STDP-F3 test) |
| AC-13 | `docs/plans/stdp-feasibility.md §10` updated to show Phase 5 DONE with link to functional test |
| AC-14 | ADR written and committed documenting the three root-cause bugs and all architectural decisions |
| AC-15 | `pnpm biome check --write .` passes; `pnpm run build` passes; `pnpm run test` passes with zero new failures |

---

## §10 Open Questions

As of synthesis date 2026-04-15, there are **zero open questions** requiring owner decision
before workers begin. All Q1–Q5 from the RCASD plan and all cross-council open questions have
been resolved in this specification.

**Owner-acknowledged choices** (not questions — decisions made in this synthesis):

| Choice | Decision | Rationale |
|--------|----------|-----------|
| `entry_ids` format Phase 5 | Option B (JSON array) | Fixes BUG-2 immediately; Option C deferred to T709 |
| `entry_ids` migration | Migrate (not truncate) existing 38 rows | Historical data preserved |
| `session_id` backfill for 38 rows | Date-bucketing synthetic IDs | Better than null; simpler than clustering |
| `brain_weight_history` scope | IN SCOPE for T673 (Phase 5) | Owner directive: do NOT delay |
| Decay events in weight_history | NOT written to history | Too voluminous; only LTP/LTD/prune/hebbian written |
| `plasticity_class` upgrade trigger | On first STDP touch (UPDATE or INSERT) | Simplest rule; class = most recent algorithm |
| `stability_score` formula | `tanh(rc/10) × exp(-(days_since/30))` | Validated by Algorithm Lead B |
| `delta_t_ms` source | Δt between retrieval ROWS (not intra-batch entry ordering) | What the algorithm actually computes |
| `backfillRewardSignals` transaction | Two separate connections (read tasks.db, write brain.db) | Matches `cross-db-cleanup.ts` pattern |
| Writer hook location | Session-end consolidation Step 9 | Already wired; correct causal model |
| `pairingWindowMs` default | 24 h | Cross-session pairs; owner Q2 LOCKED |

**Retained for owner awareness** (informational, not blocking):

- `brain_weight_history` retention: this spec sets 90-day rolling. Owner may tune via
  `cleo config set brain.plasticity.weight_history_retention_days <N>` in Phase 6+.
- Session-end consolidation overhead: the minimum-pair gate (§4.2) prevents no-op STDP on
  sessions with no retrievals. This is a heuristic; owner may disable the gate via config.

---

## §A Appendix: Schema Change Summary

| Table | Action | Columns Added | New Indexes | Migration |
|-------|--------|---------------|-------------|-----------|
| `brain_retrieval_log` | ALTER + DATA FIX | 4 | 1 | M1 |
| `brain_plasticity_events` | ALTER | 5 | 2 | M2 |
| `brain_page_edges` | ALTER + SEED | 6 | 3 | M3 |
| `brain_weight_history` | CREATE | 12 | 6 | M4 |
| `brain_modulators` | CREATE | 8 | 5 | M4 |
| `brain_consolidation_events` | CREATE | 7 | 3 | M4 |
| **TOTAL** | | **42 columns** | **20 indexes** | **4 files** |

---

*This specification is complete. Workers implementing T673 subtasks MUST treat this document
as the canonical source of truth. The three original council reports are superseded (reference only).*
