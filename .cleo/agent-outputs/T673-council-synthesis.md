# T673 Plasticity Council — Synthesis Lead Report

**Session**: ses_20260415172452_9cf242
**Date**: 2026-04-15
**Author**: cleo-subagent Synthesis Lead
**Task**: T673 (STDP Phase 5 Wire-up, parent T627)
**Status**: COMPLETE

**Inputs synthesized**:
- Lead A: `T673-council-schema.md`
- Lead B: `T673-council-algorithm.md`
- Lead C: `T673-council-integration.md`
- Base: `T673-stdp-rcasd-plan.md`

**Output**: `docs/specs/stdp-wire-up-spec.md` (completely rewritten, V2)

---

## §1 Decision Matrix

Every design choice across all three councils, with the final unified ruling:

| # | Decision | Lead A | Lead B | Lead C | **Final Ruling** | Owner Touch? |
|---|----------|--------|--------|--------|-----------------|--------------|
| 1 | `entry_ids` format | Option B (JSON) Phase 5; Option C (junction) Phase 6 | Confirmed JSON (already calls JSON.parse) | Confirmed idempotent migration approach | **Option B now, Option C → T709** | No |
| 2 | Lookback vs pairing window | Separate (30d lookback, 5min pair) as base | Separate (30d lookback, 24h pair — expanded) | Confirmed separation needed | **30d lookback, 24h pairingWindowMs** | No |
| 3 | Tiered τ | Not in scope (schema only) | τ_near=20s, τ_session=30min, τ_episodic=12h | Not in scope (integration only) | **Three-tier τ as per Lead B** | No |
| 4 | `brain_weight_history` scope | Phase 5 (elevated from Phase 7 per owner D013) | Phase 5 (confirmed) | Noted as needed | **IN SCOPE for T673** | No — resolved |
| 5 | Writer hook location | Not in scope | Session-end consolidation Step 9 | Session-end Step 9 (confirmed) | **Session-end batch, already wired** | No |
| 6 | Observer ordering | Not in scope | Not in scope | Plasticity (priority 5) BEFORE reflector (priority 4) | **Consolidation before reflector** | No |
| 7 | `session_id` backfill for 38 rows | Not in scope | Not in scope | Option (b): date-bucketing synthetic IDs | **Date-bucketing `ses_backfill_YYYY-MM-DD`** | No |
| 8 | R-STDP reward values | D-BRAIN-VIZ-13: +1.0/+0.5/-0.5 | Same + explicit neutral (0.0) | Same | **+1.0/+0.5/null/-0.5/-1.0** | No |
| 9 | T628 integration | Not in scope | Not in scope | Plasticity IS part of dream cycle; T628 scope must expand | **T628 expansion required** | No — Lead C resolved it |
| 10 | Functional test time strategy | Not in scope | Not in scope | Real SQLite timestamps, no sleep | **SQL datetime expressions** | No |
| 11 | Decay events in weight_history | Not written (too voluminous) per Lead A Q-A1 | Not written (Lead B §5 open questions) | Not in scope | **Decay NOT written to history; only LTP/LTD/prune/hebbian** | No — aligned |
| 12 | `plasticity_class` upgrade | On first STDP touch (any UPDATE) | On first STDP touch — always 'stdp' on UPDATE | Not in scope | **STDP always upgrades to 'stdp' on UPDATE** | No |
| 13 | `stability_score` formula | `tanh(rc/10) × exp(-(days/30))` | Validated this formula | Not in scope | **Adopted as specified** | No |
| 14 | `delta_t_ms` source | Δt between retrieval rows | Δt between retrieval rows | Not in scope | **Δt between retrieval ROWS** | No |
| 15 | Cross-transaction pattern for backfill | Two separate connections | Not in scope | Two separate connections per cross-db-cleanup.ts | **Two separate connections (no ATTACH)** | No |
| 16 | `brain_consolidation_events` trigger param | trigger='session_end' etc. | Not in scope | runConsolidation logs every run | **trigger param added, row per run** | No |
| 17 | `brain_weight_history` retention | 90 days rolling | Not in scope | Not in scope | **90 days rolling** | Owner may tune via config in Phase 6+ |
| 18 | Idempotency guard for plasticity events | Not in scope | Not in scope | 1-hour dedup window per pair+session | **Dedup window before INSERT** | No |

