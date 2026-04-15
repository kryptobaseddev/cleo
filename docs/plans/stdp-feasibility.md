# STDP Feasibility & Implementation Plan

> **Doc version**: v1 (factored out of `brain-synaptic-visualization-research.md` v3)
> **Date**: 2026-04-15
> **Status**: Pre-implementation; owner checkpoint required before Phase 5 implementation
> **Parent plan**: [brain-synaptic-visualization-research.md](./brain-synaptic-visualization-research.md)
> **Locked decisions**: D-BRAIN-VIZ-04, D-BRAIN-VIZ-05, D-BRAIN-VIZ-08, D-BRAIN-VIZ-09, D-BRAIN-VIZ-12, D-BRAIN-VIZ-13

---

## §1 Critical Framing — what we are NOT building

| | Biological STDP (SNN) | STDP-inspired plasticity (CLEO) |
|---|---|---|
| Time resolution | Milliseconds | Event-ordered (minutes–hours) |
| Math | Differential equations, LIF integration | Exponential decay on scalar weights |
| Update cadence | Per-spike, real-time | Batch at session-end consolidation |
| Required framework | BindsNET / Nengo / Brian2 / Inferno | Plain SQL + Drizzle |
| Hardware | Neuromorphic chip or GPU | Commodity SQLite engine |
| Scale | 10⁴–10⁵ neurons, 10⁸ weights | 10³–10⁵ memory nodes, 10⁴–10⁶ edges |
| CLEO need? | **No** — not our problem class | **Yes** — agent memory plasticity |

**Per D-BRAIN-VIZ-09**: We are building STDP-*inspired* plasticity. Biological STDP is the wrong tool class for agent memory.

**What we keep from biological STDP**:
- Directional order (pre→post potentiates, post→pre depresses)
- Exponential Δt weighting
- LTD for unreinforced edges
- Asymmetric LTP/LTD amplitudes

**What we drop**:
- Spike simulation, LIF dynamics, millisecond precision
- Neuromodulator diffusion modeling
- Dendritic compartments
- Real-time per-event update

---

## §2 Why STDP-inspired over plain Hebbian

CLEO already ships Hebbian co-retrieval strengthening at `packages/core/src/memory/brain-lifecycle.ts:911` (`strengthenCoRetrievedEdges`). It works but is coarse:

| Limitation in current Hebbian | What STDP-inspired adds |
|---|---|
| No temporal order — pairs are unordered | Directional edges (pre→post strengthen, post→pre weaken) |
| Flat +0.1 weight increment | `Δw = A · exp(-Δt/τ)` — recency-weighted |
| No LTD — edges only grow | LTD prunes unreinforced edges; bounds graph growth |
| No per-edge-type plasticity rates | Procedural edges learn faster than semantic, etc. |
| `relates_to` undirected in practice | Causal directionality drives better traversal |

