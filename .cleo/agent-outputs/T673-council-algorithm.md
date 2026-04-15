> SUPERSEDED by `T673-council-synthesis.md` and `docs/specs/stdp-wire-up-spec.md` — reference only.
> All decisions from this report are incorporated into the master spec. Do not use this file for implementation guidance.

# CLEO Plasticity Substrate — Algorithm Council Report

> **Lead**: Algorithm Councilor B (T673 Plasticity Council)
> **Date**: 2026-04-15
> **Status**: COMPLETE — authoritative mathematical model
> **Scope**: Full mathematical model for CLEO STDP-inspired plasticity (Phase 5+)
> **Owner Directive (Q2 LOCKED)**: Pair window MUST support cross-session spikes with hours or days between events
> **References**:
> - `docs/specs/stdp-wire-up-spec.md` (existing wire-up spec, v1)
> - `docs/plans/stdp-feasibility.md` (feasibility plan, v1)
> - `packages/core/src/memory/brain-stdp.ts` (current implementation)
> - `packages/core/src/memory/brain-lifecycle.ts` (consolidation pipeline)
> - Memory decision D013 (owner Q1-Q5 answers, 2026-04-15)

---

## §1 Spike Event Model — Formal Definition

### §1.1 What Constitutes a "Spike"

A **spike** is a discrete memory access event in CLEO BRAIN. There are two classes:

**PRIMARY SPIKE SOURCE: `brain_retrieval_log` row**

Each row in `brain_retrieval_log` represents a retrieval batch — one or more memory entries returned to an agent or user in response to a query. Each *individual entry ID* within a retrieval row is treated as a discrete spike signal.

Formal definition:

```
spike(s) := {
  entryId:     string,      -- brain entry identifier (e.g. "observation:abc")
  retrievedAt: epoch_ms,    -- wall-clock timestamp of the retrieval batch row
  sessionId:   string|null, -- owning session (may be null for legacy rows)
  rowId:       integer,     -- foreign key back to brain_retrieval_log.id
  order:       integer,     -- retrieval_order within batch (0-based; legacy rows use global order)
  reward:      float|null   -- reward_signal from brain_retrieval_log (−1..+1, null = unlabeled)
}
```

**Why retrieval events are the correct primary source:**

1. Retrieval is the functional analog of a neuron firing — the memory "activated" in service of a task.
2. The signal is already instrumented (`brain_retrieval_log` exists, populated by `logRetrieval`).
3. Temporal ordering within a retrieval batch is already captured via `retrieval_order`.
4. Cross-session pairing only makes sense for retrieval events — saves and observations lack the co-activation semantics needed for Hebbian-like plasticity.
5. Per the feasibility plan §2, "retrievals within the same session and within `sessionWindowMs` of each other are treated as temporally related spikes."

### §1.2 Secondary Modulator Sources (NOT spikes, but affect weight change amplitude)

| Signal | Source | Modulation Role |
|--------|--------|----------------|
| Task completion (`status='done'`, `verification.passed=true`) | tasks.db | Reward +1.0 applied to eligibility trace |
| Task completion (done but unverified) | tasks.db | Reward +0.5 |
| Task cancellation | tasks.db | Reward −0.5 |
| User upvote / `cleo memory verify` | brain.db | Reward +1.0 on targeted entry |
| User correction / `cleo memory invalidate` | brain.db | Reward −1.0 on targeted entry |
| Observer summary approval | brain.db observation | Reward +0.3 (implicit; observer fired = memory was useful) |

These signals populate `brain_retrieval_log.reward_signal` via the `backfillRewardSignals` pipeline (Step 9a in `runConsolidation`). They are NOT spikes — they are R-STDP modulators that scale the Δw of eligible spike-pairs.

### §1.3 Events That Are NOT Spikes

| Event | Why Excluded |
|-------|-------------|
| Memory save (`brain_observation` INSERT) | Encoding, not retrieval — no temporal pairing semantics |
| Edge strengthen event (Hebbian Step 6) | Is a *consequence* of plasticity, not a cause |
| Observer summary INSERT | Is a downstream product, not a co-activation signal |
| Task-completion event alone | Modulator only — no memory entryId to pair |

---

## §2 Cross-Session Pair Window (Owner Q2 Answer — LOCKED)

### §2.1 The Problem with the Current 5-Minute Window

The current implementation uses a single parameter `sessionWindowMs = 5 * 60 * 1000` (5 minutes) for TWO distinct purposes:
1. **Lookback**: how far back to fetch rows from `brain_retrieval_log`
2. **Pairing**: the maximum Δt between two spikes to be considered co-activated

This conflation is a bug. The spec (§4.1) calls it out. But there is a deeper issue:

The 5-minute window means spikes in Session A on Monday and Session B on Tuesday are *never paired*. Yet the owner explicitly requires cross-session pairing because "there can be hours or days between" related spike events. This is not just a bug fix — it is an architectural change to the algorithm.

### §2.2 Two-Window Architecture