---

## §2 Contradictions Found and Resolved

### §2.1 τ_near=20s Window vs Session-End-Only Writer

**Conflict**: Lead B defines τ_near=20s (same-batch spikes, 0–30s apart). Lead C's writer
fires ONLY at session-end. Sessions may last hours. How does a 20-second-apart pair get
captured at session-end batch processing?

**Resolution**: No conflict. τ_near is the decay constant for the Δw calculation, not a
window that limits which pairs are processed. All pairs within `pairingWindowMs` (24h) are
processed at session-end. A pair 20 seconds apart at retrieval time still exists in the
`brain_retrieval_log` rows at session-end, with their original `created_at` timestamps.
The algorithm recomputes Δt from those timestamps and applies τ_near. The session-end writer
correctly processes all historical pairs, including sub-minute ones.

**Spec location**: §3 Algorithm (τ function) + §4.1 Writer Hook.

### §2.2 entry_ids and session_id Backfill for 38 Historical Rows

**Conflict**: Lead A specified the `entry_ids` JSON migration and `session_id` date-bucketing
as part of M1. Lead C also specified `session_id` backfill as a separate STDP-I5 integration
task. These would be duplicate work.

**Resolution**: Both operations are consolidated into M1 migration (Lead A's migration file).
The new task T715 (STDP-I5) is scoped as a migration task — it IS the M1 task scoped
specifically for the backfill SQL. T703 (T673-S5 — Migration M1) is the parent container;
T715 adds the backfill SQL requirement explicitly so it isn't missed during T703 implementation.
They are sequential subtasks of the same migration, not duplicates.

### §2.3 T679 (W2 Writer Fix) vs T688 (A1 Cross-Session Window)

**Apparent conflict**: T679 fixes `lookbackDays` separation (30d vs 5min). T688 extends to
`pairingWindowMs=24h` with a renamed parameter. Both touch `applyStdpPlasticity` signature.

**Resolution**: These are sequential, not parallel. T679 is the immediate bug fix (BUG-1):
separate lookback from pair window, default pairWindow stays at 5min. T688 then extends
pairWindow to 24h and renames `sessionWindowMs` → `pairingWindowMs`. The dependency chain is:
T703 (M1 migration) → T679 (writer fix) → T688 (cross-session extension). Both tasks should
remain. The master spec documents the final state (24h default) as the target; workers know
T679 is the stepping stone and T688 is the completion.

**Worker instruction**: T679 implementors SHOULD use the `options` object signature from the
start (per the spec §3.2) to avoid a second signature migration in T688. If they do, T688
becomes smaller (only changes the default value and adds the τ-tier computation).

### §2.4 `brain_plasticity_events.session_id` — Drizzle vs INSERT

**Conflict**: Lead A confirmed `session_id` is already in the Drizzle schema at `:761` but the
INSERT at `brain-stdp.ts:277` doesn't include it. Lead C noted this is "purely in the INSERT
statement." But Lead A also noted the column may not be in the LIVE table (different from the
Drizzle declaration).

**Resolution**: Two separate fixes required:
1. M1 migration adds `session_id` to the live `brain_retrieval_log` table (not `brain_plasticity_events` — that already has it in Drizzle but NOT in live DDL)
2. T679 writer fix updates the INSERT in `brain-stdp.ts:277` to include `session_id`

The Drizzle schema already has `session_id` on `brain_plasticity_events` — the gap is only
the INSERT statement omitting it. The column exists in the live table for `brain_plasticity_events`
(confirmed RCASD §R1) but NOT in `brain_retrieval_log` (confirmed RCASD §R1).

### §2.5 Lead A's `brain_consolidation_events` → Lead C Integration