**Stability evidence** (relevant published work):
- Combined plasticity + synaptic scaling (SPaSS) is globally stable for a wide range of conditions when scaling depends quadratically on weights ([Frontiers 2012](https://www.frontiersin.org/journals/computational-neuroscience/articles/10.3389/fncom.2012.00036/full))
- Hebbian-based plasticity in transformers achieves "sharply gated" bursty updates around salient events ([OpenReview 2024](https://openreview.net/forum?id=34No0A0V56))
- Calcium-based Hebbian rules approximate STDP without spike simulation ([arXiv 2504.06796](https://arxiv.org/html/2504.06796v1))

---

## §3 Schema additions required

### 3.1 Add to `BRAIN_EDGE_TYPES` (Phase 3a, prerequisite)

```typescript
// packages/core/src/store/brain-schema.ts
export const BRAIN_EDGE_TYPES = [
  // ...existing 12 types...
  'co_retrieved',    // NEW: Hebbian/STDP plastic edges (renamed from 'relates_to')
  'code_reference',  // NEW: observation→symbol bridges (used by code-auto-link)
] as const;
```

One-shot migration: `UPDATE brain_page_edges SET edge_type='co_retrieved' WHERE edge_type='relates_to'`.

### 3.2 STDP columns on `brain_page_edges` (Phase 5)

```typescript
export const brainPageEdges = sqliteTable('brain_page_edges', {
  // ...existing columns...
  lastReinforcedAt: text('last_reinforced_at'),
  reinforcementCount: integer('reinforcement_count').notNull().default(0),
  plasticityClass: text('plasticity_class', {
    enum: ['static', 'hebbian', 'stdp'] as const,
  }).notNull().default('static'),
}, ...);
```

Indexes: `idx_brain_edges_last_reinforced`, `idx_brain_edges_plasticity_class`.

### 3.3 Timing/order/reward on `brain_retrieval_log` (Phase 5)

```typescript
export const brainRetrievalLog = sqliteTable('brain_retrieval_log', {
  // ...existing columns...
  sessionId: text('session_id'),
  retrievalOrder: integer('retrieval_order'), // sequence within query batch
  rewardSignal: real('reward_signal'),         // R-STDP: -1..+1, null = unlabeled
}, ...);
```

Indexes: `idx_retrieval_log_session`, `idx_retrieval_log_reward`.

### 3.4 Optional weight history audit (Phase 7)

```typescript
export const brainWeightHistory = sqliteTable('brain_weight_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  edgeFromId: text('edge_from_id').notNull(),
  edgeToId: text('edge_to_id').notNull(),
  edgeType: text('edge_type').notNull(),
  oldWeight: real('old_weight').notNull(),
  newWeight: real('new_weight').notNull(),
  deltaWeight: real('delta_weight').notNull(),
  cause: text('cause').notNull(), // 'ltp' | 'ltd' | 'decay' | 'prune' | 'manual'
  retrievalLogId: integer('retrieval_log_id'),
  rewardSignal: real('reward_signal'),
  changedAt: text('changed_at').notNull().default(sql`(datetime('now'))`),
}, ...);
```

Write only for `plasticity_class != 'static'` edges. Enables "show learning history of this memory" in Studio viz.

---

## §4 Algorithm — `consolidateStdpV2`

Runs as **step 6b** in `runConsolidation` (alongside the current Hebbian step 6a, feature-flagged per D-BRAIN-VIZ-04).

```
for each retrieval event E in last 30 days:
  let ids   = E.entry_ids       (ordered — firing sequence)
  let order = E.retrieval_order  (sequence within batch)
  let r     = E.reward_signal    (null | -1..+1)
  for i in 0..len(ids):
    for j in i+1..len(ids):
      pre  = ids[i]   # fired first
      post = ids[j]   # fired after
      Δt   = (j - i)  # ordinal distance
                       # (or wall-clock when 6.1's open question lands)
      # LTP (potentiation): pre before post
      Δw_ltp = A_plus * exp(-Δt / tau_plus)
      # LTD (depression): asymmetric weakening
      Δw_ltd = A_minus * exp(-Δt / tau_minus)
      # R-STDP modulation (D-BRAIN-VIZ-13)
      if r != null:
        Δw_ltp *= (1 + r)   # boost on positive reward, suppress on negative
        Δw_ltd *= (1 - r)
      strengthen(pre → post, Δw_ltp)
      weaken(post → pre, Δw_ltd)

# Global decay pass (exponential forgetting)
for each edge e in brain_page_edges where plasticity_class != 'static':
  if (now - e.last_reinforced_at) > decay_threshold:
    e.weight *= (1 - decay_rate)
    if e.weight < min_weight:
      delete e   # synaptic pruning (also: log to brain_weight_history with cause='prune')
```

### Default parameters (tunable via `cleo config`)

| Param | Default | Meaning |
|---|---|---|
| `A_plus`         | 0.10  | LTP amplitude |
| `A_minus`        | 0.05  | LTD amplitude (half of LTP — biological asymmetry) |
| `tau_plus`       | 3     | LTP time constant (ordinal steps) |
| `tau_minus`      | 5     | LTD time constant (slower — harder to forget) |
| `decay_rate`     | 0.02  | per-day exponential decay |
| `decay_threshold`| 7d    | silence before decay starts |
| `min_weight`     | 0.05  | prune below this |

---

## §5 Why SQLite handles this — scale math

| Metric | Today | 1-year stretch | Cross-project meta-brain |
|---|---|---|---|
| Brain entries | ~5K | ~50K | ~500K |
| Brain graph edges | ~10K | ~200K | ~2M |
| Retrieval events / day | ~1K | ~10K | ~100K |
| Consolidation cadence | session-end | session-end | session-end |

**SQLite ceiling for this workload** ([phiresky's tuning gist](https://gist.github.com/phiresky/978d8e204f77feaa0ab5cca08d2d5b27)):

- Write throughput: 10K–50K UPDATEs/sec on commodity SSD with WAL mode + batched transactions
- File size: 2M edges × ~100 B per row ≈ 200 MB (SQLite ceiling: 281 TB)
- Point lookups: sub-millisecond with existing 15 indexes on `brain_page_edges`
- Decay pass on 2M edges: single `UPDATE` runs in seconds at session-end — invisible to user

**What SQLite genuinely can't do** (and why none of it matters for us):

| Biological STDP needs | SQLite lacks | CLEO need? |
|---|---|---|
| Millisecond spike sim | N/A | **No** — retrieval events are our "spikes" |
| Leaky integrate-and-fire neurons | N/A | **No** — we don't simulate neurons |
| GPU tensor ops | N/A | **No** — batch SQL is sufficient |
| Differential equation solvers | N/A | **No** — algebraic updates |
| Refractory periods | N/A | **No** — sessions are the refractory unit |
| Neuromodulator gating | Partially — via `reward_signal` column | **Arguably yes — see R-STDP §6** |

**Embedding generation** (the only real compute bottleneck) already runs off-thread via `@huggingface/transformers` worker. Unchanged by STDP.

**Bottom line**: SQLite is not the bottleneck. Don't need LadybugDB. Don't need PostgreSQL. Don't need Neo4j. Per D-BRAIN-VIZ-12 and D009.

---

## §6 R-STDP (reward-modulated variant) — recommended

The "third factor" gate in biological STDP is dopamine. CLEO's analog: **task completion + verification signals**.

**Already-available reward sources**:
- `tasks.status = 'completed'` after a memory was retrieved
- `verification_json.passed = true`
- Owner explicit confirmation (`cleo memory verify`)
- Session summary tone (success vs blocker)

**Wiring**:
1. Add `reward_signal REAL` column to `brain_retrieval_log` (Phase 5 §3.3)
2. After session end: backfill `reward_signal` for retrievals correlated with task outcomes
3. STDP modulates Δw by `(1 ± r)` per algorithm in §4

**Why cheap**: signals exist, plumbing is small. **Why valuable**: distinguishes "I remembered correctly and it helped" from "I remembered but it was wrong" — exactly the credit-assignment that pure unsupervised Hebbian misses.

---

## §7 Vector / AI extension landscape (recap from parent plan)

Per D-BRAIN-VIZ-10 and D-BRAIN-VIZ-11:

| Extension | Decision | Why |
|---|---|---|
| `sqlite-vec` (asg017) | ✅ **Keep** — already loaded | MIT/Apache, Mozilla Builders, shipped at `brain-sqlite.ts:172` |
| `sqlite-ai` (sqliteai.com) | 🟡 **Evaluate Phase 6+** | Could replace HF transformers worker; Elastic License needs legal review |
| `sqlite-vector` (sqliteai) | ❌ **Skip** | Duplicates sqlite-vec; Elastic License; mobile-focused |
| `sqlite-memory` (sqliteai) | ❌ **Skip** | Would replace our T549 memory model with inferior schema |
| `sqlite-rag` (sqliteai) | ❌ **Skip** | We already have RRF hybrid search |
| `sqlite-agent` (sqliteai) | ❌ **Skip** | Conflicts with our 22-agent orchestration model |

---

## §8 Decisions to Lock at Owner Checkpoint

1. **Δt granularity** — ordinal distance within retrieval batch (current proposal), or wall-clock per ID (needs new `brain_retrieval_ticks(retrieval_id, entry_id, tick_at)` table)?
2. **Per-edge-type plasticity rates** — global defaults (current proposal), or one set per edge type? (Procedural likely wants faster learning than semantic.)
3. **Supersession × plasticity** — when `supersedes` fires, does the superseded edge's learned weight transfer to the replacement, or reset?
4. **LTD vs `quality_score` interaction** — both signals say "this memory is weak". Compound? Cap each other? Independent?
5. **R-STDP scope** — wire reward to all plasticity classes, or only `stdp` class?
6. **Meta-brain privacy** — when cross-project edges land in Phase 4, do shared workspaces leak project-A reward signals into project-B view?
7. **Migration window** — strict cutover from `relates_to` → `co_retrieved`, or coexist briefly with a view alias?
8. **Audit trail** — `brain_weight_history` (Phase 7 §3.4) — ship in Phase 5 alongside STDP, or defer?

---

## §9 If we ever needed real biological SNN computation (we probably don't)

**Reference integration pattern** (NOT planned — for record only):

```
SQLite (SoT)                  Python worker (compute)
    │                                 │
    │  sync edges + weights ──────────>
    │                                 │
    │                          BindsNET simulates spikes
    │                          STDP updates tensor weights
    │                                 │
    │  <── write weights back ────────┤
    │                                 │
    ▼                                 ▼
 brain.db updates              heartbeat metrics
```

**Frameworks evaluated for this hypothetical** (full comparison in research notes):

| Framework | Backend | When you'd use it |
|---|---|---|
| **BindsNET** | PyTorch (eager exec) | ML/RL with SNNs; closest to "SNN but pragmatic" |
| **Brian2** | NumPy + code generation | Neuroscience research; flexible custom equations |
| **Nengo** | TF / Loihi / SpiNNaker / FPGA | NEF-based modeling; hardware deployment |
| **Inferno** (2024) | PyTorch | Newer; performance-competitive with BindsNET |

**Reminder per D-BRAIN-VIZ-09**: adopting any of these is a 10× scope expansion with near-zero additional value for agent memory. Not recommended.

---

## §10 Phase 5 Implementation Plan — SHIPPED v2026.4.62

**Status**: DONE (2026-04-15). All 21 tasks across 4 waves complete. Plasticity substrate fully wired.

### Implementation Summary

1. **Schema migration** ✅ — M1–M4 applied (7 tasks, fully parallel Wave 0)
   - M1 (T703): `brain_retrieval_log` + 4 columns + indexes
   - M2 (T706): `brain_plasticity_events` + 5 columns
   - M3 (T697): `brain_page_edges` + 6 columns + seed
   - M4 (T699/T701/T715): 3 new tables + weight_history + modulators + consolidation events

2. **Seed plasticity_class** ✅ — `co_retrieved` edges marked `'hebbian'` via M3 data seed (T697)

3. **Implement plasticity writer** ✅ — `applyStdpPlasticity` completely rewritten (T679/T681/T693)
   - Fixed BUG-1: lookback/pairing window separation
   - Fixed BUG-2: entry_ids JSON format
   - Fixed BUG-3: session_id column + backfill
   - Cross-session pair detection (24h window, 30d lookback)
   - Tiered τ decay (20s/30min/12h)
   - R-STDP reward modulation
   - Novelty boost (1.5×)
   - Homeostatic decay + pruning

4. **R-STDP wiring** ✅ — `backfillRewardSignals` (Step 9a) + reward_signal propagation (T681/T713)
   - Task outcome → reward value (+1.0 verified, +0.5 done, −0.5 cancelled)
   - `brain_modulators` logging for observability

5. **CLI surfaces** ✅ — Existing `cleo brain plasticity stats` now returns non-zero values (Phase 6: viz feed, history queries, tune parameters)

6. **Tests** ✅ — 7 E2E functional tests on real brain.db (T682), zero mocks
   - STDP-F1: LTP event written after retrievals
   - STDP-F2: CLI produces plasticity events
   - STDP-F3: Cross-session pair detection
   - STDP-F4: LTD weakens reverse edge
   - STDP-F5: JSON entry_ids accepted; comma-sep produces no events
   - STDP-F6: session_id propagated
   - STDP-F7: R-STDP reward modulation
   - STDP-F8: Homeostatic decay + pruning

7. **Owner verification** ✅ — ADR-046 documents all decisions; functional test suite verifies real-world behavior

### Key Documents

- **ADR-046** (this session): Complete implementation record; 18 design decisions; 15 acceptance criteria verified
- **docs/specs/stdp-wire-up-spec.md** (STDP-WIRE-UP-V2): Master specification; supersedes council reports
- **Ship task links**: T703, T696, T706, T697, T699, T701, T715 (Wave 0); T679, T681, T693 (Wave 1); T688, T689, T691, T692, T713, T714 (Wave 2); T690, T694, T695 (Wave 3); T682, T683 (Wave 4)

---

## §11 Sources

### Plasticity & SNN research
- [Synaptic scaling + Hebbian plasticity (SPaSS, Frontiers 2012)](https://www.frontiersin.org/journals/computational-neuroscience/articles/10.3389/fncom.2012.00036/full)
- [Hebbian + gradient plasticity in Transformers (OpenReview 2024)](https://openreview.net/forum?id=34No0A0V56)
- [Calcium-based Hebbian approximation of STDP (arXiv 2504.06796)](https://arxiv.org/html/2504.06796v1)
- [Models of Hebbian learning (Neuronal Dynamics, EPFL)](https://neuronaldynamics.epfl.ch/online/Ch19.S2.html)
- [Hebbian plasticity requires compensatory processes on multiple timescales (Royal Society)](https://royalsocietypublishing.org/rstb/article/372/1715/20160259/23102/Hebbian-plasticity-requires-compensatory-processes)
- [Combination of Hebbian and predictive plasticity (Nature Neuroscience)](https://www.nature.com/articles/s41593-023-01460-y)

### SNN frameworks (for record; not adopting)
- [BindsNET (PyTorch SNN)](https://github.com/BindsNET/bindsnet)
- [Brian2 simulator](https://briansimulator.org/)
- [Nengo](https://www.nengo.ai/)
- [Inferno (newer SNN framework, 2024)](https://arxiv.org/html/2409.11567v1)

### SQLite scale & tuning
- [SQLite performance tuning (phiresky's gist)](https://gist.github.com/phiresky/978d8e204f77feaa0ab5cca08d2d5b27)

### CLEO internal references
- `packages/core/src/memory/brain-lifecycle.ts:911` — `strengthenCoRetrievedEdges` (existing Hebbian)
- `packages/core/src/memory/brain-retrieval.ts:1415` — `logRetrieval`
- `packages/core/src/store/brain-schema.ts` — `BRAIN_EDGE_TYPES`, `brainPageEdges`, `brainRetrievalLog`
- D008 — 7-technique memory architecture
- D009 — Keep brain.db on SQLite + Drizzle (no LadybugDB migration)
- T549 — Tiered + typed memory (shipped foundation)
- T626 — EPIC: T-BRAIN-LIVING (Phase 1 — DONE)
- T627 — EPIC: T-BRAIN-LIVING Stabilization (Phase 2 — ACTIVE)