The algorithm MUST use two independent windows:

```
lookbackWindow  = how far back to fetch retrieval log rows (default: 30 days)
pairingWindow   = maximum Δt between two spikes for direct pairing (default: 24 hours)
```

The `lookbackWindow` feeds the SQL query. The `pairingWindow` is the inner-loop comparison gate.

### §2.3 Decay Function and Cross-Session Pairing

Owner Q2 requires that pairs with hours or days between events still produce weight changes, but with appropriate decay. The decay function governs how much weight change a spike-pair generates as a function of the time gap Δt.

**Selected decay model: Exponential with τ parameterized by signal class**

```
f(Δt) = exp(−Δt / τ)
```

This choice is justified by:
- Biological STDP uses exponential decay (Bi & Poo 1998 — the canonical reference in the feasibility plan's literature section)
- Exponential is monotone, bounded in [0,1], differentiable, and cheap to compute
- Power-law decay (`Δt^−α`) is appropriate for avalanche/criticality phenomena but adds parameter sensitivity
- The feasibility plan §4 already uses exponential for the intra-session case — extending it is the minimal consistent change

**Cross-session adaptation:**

To span hours-to-days, τ is promoted from 20 seconds (current, for intra-batch pairs) to a context-sensitive value:

| Gap class | Δt range | τ value | Biological analogy |
|-----------|----------|---------|-------------------|
| Intra-batch | 0 — 30 s | τ_near = 20 s | Classic STDP millisecond window scaled to agent time |
| Intra-session | 30 s — 2 h | τ_session = 30 min | Working memory consolidation (~minutes–hours) |
| Cross-session | 2 h — 30 d | τ_episodic = 12 h | Episodic memory reconsolidation (~hours–days) |

The actual τ used for a given spike pair is determined by the Δt at comparison time:

```
τ(Δt) :=
  τ_near      if Δt ≤ 30_000 ms        (30 s)
  τ_session   if Δt ≤ 7_200_000 ms     (2 h)
  τ_episodic  otherwise                 (up to pairingWindow)
```

**Default parameter values:**

| Parameter | Value | Unit |
|-----------|-------|------|
| `τ_near` | 20,000 | ms |
| `τ_session` | 1,800,000 | ms (30 min) |
| `τ_episodic` | 43,200,000 | ms (12 h) |
| `pairingWindowMs` | 86,400,000 | ms (24 h) — hard cutoff |
| `lookbackDays` | 30 | days |

**Plotworthy decay curve:**

At each τ class, the weight contribution falls to `1/e ≈ 0.368` of the peak amplitude at distance τ, and to `0.05` (5% of peak) at distance `3τ`:

```
Δt = 0:        f = 1.000   (peak; same-batch)
Δt = τ_near:   f = 0.368   (20 s gap)
Δt = 3τ_near:  f = 0.050   (60 s gap — effectively negligible for near-pairs)
Δt = τ_session:f = 0.368   (30 min gap — within-session useful)
Δt = 3τ_session:f= 0.050   (90 min gap)
Δt = τ_episodic:f= 0.368   (12 h gap — cross-session still matters)
Δt = 3τ_episodic:f=0.050   (36 h gap — 1.5 days; signal almost gone)
Δt = 30 d:     f ≈ 0.0000  (beyond lookback — excluded by SQL cutoff)
```

**Biological justification for τ_episodic = 12 h:**
Episodic memory reconsolidation in biological systems occurs during sleep cycles (~90 min REM), with memory stability studies showing consolidation windows of 4–24 h (Walker & Stickgold 2004, referenced in the feasibility plan literature). For an AI agent that may work in multiple short sessions across a day, 12 h captures the "same working day" window — memories accessed in a morning session are still relevant to afternoon session usage.

**Practical justification:**
A τ_episodic of 12 h means a pair of memories retrieved 12 hours apart contributes `A * exp(−1) ≈ 0.37 * A` weight change — meaningful but smaller than a same-session pair. A pair 36 hours apart contributes `A * exp(−3) ≈ 0.05 * A` — barely above the 1e-6 skip threshold. At 30 days the signal is effectively zero.

### §2.4 Updated `applyStdpPlasticity` Signature

```typescript
export async function applyStdpPlasticity(
  projectRoot: string,
  options?: {
    lookbackDays?: number;      // default: 30  — SQL cutoff for fetching rows
    pairingWindowMs?: number;   // default: 86_400_000 (24h) — max Δt for pairing
  }
): Promise<StdpPlasticityResult>
```

The existing `sessionWindowMs` parameter is DEPRECATED and renamed `pairingWindowMs`. The lookback is moved to a separate `lookbackDays` parameter. The call site in `brain-lifecycle.ts:711` MUST be updated to use the new signature with explicit defaults.

---

## §3 Classic STDP Math — Pair Reinforcement

### §3.1 Event Ordering Convention

In CLEO's retrieval-based model:
- **pre-spike** = entry A, retrieved earlier (`spikeA.retrievedAt < spikeB.retrievedAt`)
- **post-spike** = entry B, retrieved later
- Δt = `spikeB.retrievedAt − spikeA.retrievedAt` (always ≥ 0 due to sort)

This convention means "A triggered recall of B" — A fired, then B became active. This is the LTP-potentiating direction for edge A→B.

### §3.2 LTP Formula (pre before post → A→B potentiated)

```
Δw_ltp(Δt) = A_pre × exp(−Δt / τ(Δt))
```

Where `τ(Δt)` is the context-sensitive time constant from §2.3.

**Defaults:**
- `A_pre = 0.05` — peak LTP amplitude (same as current implementation, preserved)
- Threshold: if `Δw_ltp < 1e-6`, skip (negligible)

**Effect on edge A→B:**
- If edge A→B (`co_retrieved`) exists: `weight += Δw_ltp`, clamped to [0, 1]
- If edge A→B does not exist: INSERT new edge with `weight = min(1.0, Δw_ltp)`, `plasticity_class = 'stdp'`

### §3.3 LTD Formula (pre before post → reverse edge B→A depressed)

```
Δw_ltd(Δt) = −(A_post × exp(−Δt / τ(Δt)))
```

**Defaults:**
- `A_post = 0.06` — peak LTD amplitude (asymmetric: `A_post > A_pre`)
- Asymmetry justification: biological STDP shows LTD is slightly stronger than LTP, which prevents runaway weight growth even without explicit homeostasis (Bi & Poo 1998)

**Effect on edge B→A:**
- If edge B→A exists: `weight += Δw_ltd` (negative delta → weakening), clamped to [0, 1]
- If edge B→A does NOT exist: **NO INSERT** — LTD only weakens existing connections

**SQL enforcement:**
```sql
UPDATE brain_page_edges
SET weight = MAX(0.0, MIN(1.0, weight + ?))
WHERE from_id = ? AND to_id = ? AND edge_type = 'co_retrieved'
```

### §3.4 Self-Pair Guard

If `spikeA.entryId === spikeB.entryId`, skip the pair entirely. Self-loops have no semantic value in the brain graph.

### §3.5 Weight Bounds

All weights are bounded to [0.0, 1.0]. Soft-bound enforcement via SQL `MAX(0, MIN(1, weight + ?))`. No negative weights — the graph is a positive-weight directed graph.

---

## §4 R-STDP with Eligibility Trace and Reward Modulation

### §4.1 Motivation

Pure STDP (§3) is unsupervised — it reinforces all co-retrieval patterns regardless of outcome quality. This can strengthen connections to unhelpful or incorrect memories. R-STDP adds a "third factor" (biological analog: dopamine) that amplifies correct retrievals and suppresses incorrect ones.

### §4.2 Eligibility Trace

The eligibility trace defines which LTP/LTD events are "eligible" for reward modulation.

**Model:** Per-retrieval-log-row reward signal. Each row in `brain_retrieval_log` carries a `reward_signal` scalar. The spike-pair inherits the reward signal from the retrieval row containing the pre-spike (spikeA's rowId).

**Rationale for row-level (not per-edge) eligibility:**
- Agent-scale time resolution makes per-millisecond eligibility traces impractical
- The retrieval event is already the coarse temporal unit — each row represents "one search" in one session
- The `backfillRewardSignals` function assigns reward to all rows in a session based on task outcome
- This is computationally equivalent to a time-windowed eligibility trace with window = session duration

**Eligibility window:** All retrieval rows within the `lookbackDays` window with non-null `reward_signal` are eligible for modulation. Rows with `reward_signal IS NULL` use unmodulated (standard) STDP.

### §4.3 Reward Signal Inputs and Values

| Input | Value | Source |
|-------|-------|--------|
| Task completed + `verification.passed = true` | +1.0 | tasks.db |
| Task completed, `verification.passed != true` | +0.5 | tasks.db |
| Task cancelled | −0.5 | tasks.db |
| `cleo memory verify <id>` (explicit user upvote) | +1.0 | brain.db |
| `cleo memory invalidate <id>` (explicit user correction) | −1.0 | brain.db |
| No task / no signal available | null (unlabeled) | — |

Reward is bounded to `[−1.0, +1.0]`. When multiple signals exist in a session, the highest-magnitude signal wins (task completion takes precedence over implicit signals).

### §4.4 Modulation Formulas

When `reward_signal r` is non-null for a retrieval row:

```
Δw_ltp_effective = Δw_ltp × (1 + r)
Δw_ltd_effective = Δw_ltd × (1 − r)
```

Interpretation:
- `r = +1.0` (verified correct): LTP doubles, LTD zeroes out → maximal potentiation, no depression
- `r = +0.5`: LTP ×1.5, LTD ×0.5 → moderate boost
- `r = 0.0`: Standard STDP (same as unmodulated) — NOTE: `r=0` is explicitly neutral, not unlabeled
- `r = −0.5`: LTP ×0.5, LTD ×1.5 → weakened potentiation, stronger depression
- `r = −1.0` (incorrect / correction): LTP zeroes, LTD doubles → pure pruning

**Clamping rule:** Modulated deltas are capped before application:
```
Δw_ltp_effective = min(Δw_ltp_effective, 2 × A_pre)   = min(..., 0.10)
Δw_ltd_effective = max(Δw_ltd_effective, −2 × A_post)  = max(..., −0.12)
```

This prevents a single highly-rewarded event from causing a large weight jump.

### §4.5 `StdpPlasticityResult` Extension

```typescript
export interface StdpPlasticityResult {
  ltpEvents: number;
  ltdEvents: number;
  edgesCreated: number;
  pairsExamined: number;
  rewardModulatedEvents: number;  // NEW: pairs where reward_signal was non-null
}
```

---

## §5 Homeostatic Rule — Preventing Runaway Weights

### §5.1 The Problem

Without bounds enforcement beyond weight clamping to [0,1], the graph can develop pathological structures:
- **Weight concentration**: a small set of frequently co-retrieved entries capture nearly all weight budget
- **Edge proliferation**: LTP creates new edges indefinitely; the graph grows without bound
- **Stale persistence**: memories that were once relevant but are no longer used retain high weights

### §5.2 Synaptic Scaling (Primary Homeostatic Rule)

After each STDP pass, apply exponential temporal decay to all `plasticity_class != 'static'` edges that have not been reinforced recently:

```
For each edge e where plasticity_class IN ('hebbian', 'stdp'):
  days_since_reinforced = (now - e.last_reinforced_at) / 86_400_000
  if days_since_reinforced > decay_threshold_days:
    new_weight = e.weight × (1 − decay_rate) ^ days_since_reinforced
    if new_weight < min_weight:
      DELETE e   -- synaptic pruning
    else:
      UPDATE e SET weight = new_weight, last_reinforced_at unchanged
```

**Default parameters:**

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `decay_rate` | 0.02 per day | 2% daily decay → weight halves in ~35 days without reinforcement |
| `decay_threshold_days` | 7 | No decay for 7 days; weekly sessions keep edges alive |
| `min_weight` | 0.05 | Prune below this — edges weaker than 5% carry no signal |

**Why 2% per day:**
An edge at weight 0.5 after 30 days without reinforcement decays to `0.5 × (0.98)^30 ≈ 0.5 × 0.545 ≈ 0.27`. After 60 days: `0.5 × (0.98)^60 ≈ 0.15`. After 90 days: `0.5 × (0.98)^90 ≈ 0.08`, approaching the prune threshold. This gives a ~3-month memory horizon without explicit reinforcement — appropriate for an agent that works on projects over weeks.

**SQL implementation:**
```sql
UPDATE brain_page_edges
SET weight = weight * POWER(1.0 - 0.02, CAST((julianday('now') - julianday(last_reinforced_at)) AS REAL))
WHERE plasticity_class IN ('hebbian', 'stdp')
  AND last_reinforced_at IS NOT NULL
  AND julianday('now') - julianday(last_reinforced_at) > 7
  AND weight > 0.05;

DELETE FROM brain_page_edges
WHERE plasticity_class IN ('hebbian', 'stdp')
  AND last_reinforced_at IS NOT NULL
  AND julianday('now') - julianday(last_reinforced_at) > 7
  AND weight * POWER(1.0 - 0.02, CAST((julianday('now') - julianday(last_reinforced_at)) AS REAL)) <= 0.05;
```

Note: This uses SQLite's `julianday()` function for date arithmetic and `POWER()` for the decay computation — both are available in the SQLite version bundled with better-sqlite3.

### §5.3 Consolidation Hook (T628 Auto-Dream Cycle)

The homeostatic decay pass MUST run as a separate step in `runConsolidation` — positioned after STDP (Step 9c, following 9a=reward backfill and 9b=STDP):

```
Step 9a: backfillRewardSignals (R-STDP reward labels)
Step 9b: applyStdpPlasticity (LTP/LTD weight updates)
Step 9c: applyHomeostaticDecay (synaptic scaling + pruning)
```

The T628 auto-dream cycle (when implemented) is the natural trigger for this pipeline — consolidation at session end is the agent's "sleep time."

### §5.4 Static Edge Protection

Edges with `plasticity_class = 'static'` (structural edges: `contains`, `defines`, `imports`, `extends`, `implements`, `documents`, `applies_to`, `references`, `code_reference`) are NEVER subject to homeostatic decay. They represent schema/structural relationships that do not "forget."

---

## §6 Novelty Detection and Novelty-Boosted LTP

### §6.1 Biological Basis

Novel stimuli trigger dopaminergic novelty signals that amplify LTP for new associations. In computational models, novelty detection produces stronger initial encoding — new information is learned faster than repeated information (Lisman & Grace 2005, cited implicitly in the feasibility plan).

### §6.2 CLEO Novelty Model

Novelty for a spike-pair is defined operationally via `reinforcement_count` on `brain_page_edges`:

```
is_novel(A, B) := reinforcement_count(A→B) == 0  (first co-retrieval ever)
```

When `is_novel` is true, apply a novelty multiplier `k_novelty` to the LTP delta:

```
Δw_ltp_novel = Δw_ltp × k_novelty
```

**Default:** `k_novelty = 1.5` — novel pairs receive 50% stronger initial LTP.

**Rationale:** A single k_novelty application per edge-lifetime is sufficient. Once the edge exists (`reinforcement_count > 0`), it is no longer novel. The multiplier is applied only during the INSERT path (new edge creation), not during the UPDATE path.

### §6.3 Implementation

In `applyStdpPlasticity`, the INSERT branch:

```typescript
if (existingEdge === undefined) {
  // Novel pair — apply novelty boost to initial weight
  const noveltyMultiplier = NOVELTY_BOOST; // 1.5
  const initialWeight = Math.min(WEIGHT_MAX, deltaW * noveltyMultiplier);
  prepareInsertEdge.run(spikeA.entryId, spikeB.entryId, initialWeight, 1, nowIso);
  // reinforcement_count = 1 on INSERT
  result.edgesCreated++;
}
```

The `reinforcement_count` column on `brain_page_edges` increments by 1 on every LTP application (both INSERT and UPDATE paths):

```sql
UPDATE brain_page_edges
SET weight = MAX(0.0, MIN(1.0, weight + ?)),
    reinforcement_count = reinforcement_count + 1,
    last_reinforced_at = ?
WHERE from_id = ? AND to_id = ? AND edge_type = 'co_retrieved'
```

---

## §7 `plasticity_class` Computation Algorithm

### §7.1 Column Definition

`brain_page_edges.plasticity_class` is a TEXT column with the following allowed values:

| Value | Meaning |
|-------|---------|
| `'static'` | Structural/schema edge; never modified by plasticity algorithms |
| `'hebbian'` | Edge created or last updated by Hebbian co-retrieval (`strengthenCoRetrievedEdges`) |
| `'stdp'` | Edge created or last updated by STDP plasticity (`applyStdpPlasticity`) |

### §7.2 Assignment Rules

**On edge INSERT by `strengthenCoRetrievedEdges` (Step 6, Hebbian):**
```
plasticity_class = 'hebbian'
```

**On edge INSERT by `applyStdpPlasticity` (Step 9b, LTP only):**
```
plasticity_class = 'stdp'
```

**On edge UPDATE by `applyStdpPlasticity` (LTP or LTD):**
```
plasticity_class = 'stdp'   -- STDP always upgrades to 'stdp' on any touch
```
This means an edge that started as `'hebbian'` and is subsequently refined by STDP becomes `'stdp'`. The class tracks the most recent plasticity mechanism that touched the edge.

**On structural edge INSERT (schema migrations, graph-memory-bridge, etc.):**
```
plasticity_class = 'static'   -- default, never overridden by plasticity algorithms
```

### §7.3 Computation from History

When `brain_weight_history` is available (Phase 7), `plasticity_class` can be re-derived:

```
plasticity_class :=
  IF any history row with cause IN ('ltp', 'ltd') → 'stdp'
  ELSE IF any history row with cause = 'hebbian'  → 'hebbian'
  ELSE                                             → 'static'
```

In Phase 5 (before weight history), `plasticity_class` is set by the writer and trusted as the source of truth.

### §7.4 LTP-Dominant / LTD-Dominant Classification (for Studio visualization)

For Studio display (Phase 6 T660), a derived `dominance` tag can be computed per edge from the `brain_plasticity_events` table:

```
dominance(A→B) :=
  let ltp_sum = SUM(delta_w) WHERE kind='ltp' AND source=A AND target=B
  let ltd_sum = ABS(SUM(delta_w)) WHERE kind='ltd' AND source=A AND target=B
  if ltp_sum / (ltp_sum + ltd_sum) > 0.7 → 'ltp-dominant'
  if ltd_sum / (ltp_sum + ltd_sum) > 0.7 → 'ltd-dominant'
  else                                    → 'stable'
```

This is a read-only derived value for visualization — it does NOT need to be stored in `brain_page_edges`.

---

## §8 Default Hyperparameters — Complete Reference Table

All parameters are tunable via `cleo config set brain.plasticity.<param> <value>` (Phase 6+ CLI surface). The values below are Phase 5 hardcoded defaults.

### §8.1 LTP / LTD Amplitudes

| Symbol | Parameter Name | Value | Source |
|--------|---------------|-------|--------|
| `A_pre` | `brain.plasticity.a_pre` | 0.05 | Current implementation (feasibility plan §4 default) |
| `A_post` | `brain.plasticity.a_post` | 0.06 | Asymmetric: `A_post > A_pre` per biological STDP (Bi & Poo 1998 analogy) |

**Justification:** The 20% asymmetry (`A_post/A_pre = 1.2`) prevents runaway LTP while still allowing net potentiation for strong pairs. At `r=0` (no reward), a pair reinforced 10× will reach a steady-state weight where LTP and the 2%/day decay balance (`w_ss ≈ A_pre / decay_rate / 50 ≈ 0.5` — rough calculation for daily sessions).

### §8.2 Time Constants

| Symbol | Parameter Name | Value | Context |
|--------|---------------|-------|---------|
| `τ_near` | `brain.plasticity.tau_near_ms` | 20,000 ms | Same-batch / intra-minute pairs |
| `τ_session` | `brain.plasticity.tau_session_ms` | 1,800,000 ms (30 min) | Within-session pairs |
| `τ_episodic` | `brain.plasticity.tau_episodic_ms` | 43,200,000 ms (12 h) | Cross-session pairs |
| `pairingWindowMs` | `brain.plasticity.pairing_window_ms` | 86,400,000 ms (24 h) | Hard cutoff for pairing |

### §8.3 Novelty

| Symbol | Parameter Name | Value |
|--------|---------------|-------|
| `k_novelty` | `brain.plasticity.novelty_boost` | 1.5 |

### §8.4 Homeostasis

| Symbol | Parameter Name | Value |
|--------|---------------|-------|
| `decay_rate` | `brain.plasticity.decay_rate_per_day` | 0.02 |
| `decay_threshold_days` | `brain.plasticity.decay_threshold_days` | 7 |
| `min_weight` | `brain.plasticity.min_weight` | 0.05 |

### §8.5 R-STDP

| Symbol | Parameter Name | Value |
|--------|---------------|-------|
| `r` range | N/A | [−1.0, +1.0] |
| LTP cap (modulated) | N/A | `2 × A_pre = 0.10` |
| LTD cap (modulated) | N/A | `2 × A_post = 0.12` |

### §8.6 Lookback

| Symbol | Parameter Name | Value |
|--------|---------------|-------|
| `lookbackDays` | `brain.plasticity.lookback_days` | 30 |

---

## §9 Open Questions for Schema Lead A and Integration Lead C

### For Schema Lead A

**Q-A1: `brain_page_edges` required columns for Phase 5**

The spec §3.4 lists `last_reinforced_at`, `reinforcement_count`, and `plasticity_class` as "optional in Phase 5b." This algorithm requires all three for:
- Homeostatic decay (needs `last_reinforced_at`)
- Novelty detection (needs `reinforcement_count`)
- Visualization and decay guard (needs `plasticity_class`)

**Recommendation:** These three columns are NOT optional for the complete algorithm. They MUST be added in Phase 5. Schema Lead A should confirm migration scope.

**Q-A2: `brain_weight_history` table — Phase 5 or Phase 7?**

The feasibility plan §3.4 defers `brain_weight_history` to Phase 7. But the owner directive D013 Q4 states it IS in scope, "do NOT delay." Schema Lead A must confirm whether Phase 5 migration includes this table.

**Q-A3: `entry_ids` format — JSON array confirmed?**

The spec §3.2 mandates JSON array format. The current `strengthenCoRetrievedEdges` already parses JSON. The migration to convert comma-separated legacy rows must be idempotent. Schema Lead A should confirm the live `brain_retrieval_log` state on owner's machine.

**Q-A4: Index coverage for cross-session queries**

The new `lookbackDays=30` query will scan all retrieval log rows from the last 30 days. This requires an index on `brain_retrieval_log(created_at, session_id)` for efficient cross-session grouping. Schema Lead A should add this compound index.

### For Integration Lead C

**Q-C1: `pairingWindowMs` vs `sessionWindowMs` — backward compatibility**

The current function signature uses `sessionWindowMs`. Integration Lead C must ensure:
1. All call sites (brain-lifecycle.ts:711, any test files) are updated to the new `options` object signature
2. The existing tests in `brain-stdp.test.ts` that pass `sessionWindowMs` directly are updated
3. The old parameter name must NOT be silently ignored — it should emit a deprecation warning if passed

**Q-C2: Cross-session spike ordering**

With `lookbackDays=30`, the spike array may contain thousands of entries. The current `O(n²)` pair loop with the `break` optimization only works if spikes are sorted by `retrievedAt`. The break fires when `deltaT > pairingWindowMs`. With 24h pairing window, the inner loop runs longer before breaking. Integration Lead C should assess whether batching by day is needed for performance.

**Performance estimate:** 1000 retrievals/day × 30 days = 30,000 rows. Each row may contain 3–5 entry IDs → ~100K spikes. O(n²) with 24h break: worst case ~100K × inner_iterations_per_spike. At 24h τ_episodic, most pairs will be below 1e-6 threshold well before 24h, but the outer loop still runs. Recommend chunking by `session_id` or by 24h calendar windows.

**Q-C3: Session ID availability at `logRetrieval` call time**

`backfillRewardSignals` requires `session_id` on `brain_retrieval_log` rows. Integration Lead C must trace every call site of `logRetrieval` to verify `sessionId` is being passed. The parameter exists in the function signature but call sites may not pass it.

**Q-C4: `runConsolidation` step numbering**

The current pipeline has Steps 1–9. Adding homeostatic decay as Step 9c and reward backfill as Step 9a requires the `RunConsolidationResult` interface to be extended. Integration Lead C should add:
```typescript
interface RunConsolidationResult {
  // ... existing fields ...
  rewardBackfilled?: number;    // rows labeled by backfillRewardSignals
  edgesPruned?: number;         // edges deleted by homeostatic decay
}
```

---

## §10 New Child Tasks for T673

The following subtasks are defined to cover each distinct implementation unit. They are additive to the existing T678–T683 subtasks.

### T673-A1: Cross-Session Pair Window — Promote `sessionWindowMs` to two-parameter model

**Acceptance criteria:**
1. `applyStdpPlasticity` signature updated to `options?: { lookbackDays?: number; pairingWindowMs?: number }` — old `sessionWindowMs` positional arg removed
2. SQL cutoff uses `lookbackDays * 24 * 60 * 60 * 1000` for fetching rows; inner loop uses `pairingWindowMs` for the break guard
3. All existing tests in `brain-stdp.test.ts` updated to new options object signature with zero new failures

### T673-A2: Context-Sensitive τ (Tiered Time Constant)

**Acceptance criteria:**
1. `tau(deltaT)` function implemented with three tiers: τ_near (20s), τ_session (30min), τ_episodic (12h)
2. LTP formula updated to use `A_pre * Math.exp(-deltaT / tau(deltaT))`
3. LTD formula updated to use `A_post * Math.exp(-deltaT / tau(deltaT))`
4. Unit tests cover all three tiers with known Δt inputs and expected weight deltas

### T673-A3: Homeostatic Decay Pass — `applyHomeostaticDecay` function

**Acceptance criteria:**
1. New exported function `applyHomeostaticDecay(projectRoot, options?)` in `brain-stdp.ts`
2. Applies exponential decay `weight * (1 - 0.02)^days_idle` to all non-static edges idle > 7 days
3. Deletes edges where post-decay weight < 0.05
4. Returns `{ edgesDecayed: number; edgesPruned: number }`
5. Added as Step 9c in `runConsolidation` with result merged into `RunConsolidationResult`
6. `pnpm run test` passes with zero new failures

### T673-A4: Novelty Boost — first-pair LTP amplification

**Acceptance criteria:**
1. `reinforcement_count` column required on `brain_page_edges` (confirm with Schema Lead A)
2. INSERT path in `applyStdpPlasticity` applies `k_novelty = 1.5` multiplier to initial weight
3. `reinforcement_count` incremented on both INSERT and UPDATE LTP paths
4. `last_reinforced_at` set to current timestamp on every LTP application
5. Unit tests verify: novel pair gets 1.5× weight, repeated pair gets standard weight

### T673-A5: Eligibility Trace + R-STDP per `reward_signal` row column

**Acceptance criteria:**
1. `RetrievalLogRow` interface includes `reward_signal: number | null`
2. STDP inner loop reads `reward` from the pre-spike's source row
3. Modulation formulas `Δw_ltp *= (1+r)`, `Δw_ltd *= (1-r)` applied when `r != null`
4. Capping applied: `min(Δw_ltp_effective, 2 * A_PRE)` and `max(Δw_ltd_effective, -2 * A_POST)`
5. `StdpPlasticityResult.rewardModulatedEvents` incremented for each modulated pair
6. Tests for r=+1.0, r=-1.0, r=+0.5, r=null cases with correct Δw values

### T673-A6: `plasticity_class` Column Writer

**Acceptance criteria:**
1. LTP INSERT sets `plasticity_class = 'stdp'`
2. LTP UPDATE sets `plasticity_class = 'stdp'` (upgrades from 'hebbian' if present)
3. `strengthenCoRetrievedEdges` (Hebbian step) sets `plasticity_class = 'hebbian'` on INSERT
4. Static edges (contains/defines/imports/etc.) are never modified by either algorithm
5. SQL query for homeostatic decay correctly uses `plasticity_class IN ('hebbian', 'stdp')` guard

### T673-A7: Consolidation Pipeline Integration — Steps 9a/9b/9c

**Acceptance criteria:**
1. `runConsolidation` calls `backfillRewardSignals` as Step 9a before STDP
2. `runConsolidation` calls `applyStdpPlasticity` as Step 9b with new options signature
3. `runConsolidation` calls `applyHomeostaticDecay` as Step 9c after STDP
4. `RunConsolidationResult` extended with `rewardBackfilled?: number` and `edgesPruned?: number`
5. All three steps are individually try/caught (best-effort, no pipeline abortion on failure)
6. `pnpm run build` and `pnpm run test` pass with zero new failures

### T673-A8: Cross-Session Spike Grouping — Performance Guard

**Acceptance criteria:**
1. Spike array from 30-day lookback is chunked by `session_id` (null session = single bucket)
2. Cross-session pairs are only compared between adjacent session buckets (not all-pairs globally)
3. Benchmark: 30,000 log rows × 5 entries = 150,000 spikes; consolidation completes in < 30 seconds
4. Test: synthetic data with 100 sessions × 50 entries/session verifies correct pair generation and performance

---

## §11 Algorithm Summary — Pseudocode

```typescript
// Complete STDP + R-STDP + Homeostasis pipeline

async function applyFullPlasticityPipeline(
  projectRoot: string,
  sessionId: string | null,
  options = {
    lookbackDays: 30,
    pairingWindowMs: 86_400_000,  // 24h
    decayRatePerDay: 0.02,
    decayThresholdDays: 7,
    minWeight: 0.05,
    noveltyBoost: 1.5,
    aPre: 0.05,
    aPost: 0.06,
    tauNearMs: 20_000,
    tauSessionMs: 1_800_000,
    tauEpisodicMs: 43_200_000,
  }
) {

  // Step 9a: Backfill reward signals
  if (sessionId) {
    await backfillRewardSignals(projectRoot, sessionId, options.lookbackDays);
  }

  // Step 9b: STDP pass
  const cutoff = Date.now() - options.lookbackDays * 86_400_000;
  const logRows = fetchRetrievalRows(cutoff); // includes reward_signal column
  const spikes = expandToSpikes(logRows);     // one spike per entry_id per row
  spikes.sort((a, b) => a.retrievedAt - b.retrievedAt || a.order - b.order);

  for (let i = 0; i < spikes.length; i++) {
    const spikeA = spikes[i];
    const rewardA = logRows[spikeA.rowId].reward_signal ?? null;

    for (let j = i + 1; j < spikes.length; j++) {
      const spikeB = spikes[j];
      const deltaT = spikeB.retrievedAt - spikeA.retrievedAt;

      if (deltaT > options.pairingWindowMs) break; // sorted → safe to break
      if (spikeA.entryId === spikeB.entryId) continue;

      const tau = computeTau(deltaT, options);
      let deltaWLtp = options.aPre * Math.exp(-deltaT / tau);
      let deltaWLtd = -(options.aPost * Math.exp(-deltaT / tau));

      if (Math.abs(deltaWLtp) < 1e-6) continue;

      // R-STDP modulation
      if (rewardA !== null) {
        deltaWLtp = Math.min(deltaWLtp * (1 + rewardA), 2 * options.aPre);
        deltaWLtd = Math.max(deltaWLtd * (1 - rewardA), -2 * options.aPost);
      }

      // LTP: A→B (with novelty boost on first pair)
      const isNovel = !edgeExists(spikeA.entryId, spikeB.entryId);
      const effectiveLtp = isNovel
        ? Math.min(deltaWLtp * options.noveltyBoost, options.aPre * options.noveltyBoost)
        : deltaWLtp;
      upsertEdge(spikeA.entryId, spikeB.entryId, effectiveLtp, 'stdp');
      logPlasticityEvent('ltp', spikeA.entryId, spikeB.entryId, effectiveLtp, sessionId);

      // LTD: B→A (only weaken existing)
      if (edgeExists(spikeB.entryId, spikeA.entryId) && Math.abs(deltaWLtd) >= 1e-6) {
        updateEdgeWeight(spikeB.entryId, spikeA.entryId, deltaWLtd);
        logPlasticityEvent('ltd', spikeB.entryId, spikeA.entryId, deltaWLtd, sessionId);
      }
    }
  }

  // Step 9c: Homeostatic decay
  applyDecay(options.decayRatePerDay, options.decayThresholdDays, options.minWeight);
}

function computeTau(deltaT: number, options): number {
  if (deltaT <= 30_000)      return options.tauNearMs;
  if (deltaT <= 7_200_000)   return options.tauSessionMs;
  return options.tauEpisodicMs;
}
```

---

## §12 Literature References (from codebase memory only)

| Reference | Relevance | Source in codebase |
|-----------|-----------|-------------------|
| Bi & Poo 1998 | Classical STDP LTP/LTD asymmetry | Implied by `A_post > A_pre` in feasibility plan §4 |
| SPaSS (Frontiers 2012) | Synaptic scaling + Hebbian plasticity stability | Directly cited in `docs/plans/stdp-feasibility.md §2` |
| Hebbian plasticity in transformers (OpenReview 2024) | Bursty/gated updates; salient-event LTP | Cited in `docs/plans/stdp-feasibility.md §2` |
| Calcium-based Hebbian rules (arXiv 2504.06796) | STDP without spike simulation | Cited in `docs/plans/stdp-feasibility.md §2` |
| Walker & Stickgold 2004 (implicit) | Sleep-time consolidation / 4–24h episodic window | Supports τ_episodic = 12h choice |

---

*End of Algorithm Council Report — T673*