**Gap**: Lead A proposed `brain_consolidation_events` in §1.7 but Lead C's integration section
(§2 observer ordering, §4 T628) did not reference it. The integration spec would be incomplete
without wiring `runConsolidation` to log into this table.

**Resolution**: Added explicitly to master spec §4.2 as Step 9e, and as the requirement that
`runConsolidation` accepts a `trigger` parameter and inserts one row per run. Task T701 covers
this. No new task needed — T701 already has this scope.

### §2.6 Schema Drift in Lead A Not Mentioned by Lead C

**Gap**: Lead A found that `retrieval_order` and `delta_ms` exist in the live table via
self-healing DDL but are NOT in the Drizzle schema. Lead C's migration sequence discussion
did not mention bringing the Drizzle schema in sync for these two columns.

**Resolution**: Master spec §2.1.1 explicitly includes both columns in the Drizzle addition
block for `brain_retrieval_log`. T703 (Migration M1) acceptance criteria MUST include a check
that the Drizzle schema now matches the live table exactly.

---

## §3 Duplicate Task Cancellations

| Cancelled | Duplicate Of | Reason |
|-----------|-------------|--------|
| T678 (STDP-W1) | T703 (T673-S5) | T678 = Add session_id + reward_signal + fix entry_ids. T703 = Migration M1 (superset: also includes Drizzle schema sync for retrieval_order/delta_ms, compound index, session_id backfill SQL). T703 was created by Lead A with complete scope; T678 from RCASD plan was the initial narrower version. **T678 already cancelled.** |
| T680 (STDP-W3) | T692 (STDP-A5) | T680 = R-STDP modulation formula in applyStdpPlasticity. T692 = R-STDP eligibility + modulation (superset: includes RetrievalLogRow interface update, per-spike reward extraction, capping formulas, rewardModulatedEvents counter, and 4 test cases). T692 from Algorithm Lead B is complete; T680 from RCASD plan was the initial narrower version. **T680 already cancelled.** |

**Total cancellations**: 2 (both were pre-cancelled before synthesis confirmed the decision).

---

## §4 New Tasks Added by Synthesis

The following tasks were identified as gaps not covered by any of the three councils:

| ID | Title | Gap Found |
|----|-------|-----------|
| T713 | STDP-I1: Idempotency guard | Lead C flagged as STDP-I1 but it wasn't yet created |
| T714 | STDP-I2: Minimum-pair gate | Lead C flagged as STDP-I2 but it wasn't yet created |
| T715 | STDP-I5: session_id backfill migration | Lead C flagged as STDP-I5 but it wasn't yet created |

Notes:
- Lead C STDP-I3 (plasticity events CLI command) is covered by existing tasks. T679+T688 implement the writer; the `cleo brain plasticity events` CLI command is in scope for T683 (ADR + CLI expansion) or can be added as a new task if T683 is too narrow.
- Lead C STDP-I4 (apply manual trigger CLI) is explicitly in the spec §4.6.2 — add to T683 or create a new task.
- Lead C STDP-I6 (Studio plasticity feed) is Phase 6, noted in spec §4.7 but not a T673 subtask.

---

## §5 Unified Task Tree

### §5.1 Complete Child Task List

| ID | Title | Priority | Size | Status | Wave |
|----|-------|----------|------|--------|------|
| **CANCELLED** | | | | | |
| T678 | STDP-W1: Migration (superseded by T703) | medium | small | cancelled | N/A |
| T680 | STDP-W3: R-STDP math (superseded by T692) | medium | medium | cancelled | N/A |
| **WAVE 0 — Foundation (no deps)** | | | | | |
| T703 | T673-S5: Migration M1 — brain_retrieval_log columns | critical | small | pending | 0 |
| T696 | T673-S1: Migration M2 — brain_plasticity_events expand | critical | small | pending | 0 |
| T706 | T673-S6: Migration M3 — brain_page_edges plasticity columns | critical | small | pending | 0 |
| T697 | T673-S2: Migration M4 — brain_weight_history CREATE | critical | medium | pending | 0 |
| T699 | T673-S3: Migration M4 — brain_modulators CREATE | high | small | pending | 0 |
| T701 | T673-S4: Migration M4 — brain_consolidation_events CREATE | high | small | pending | 0 |
| T715 | STDP-I5: session_id backfill SQL in M1 | critical | small | pending | 0 |
| **WAVE 1 — Core Writer Fixes (depends on Wave 0 migrations)** | | | | | |
| T679 | STDP-W2: Fix applyStdpPlasticity lookback + session_id INSERT | medium | medium | pending | 1 |
| T681 | STDP-W4: backfillRewardSignals function + Step 9a wiring | medium | medium | pending | 1 |
| T693 | STDP-A6: plasticity_class column writer | medium | small | pending | 1 |
| **WAVE 2 — Algorithm Extensions (depends on Wave 1)** | | | | | |
| T688 | STDP-A1: Cross-session pair window — pairingWindowMs 24h | medium | medium | pending | 2 |
| T689 | STDP-A2: Tiered τ (near/session/episodic) | medium | medium | pending | 2 |
| T692 | STDP-A5: R-STDP reward modulation + eligibility | medium | medium | pending | 2 |
| T691 | STDP-A4: Novelty boost (k_novelty=1.5 on INSERT) | medium | small | pending | 2 |
| T713 | STDP-I1: Idempotency guard for plasticity events INSERT | high | small | pending | 2 |
| T714 | STDP-I2: Minimum-pair gate in runConsolidation | high | small | pending | 2 |
| **WAVE 3 — Homeostasis + Pipeline (depends on Wave 2)** | | | | | |
| T690 | STDP-A3: Homeostatic decay pass — applyHomeostaticDecay Step 9c | medium | medium | pending | 3 |
| T694 | STDP-A7: Consolidation pipeline integration Steps 9a/9b/9c | medium | medium | pending | 3 |
| T695 | STDP-A8: Cross-session spike grouping — session-bucket O(n²) guard | medium | medium | pending | 3 |
| **WAVE 4 — Testing + Documentation (depends on Waves 1-3)** | | | | | |
| T682 | STDP-W5: Functional test — real brain.db, no mocks | medium | medium | pending | 4 |
| T683 | STDP-W6: ADR + plan doc + CHANGELOG | medium | small | pending | 4 |
| **FUTURE (not T673 scope)** | | | | | |
| T709 | T673-S7: Phase 6 — brain_retrieval_entries junction table (Option C) | low | medium | pending | future |

**Total active tasks**: 21 (2 cancelled, 1 future)

### §5.2 Dependency Graph

```
Wave 0: T703 → Wave 1 (M1 data fixes needed before writer fix)
Wave 0: T696 → Wave 1 (M2 adds columns that writer populates)
Wave 0: T706 → Wave 1 (M3 adds plasticity_class column)
Wave 0: T697 + T699 + T701 → Wave 1 (M4 tables needed for writer to log history/modulators)
Wave 0: T715 → Wave 1 (session_id on existing rows needed for backfill function)

Wave 1: T679 + T681 + T693 → Wave 2 (signature change and session_id fix first)
Wave 1: T679 → T688 (A1 extends W2's signature change)

Wave 2: T688 + T689 + T692 + T691 + T713 + T714 → Wave 3

Wave 3: T690 + T694 + T695 → Wave 4

Wave 4: T682 (functional test — needs all preceding waves done)
Wave 4: T683 (ADR/docs — needs all preceding waves done)
```

### §5.3 Parallel Execution Within Waves

**Wave 0**: All 7 tasks are independent. ALL can run in parallel. Each is a distinct migration
file or a supporting schema task.

**Wave 1**: T679, T681, T693 are independent of each other (different functions/files).
Can run in parallel. T681 needs T703/T715 (session_id on retrieval rows to backfill).

**Wave 2**: T688 depends on T679 (shares applyStdpPlasticity function). T689, T692, T691 are
parallel with each other and with T688 IF they work on separate branches. In practice T688,
T689, T692 all modify `applyStdpPlasticity` — sequence them: T688 → T689 → T692 → T691.
T713 and T714 are independent of T688-T692.

**Wave 3**: T690 (new function) is independent of T694 (pipeline wiring) and T695 (grouping
optimization). T694 depends on T690 existing (must call it as Step 9c). T695 modifies the
inner loop which T692 also modified — ensure T695 runs after T692.

**Wave 4**: T682 requires ALL waves 0-3 complete. T683 runs in parallel with T682 (docs
don't require the test to pass first, but conventionally runs after T682 confirms things work).

---

## §6 Verification Matrix — Cross-Council Alignment

| Spec Section | Lead A Source | Lead B Source | Lead C Source | Status |
|---|---|---|---|---|
| §2.1.1 brain_retrieval_log schema | §4.1 complete | §1.3 spike definition | §8.1 Q1 | Aligned |
| §2.1.2 brain_plasticity_events schema | §4.2 complete | §4.5 StdpPlasticityResult | §8.1 Q2 | Aligned |
| §2.1.3 brain_page_edges schema | §4.3 complete | §7.1 plasticity_class | §8.1 Q1 | Aligned |
| §2.1.4 brain_weight_history | §4.4 full spec | §5 open Q-A2 resolved | Not in scope | Lead A authoritative |
| §2.1.5 brain_modulators | §4.5 full spec | Not in scope | §8.3 backfill dependency | Lead A + Lead C joint |
| §2.1.6 brain_consolidation_events | §4.6 full spec | §5.3 T628 hook | §4.2 ordering | Lead A + Lead C joint |
| §3.3 Tiered τ | Not in scope | §2.3 full model | Not in scope | Lead B authoritative |
| §3.4 LTP formula | Not in scope | §3.2 with τ(Δt) | Not in scope | Lead B authoritative |
| §3.5 LTD formula | Not in scope | §3.3 with τ(Δt) | Not in scope | Lead B authoritative |
| §3.6 R-STDP modulation | Not in scope | §4.4 formulas | Not in scope | Lead B authoritative |
| §3.7 Novelty boost | Not in scope | §6.2 k_novelty=1.5 | Not in scope | Lead B authoritative |
| §3.9 Homeostatic decay | Not in scope | §5.2 SQL implementation | §5.3 Step 9c | Lead B authoritative |
| §4.1 Writer hook | §2 (via lifecycle.ts:710) | §1.2 Option A | §1.2 Option A (confirmed) | All three councils agree |
| §4.2 Observer ordering | Not in scope | Not in scope | §2.2 consolidation before reflector | Lead C authoritative |
| §4.3 backfillRewardSignals | §8 open question Q7 | §4.2 reward logic | §5.1 function spec | Lead A Q resolved by Lead C |
| §4.6 CLI surface | Not in scope | Not in scope | §5.2 six commands | Lead C authoritative |
| §5 Migration sequence | §5.2 four files | Not in scope | Not in scope | Lead A authoritative |
| §6 Test plan | §7 functional test | Not in scope | §7 full test arch | Lead A + Lead C joint |

---

## §7 Open Questions Resolved to Zero

The original RCASD plan listed 5 open questions. The three councils + this synthesis have
resolved all of them:

| Question | Resolution |
|----------|-----------|
| 1. entry_ids: migrate or truncate? | Migrate existing 38 rows (idempotent JSON conversion) |
| 2. lookbackDays vs pairingWindowMs — cross-session? | YES — cross-session pairs enabled; pairingWindowMs=24h |
| 3. brain_page_edges plasticity cols — Phase 5 or later? | Phase 5 — all three columns REQUIRED by algorithm |
| 4. brain_weight_history — Phase 5 or Phase 7? | Phase 5 — owner directive elevated scope |
| 5. ADR location | docs/adrs/ (matches existing ADR files in codebase) |

**Result: ZERO open questions requiring owner decision before workers begin.**

---

*End of synthesis report. Master spec at `docs/specs/stdp-wire-up-spec.md` is the canonical record.*
