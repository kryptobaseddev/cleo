> SUPERSEDED by `T673-council-synthesis.md` and `docs/specs/stdp-wire-up-spec.md` — reference only.
> All decisions from this report are incorporated into the master spec. Do not use this file for implementation guidance.

# T673 Council — Integration Councilor Report (Lead C)

**Council Role**: Integration — WHERE and WHEN plasticity runs  
**Task**: T673 (STDP Phase 5: Wire-Up)  
**Parent Epic**: T627 (T-BRAIN-LIVING Stabilization)  
**Date**: 2026-04-15  
**Author**: cleo-subagent Lead C (Integration)  
**Status**: Complete

---

## §1 Writer Hook Location

### §1.1 Options Evaluated

**Option A: Session End (batch — all retrievals of a session processed together)**

- Latency: results available at next session close, not real-time
- Cross-session support: enabled if `lookbackDays` is set wider than 1 session; same-session pairs are the primary output
- Failure mode: if session end handler crashes, STDP is silently skipped (best-effort hook); no retry
- Idempotency: running twice would double-count pairs unless guarded by `WHERE NOT EXISTS` in INSERT — the current `applyStdpPlasticity` does not guard this
- Pros: already wired in `runConsolidation` Step 9; aligns with biological "sleep consolidation" model; no hot-path impact; batch efficiency
- Cons: requires session end to fire; a hanging session accumulates un-processed retrievals indefinitely

**Option B: Retrieval Callback (real-time — every logRetrieval triggers a plasticity scan)**

- Latency: immediate; each save fires a diff scan of recent prior retrievals
- Cross-session support: none — callback only sees in-progress session state
- Failure mode: if writer crashes mid-retrieval, it corrupts hot-path experience
- Idempotency: each retrieval row would re-scan overlapping windows, producing duplicate events unless deduped by row pair
- Pros: real-time edge weight updates; immediate visibility in Studio
- Cons: couples hot-path memory retrieval to STDP math; requires thread-safe access; O(n) scan per retrieval degrades as `brain_retrieval_log` grows; destroys the "spike pair timing" biological signal (pairs need a complete temporal sequence, not a rolling scan)

**Option C: Observer Summary Pipeline (when observer consolidates, plasticity runs as one step)**

- Latency: after LLM reflector completes (after consolidation, after backup — priority 4 in hooks)
- Cross-session support: depends on `lookbackDays` window in the underlying query
- Failure mode: LLM reflector may be disabled (no API key); STDP would not fire
- Idempotency: same as Option A; would require INSERT guard
- Pros: reflector-synthesized patterns could inform plasticity (observations used to identify valuable pairs)
- Cons: STDP correctness depends on whether LLM is enabled; wrong architectural dependency (plasticity is a math operation, not an LLM operation); makes a deterministic process contingent on an API key

**Option D: Hybrid (retrieval callback for within-session, session-end for cross-session catch-up)**

- Latency: within-session events are real-time; cross-session gaps resolved at session end
- Cross-session support: session-end catch-up handles prior sessions
- Failure mode: two code paths to maintain; within-session callback shares all Option B failure modes
- Idempotency: must deduplicate across both paths; complex
- Pros: lowest latency
- Cons: highest complexity; two failure surfaces; within-session callback still corrupts hot path

### §1.2 Recommendation: Option A (Batch at Session-End Consolidation, Step 9)

**Chosen**: Option A — `runConsolidation` Step 9, called from `handleSessionEndConsolidation` hook at priority 5.

**Justification**:

1. Already wired: `brain-lifecycle.ts:710` already calls `applyStdpPlasticity(projectRoot)` as Step 9. No new wiring is required. The fix is correctness (lookback window separation, session_id passthrough), not location.
2. Biological correctness: STDP requires processing the complete spike sequence (all retrievals in order), not a rolling pair scan. Session-end is the natural boundary for "what did the system access during this work period."
3. No hot-path impact: retrieval performance is unaffected. STDP runs `setImmediate` after the session response is returned to the caller.
4. Cross-session pairs: the `lookbackDays = 30` window already spans multiple sessions. Step 9 will detect cross-session pairs on every consolidation run regardless of which session triggered it.
5. Idempotency: the `UPSERT` on `brain_page_edges (from_id, to_id, edge_type)` is idempotent by primary key. Running twice produces the same result. The `brain_plasticity_events` INSERT must be guarded by a dedup window (e.g. skip pairs whose plasticity event was already written within the last 1 hour) — this is a small fix, not a reason to change architecture.

**Caveat**: If a session never ends normally (e.g. a crash), STDP does not run for that session's retrievals. This is acceptable: the next session's consolidation will process those rows via the 30-day lookback. No retrieval data is permanently lost.

---

## §2 Observer/Reflector Integration Ordering

### §2.1 Current Execution Order (hook priorities, session end)

```
priority 100  brain-session-end         handleSessionEnd        (transcript extraction, memory bridge)
priority 10   backup-session-end        handleSessionEndBackup  (SQLite VACUUM INTO)
priority 5    consolidation-session-end handleSessionEndConsolidation  (runConsolidation incl. STDP)
priority 4    reflector-session-end     handleSessionEndReflector      (runReflector — LLM synthesis)
```

Lower priority number = runs later (after higher-priority handlers complete).

### §2.2 Decision: Plasticity BEFORE Observer (consolidation at priority 5, reflector at priority 4)

**Decision**: Keep the existing ordering. Plasticity (Step 9 of `runConsolidation`, priority 5) MUST run before the LLM reflector (priority 4).

**Justification**:

The reflector's job is to synthesize session observations into patterns and learnings. If plasticity has already run and updated `brain_page_edges` weights, the reflector could in principle query those weights to identify "what was strongly co-retrieved this session" and synthesize richer patterns. This is the correct causal direction:

- Plasticity reads retrieval log → updates edges
- Reflector reads observations + edges → synthesizes patterns

Running plasticity AFTER the reflector would mean the reflector synthesizes from stale weights, losing the opportunity to observe fresh plasticity signals.

**Concrete consequence**: The reflector currently queries `brain_observations` (not edge weights), so this ordering has no immediate functional impact. But it is architecturally correct for future phases where the reflector may query `brain_page_edges` for "what was reinforced this session."

**Sub-step ordering within consolidation**: Per Lead A schema work and the RCASD plan:

```
Step 6   strengthenCoRetrievedEdges    (Hebbian — co-occurrence count, 30-day window)
Step 9a  backfillRewardSignals         (R-STDP — assign reward_signal from task outcomes)
Step 9b  applyStdpPlasticity           (STDP — timing-dependent Δw using reward_signal)
```

Step 9a MUST precede Step 9b. Reward signals must be written before STDP reads them. Step 6 (Hebbian) MUST precede Step 9b so STDP can apply LTD to existing Hebbian edges. This ordering is already correct in the codebase; only the 9a sub-step is new.

---

## §3 Session_id Backfill for Existing 38 brain_retrieval_log Rows

### §3.1 Options

**Option (a): null session_id — no backfill**

- Impact on Lead B algorithm: the 38 rows are treated as a single anonymous "session." Cross-session pair detection ignores session boundaries entirely and falls back to the 30-day lookback window. All 38 rows are eligible for pair formation regardless of which day they were created.
- Risk: the 30-day window already covers all 38 rows. No rows are lost.
- Implementation cost: zero.
- Data quality: lowest — no session attribution, reward signals can never be backfilled for historical rows.

**Option (b): assign synthetic session_id from created_at date bucketing**

- Each distinct calendar day in `brain_retrieval_log.created_at` becomes a synthetic `ses_YYYYMMDD` session ID.
- Impact on Lead B algorithm: rows are partitioned by day. Cross-session pairs are formed between rows in different daily buckets.
- Implementation: single SQL UPDATE statement per date bucket.
- Risk: rows created on the same day but during distinct actual sessions are merged into one synthetic session. This is imprecise but acceptable for historical data.
- Reward signal backfill: possible for date ranges with completed tasks, but mapping is approximate (date bucket ≠ real session).

**Option (c): infer session from timestamp proximity clustering**

- Group rows where `delta_ms` between consecutive rows < 30 minutes into one inferred session.
- Impact on Lead B algorithm: most precise grouping for historical rows; cross-session pairs detected at natural work-session boundaries.
- Implementation: requires an application-level clustering pass (not a single SQL statement).
- Risk: if `delta_ms` values are NULL or stale, clustering is unreliable. The 38 live rows span 3 days and likely represent real distinct sessions.

### §3.2 Recommendation: Option (b) — Date Bucketing

**Chosen**: Option (b) — synthetic `ses_DATE` session IDs via one-time SQL UPDATE.

**Justification**: The 38 rows span 2026-04-13 to 2026-04-15 across 3 calendar days. Date bucketing gives Lead B three synthetic sessions to form cross-session pairs from. This is strictly better than Option (a) (null, which collapses everything into one anonymous pool) and simpler than Option (c) (clustering, which adds an application-layer complexity that can fail on NULL delta_ms).

The date-bucketing UPDATE:
```sql
UPDATE brain_retrieval_log
SET session_id = 'ses_backfill_' || substr(created_at, 1, 10)
WHERE session_id IS NULL;
```

This MUST run as part of the STDP-W1 migration. It is idempotent (already-set rows are not touched by `WHERE session_id IS NULL`).

**Note for Lead B**: cross-session pair algorithm should treat any `session_id` starting with `ses_backfill_` as a synthetic session. Reward signal backfill MUST NOT be attempted for synthetic sessions (no real task correlation is possible).

---

## §4 Auto-Dream Cycle (T628) Integration

### §4.1 T628 Current Scope

Per `cleo show T628`: T628 defines the auto-dream cycle with these requirements:
- Scheduled trigger (cron-like, every N hours or daily at quiet time)
- Idle detection (N minutes of no activity)
- Volume threshold (after M new observations)
- Owner-configurable thresholds via `cleo config`
- Option to DISABLE auto-trigger in favor of manual `cleo memory consolidate`

T628 acceptance criteria include `cleo memory dream` command and a configurable schedule. T628 is pending, high priority.

### §4.2 Decision: Plasticity IS Part of the Dream Cycle

**Decision**: Plasticity MUST be part of the dream cycle, not separate. The dream cycle IS `runConsolidation` with intelligent triggers. Since STDP is already Step 9 of `runConsolidation`, any dream trigger automatically fires STDP.

**Rationale**: The dream cycle is a scheduling wrapper around the existing consolidation pipeline. Adding plasticity as a separate orthogonal process would create two code paths executing the same logic at different times. This violates DRY and creates race conditions when both fire in the same session.

### §4.3 T628 Scope Expansion

T628's scope MUST be expanded to include:

1. The `cleo memory dream` command MUST call `runConsolidation(projectRoot)` (which includes STDP as Step 9).
2. The dream cycle scheduler MUST pass the current session ID to `runConsolidation` so that `backfillRewardSignals` (Step 9a) can attribute reward signals to the triggering session.
3. Dream cycle scheduling candidates, in priority order:
   - **Volume threshold** (primary): fire after M = 10 new `brain_observations` since last consolidation. This is the lowest latency trigger with the lowest overhead. STDP benefits from pairs within the same "active period."
   - **Idle detection** (secondary): fire after N = 30 minutes of no retrieval activity. Aligns with the biological "slow-wave sleep" phase — consolidation during quiet periods.
   - **Scheduled cron** (tertiary): nightly at 2 AM local time. Catch-up pass for sessions that never triggered volume or idle thresholds.

### §4.4 Phase Analogy (Biological)

| Dream Phase | CLEO Analogue | Plasticity Role |
|-------------|---------------|-----------------|
| Slow-wave sleep | Volume threshold trigger (post-work burst) | Hebbian strengthening (Step 6) + STDP (Step 9) on same-session pairs |
| REM sleep | Idle/scheduled trigger | Cross-session pair detection; dedup; tier promotion; reflector LLM synthesis |
| Wake (manual) | `cleo memory dream` or `cleo brain maintenance` | Full pipeline, operator-controlled |

### §4.5 SessionEnd Consolidation vs Dream Cycle

T628 notes the owner's concern that session-end consolidation is "too eager, fires on every session close." Two options:

- **Keep session-end consolidation as backstop**: session end fires a lightweight consolidation (Steps 1-6 only — no STDP, no reflector), and the dream cycle fires the full pipeline including STDP. This minimizes per-session overhead.
- **Move all consolidation to dream cycle**: session end does only backup (priority 10) and memory bridge refresh (priority 100). Dream cycle owns all computation.

**Recommendation for owner decision**: The integration council recommends keeping session-end consolidation as a backstop but gating STDP (Step 9) behind a minimum-pair-count check. If `brain_retrieval_log` has fewer than 2 new rows since last STDP run, skip Step 9 — it is a no-op anyway. This avoids the overhead problem while preserving correctness.

---

## §5 CLEO CLI Surface

### §5.1 Existing Commands (already shipped)

| Command | Location | Status |
|---------|----------|--------|
| `cleo brain plasticity stats [--limit N] [--json]` | `brain.ts:263` | Shipped, functional |
| `cleo brain maintenance [--skip-consolidation] [--json]` | `brain.ts:44` | Shipped; STDP fires via Step 9 |

### §5.2 New Commands Required

All new commands MUST be added to `packages/cleo/src/cli/commands/brain.ts` under the existing `brain plasticity` subcommand group.

**Command 1: `cleo brain plasticity events`**

```
cleo brain plasticity events [--since <ISO-date>] [--limit <n>] [--session <id>] [--kind ltp|ltd] [--json]
```

Synopsis: List individual plasticity events from `brain_plasticity_events`. Supports filtering by date, session, and kind. Default limit 50. Sorted newest-first. Human output shows source/target node IDs, delta_w, kind, timestamp, session_id.

Backend: new exported function `getPlasticityEvents(projectRoot, options)` in `brain-stdp.ts`.

**Command 2: `cleo brain plasticity apply`**

```
cleo brain plasticity apply [--dry-run] [--json]
```

Synopsis: Manual trigger — runs `applyStdpPlasticity(projectRoot)` immediately. With `--dry-run`, reports how many pairs would be processed without writing any events. Useful for debugging, forced consolidation, and verifying that the fix resolves the 0-events problem.

Backend: calls existing `applyStdpPlasticity(projectRoot)` directly.

**Command 3: `cleo brain plasticity history`**

```
cleo brain plasticity history --source <node-id> --target <node-id> [--limit <n>] [--json]
```

Synopsis: Show all plasticity events for a specific source→target edge pair, ordered by timestamp. Displays the weight_delta series for that pair so operators can see whether LTP or LTD has dominated over time. This is the closest substitute for the Phase 7 `brain_weight_history` table — it derives the same information from `brain_plasticity_events`.

Backend: SQL query against `brain_plasticity_events WHERE source_node = ? AND target_node = ?`.

**Command 4: `cleo brain plasticity reset`** (optional, operator use)

```
cleo brain plasticity reset [--confirm] [--json]
```

Synopsis: Truncate `brain_plasticity_events` and reset all `brain_page_edges.weight` values to 1.0 for edges of type `co_retrieved`. Requires `--confirm` flag. Intended for testing/debugging only. MUST print a clear warning that this is destructive.

**Command 5: `cleo memory dream`** (part of T628)

```
cleo memory dream [--dry-run] [--json]
```

Synopsis: Manually trigger a full dream cycle (= `runConsolidation`). Calls `backfillRewardSignals` (Step 9a) then `applyStdpPlasticity` (Step 9b). With `--dry-run`, reports what would run without writing. Output includes per-step counts (dedup, promotions, STDP events).

Backend: calls `runConsolidation(projectRoot)` and passes session ID if an active session exists.

**Command 6: `cleo memory consolidate`** (already implied by T628, verify it exists)

```
cleo memory consolidate [--json]
```

Verify this exists in `memory-brain.ts`. If missing, add it as an alias for `cleo memory dream` that runs without the STDP sub-steps (Steps 1-8 only). This satisfies T628's "option to disable auto-trigger in favor of manual consolidate" requirement.

### §5.3 Commands NOT Recommended

- `cleo memory plasticity stats` — duplication of `cleo brain plasticity stats`; avoid two surface paths to same data
- `cleo memory plasticity tune` — Phase 6 per spec §8

---

## §6 Studio UI Integration Plan

### §6.1 Current State

The LivingBrainGraph Svelte component (`LivingBrainGraph.svelte`) already:
- Renders edge thickness proportional to `edge.weight` via `Math.max(0.5, (edge.weight ?? 0.5) * 3)` (line 230)
- Pulses edges via `pulsingEdges` prop (Set of `"source|target"` keys)
- Shows `w=X.XX` in tooltip when `edge.weight` is defined

The `brain_page_edges` substrate adapter (`adapters/brain.ts`) already reads `weight` from the live table.

**Consequence**: once STDP writes non-trivial weights into `brain_page_edges`, the Studio canvas will automatically render weight-scaled edge thicknesses. No graph renderer changes are needed for basic weight visualization.

### §6.2 Phase 6 Studio Additions Required

These are planning items for the Phase 6 studio task. They are NOT in scope for T673 but must be tracked.

**6.2.1 Plasticity Event Feed (side panel)**

A new `PlasticityFeed.svelte` component in `packages/studio/src/lib/components/` that:
- Polls `GET /brain/plasticity-events` (new API endpoint) on a configurable interval (default 30 seconds)
- Renders a scrolling feed of recent events: `[LTP] obs:A → obs:B Δw=+0.023 (2 min ago)`
- Highlights the corresponding edge on the graph when an event is hovered
- Shows a filter toggle for LTP-only / LTD-only / all

The API endpoint reads from `brain_plasticity_events` with a limit of 50, ordered newest-first.

**6.2.2 LTP Pulse Animation on Recent Events**

Extend the existing pulsing mechanism to fire on events newer than 60 seconds. The `/brain` page server load function queries `brain_plasticity_events WHERE timestamp > (now - 60s)` and returns the source→target pairs as `pulsingEdges`. Edges that were recently LTP-strengthened pulse white briefly when the page loads or refreshes.

**6.2.3 Edge Weight History Chart**

When a user clicks a `co_retrieved` edge in the Studio canvas, the edge detail side panel shows:
- Current weight (already in tooltip)
- A mini sparkline chart of weight changes over time derived from querying `brain_plasticity_events WHERE source_node = ? AND target_node = ? ORDER BY timestamp`
- This is the Phase 6 equivalent of the Phase 7 `brain_weight_history` table — the data already exists in `brain_plasticity_events`

**6.2.4 Stub Node Guard for Plasticity**

Per T663 scope: stub nodes carry `meta.isStub: true`. When a `co_retrieved` edge involves a stub node endpoint, the edge weight visualization MUST render at minimum opacity (e.g., `opacity: 0.3`) and the plasticity feed MUST skip events where either `source_node` or `target_node` maps to a stub. This prevents plasticity UI from attributing weight to nodes that have no real brain.db record.

**Implementation point**: the brain substrate adapter at `adapters/brain.ts:292` loads all `brain_page_edges` rows including `co_retrieved` edges. The stub guard MUST be applied in the adapter, not the renderer: if `from_id` or `to_id` matches a stub node ID in the current graph, set `weight: undefined` on that edge (which causes the renderer to use the 0.5 default instead of a plasticity-trained value).

### §6.3 Studio API Endpoint Required

New SvelteKit route: `packages/studio/src/routes/api/brain/plasticity-events/+server.ts`

- Method: `GET`
- Query params: `limit` (default 50), `since` (ISO date, optional), `kind` (ltp | ltd | all)
- Returns: `{ events: PlasticityEvent[], totalEvents: number, lastEventAt: string | null }`
- Calls `getPlasticityEvents(projectRoot, options)` from `@cleocode/core`

---

## §7 Functional Test Architecture

### §7.1 Owner Directive

"Tested functionally for REAL — no fake mock or just vitests, we need automated testing but that doesn't test real world."

The existing `brain-stdp.test.ts` uses `vi.mock('../../store/brain-sqlite.js')`. This test is sound for unit verification of LTP/LTD math but cannot detect the bugs that caused 0 events in production (wrong lookback window, missing session_id, entry_ids format mismatch). All three root-cause bugs were runtime integration failures invisible to mocked unit tests.

### §7.2 Test Location

```
packages/core/src/memory/__tests__/brain-stdp-functional.test.ts
```

This follows the existing pattern: `brain-stdp.test.ts` (unit, mocked) lives alongside `brain-stdp-functional.test.ts` (functional, real DB).

### §7.3 Time Handling Strategy

**Decision**: Use real wall-clock time with short delays, NOT mocked time.

The STDP pair-comparison window (`sessionWindowMs = 5 minutes`) is used to determine whether two consecutive retrievals are "co-activated." For the functional test, retrievals MUST be inserted with timestamps that are within this window.

**Strategy**: Insert retrieval rows with `created_at` values using `datetime('now', '-30 seconds')`, `datetime('now', '-20 seconds')`, `datetime('now', '-10 seconds')`. These timestamps are real SQLite time expressions evaluated at INSERT time. No sleep() calls needed. No time mocking.

**Why not mock time**: mocking time at the boundary (e.g., via a `TimeProvider` abstraction injected into `applyStdpPlasticity`) is sound architecturally, but introducing that abstraction solely for the test is scope creep for T673. The direct SQL timestamp approach achieves the same result without changing production code. The test runs in < 1 second.

**Why not use real delays**: `await new Promise(r => setTimeout(r, 30_000))` would make the test suite 30 seconds slower per test case. Rejected.

### §7.4 Test Cases

**File**: `packages/core/src/memory/__tests__/brain-stdp-functional.test.ts`

```typescript
describe('STDP Functional Test — real brain.db, no mocks', () => {

  // Setup: temp dir with real brain.db
  // Uses CLEO_DIR env override to redirect getBrainDb to temp dir
  // Cleanup: closeBrainDb() + rm(tempDir)

  it('STDP-F1: LTP event written after two correlated retrievals', async () => {
    // Insert brain_page_nodes for obs:A, obs:B
    // Insert 2 retrieval rows: obs:A at T-30s, obs:B at T-10s (both contain obs:A+obs:B)
    // Run applyStdpPlasticity(tempDir)
    // Assert: brain_plasticity_events has >= 1 row where kind = 'ltp'
    // Assert: brain_page_edges has >= 1 row where edge_type = 'co_retrieved'
    // Assert: that edge's weight > 0
  });

  it('STDP-F2: brain maintenance CLI command produces events', async () => {
    // Insert retrieval rows as above
    // Execute: cleo brain maintenance --json (via execFileSync against real binary)
    // Assert: exit code 0
    // Assert: brain_plasticity_events COUNT(*) > 0
    // Assert: cleo brain plasticity stats --json returns totalEvents > 0
  });

  it('STDP-F3: cross-session pair detection', async () => {
    // Insert retrieval rows in two distinct synthetic sessions:
    //   session_id = 'ses_test_A': obs:A + obs:B at T-2d
    //   session_id = 'ses_test_B': obs:B + obs:C at T-30s
    // Run applyStdpPlasticity(tempDir, { lookbackDays: 30 })
    // Assert: event for obs:B→obs:C exists (within-session pair from session B)
    // Assert: event for obs:A→obs:B exists (within-session pair from session A, within 30d window)
    // OPTIONAL: Assert cross-session pair obs:B bridging sessions A and B has higher weight
    //   than obs:A→obs:B or obs:B→obs:C individually
  });

  it('STDP-F4: LTD event weakens reverse edge when post fires before pre', async () => {
    // Insert brain_page_edges with edge_type = 'co_retrieved', from_id = obs:B, to_id = obs:A, weight = 0.8
    // Insert retrieval rows: obs:B at T-30s, obs:A at T-10s (reverse order: B before A)
    // Run applyStdpPlasticity(tempDir)
    // Assert: brain_plasticity_events has >= 1 row where kind = 'ltd'
    // Assert: brain_page_edges (obs:B → obs:A) weight < 0.8
  });

  it('STDP-F5: entry_ids JSON format accepted (not comma-separated)', async () => {
    // Insert retrieval rows with entry_ids = '["obs:A","obs:B"]' (JSON format)
    // Run applyStdpPlasticity(tempDir)
    // Assert: no error thrown
    // Assert: brain_plasticity_events COUNT(*) > 0
    // Verify: entry_ids in comma-separated format DOES NOT produce events
    //   (insert a second row with entry_ids = 'obs:A,obs:B', assert no new events for that row)
  });

  it('STDP-F6: session_id propagated to brain_plasticity_events', async () => {
    // Insert retrieval rows with session_id = 'ses_test_functional'
    // Run applyStdpPlasticity(tempDir)
    // Assert: brain_plasticity_events rows have session_id = 'ses_test_functional'
  });

  it('STDP-F7: reward_signal modulates Δw (R-STDP path)', async () => {
    // Insert retrieval rows with reward_signal = 1.0 (max positive reward)
    // Run applyStdpPlasticity(tempDir)
    // Assert: brain_plasticity_events delta_w for this pair > A_PRE (0.05)
    //   (modulation formula: Δw_ltp * (1 + r) = 0.05 * 2.0 = 0.10 at Δt → 0)
    // Insert retrieval rows with reward_signal = -1.0 (max negative reward)
    // Run applyStdpPlasticity(tempDir) again (or fresh session)
    // Assert: LTP events for that session have delta_w close to 0 (modulation reduces to ~0)
  });

});
```

### §7.5 Test Infrastructure Requirements

**Real binary invocation** (STDP-F2 only): call the installed `cleo` binary via `execFileSync` with `CLEO_DIR` overridden. The binary path is `$(which cleo)` or resolved from `packages/cleo/dist/cli.js`. For CI: the binary must be built before this test runs. The test file MUST guard: if `cleo` binary not found, skip STDP-F2 with `test.skip`.

**DB isolation**: each `it()` block gets its own `mkdtemp` directory. `getBrainDb` and `getBrainNativeDb` use `CLEO_DIR` env to resolve the DB path. The test `beforeEach` MUST set `process.env.CLEO_DIR` and `afterEach` MUST restore the original value and call `closeBrainDb()`.

**Timeout**: set `vi.setConfig({ testTimeout: 30_000 })` at file level. CLI invocation may take 3-5 seconds. Direct function calls take < 100ms. The file-level timeout prevents test runner false failures.

**No vi.mock**: the test file MUST NOT call `vi.mock` for any brain or SQLite module. If the existing `brain-stdp.test.ts` hoisted mocks leak into this file via auto-imports, the test MUST be in a separate `describe` block with its own Vitest worker process (use `pool: 'forks'` in vitest.config.ts for this file if isolation issues arise).

### §7.6 Test Placement in CI

The functional test MUST be included in the `pnpm run test` pass in `packages/core`. No separate CI step required. The existing Vitest configuration at `packages/core/vitest.config.ts` will discover the file via the `**/*.test.ts` glob.

---

## §8 Open Questions and Cross-Council Dependencies

### §8.1 Schema Questions (depend on Lead A)

1. **`brain_page_edges` optional columns**: `last_reinforced_at`, `reinforcement_count`, `plasticity_class` — are these in scope for T673 or Phase 6? Integration council needs to know whether to include them in the STDP-W1 migration subtask or create a separate subtask.

2. **`brain_plasticity_events.session_id`** — currently the INSERT at `brain-stdp.ts:277` omits session_id. Lead A must confirm whether the schema already has this column (it does per the RCASD plan) and that the fix is purely in the INSERT statement.

3. **entry_ids JSON migration** — the one-time UPDATE converting comma-separated rows to JSON arrays MUST be idempotent. The SQL in `stdp-wire-up-spec.md §3.2` is idempotent via `WHERE entry_ids NOT LIKE '[%'`. Integration council confirms this is the correct approach.

### §8.2 Algorithm Questions (depend on Lead B)

4. **Cross-session pair window**: Lead B's algorithm design must specify whether pairs spanning more than one synthetic session (from the date-bucketing backfill) are eligible for the STDP computation, or whether session boundary is a hard cutoff. Integration council recommendation: session boundary is NOT a hard cutoff; pairs are eligible if their `created_at` Δt is within `sessionWindowMs` regardless of session_id.

5. **Minimum pair threshold for session-end STDP gate**: integration council recommends adding a guard in `handleSessionEndConsolidation`: if `brain_retrieval_log` has fewer than 2 rows created since the last `brain_plasticity_events` event, skip Step 9. This prevents STDP overhead on sessions with no retrievals. Lead B should confirm this guard does not break the cross-session pair detection.

### §8.3 T628 Dependency

6. **T628 dream cycle trigger**: T628 is pending. The plasticity integration is already functional via session-end consolidation. T628's scope expansion (adding `cleo memory dream` command, configurable triggers) is the next integration milestone. T628 MUST include STDP in its definition of "a complete dream cycle." The integration council recommends adding T628 as a dependency of the STDP CLI surface subtask (see §9.3 below).

### §8.4 T663 Studio Dependency

7. **T663 stub-node loader**: T663 delivers the stub-node loader. The plasticity Studio integration (§6.2.4) depends on T663 being complete so stub node detection is reliable. Studio plasticity visualization MUST be gated until T663 ships. The integration council recommends ordering: T663 → Studio plasticity Phase 6 subtask.

---

## §9 Recommended Child Tasks Under T673

The following subtasks are ADDITIONAL integration-specific concerns not covered by STDP-W1 through STDP-W6 from the RCASD plan. They should be created as children of T673.

### §9.1 STDP-I1: Idempotency Guard for brain_plasticity_events INSERT

**Scope**: Add a dedup guard to `applyStdpPlasticity` so that re-running consolidation on the same session does not produce duplicate plasticity events. Approach: before inserting, check `WHERE source_node = ? AND target_node = ? AND timestamp > datetime('now', '-1 hour')` — skip pair if event already written recently.

**Size**: small  
**Depends on**: STDP-W2

### §9.2 STDP-I2: session-end consolidation minimum-pair gate

**Scope**: Add a guard in `handleSessionEndConsolidation` (or inside `runConsolidation` Step 9) that skips STDP if fewer than 2 new `brain_retrieval_log` rows exist since the last `brain_plasticity_events` timestamp. Prevents no-op STDP overhead on sessions with no retrievals.

**Size**: small  
**Depends on**: STDP-W2

### §9.3 STDP-I3: `cleo brain plasticity events` and `cleo brain plasticity history` commands

**Scope**: Implement the two new CLI commands defined in §5.2. Add `getPlasticityEvents` function to `brain-stdp.ts`. Add commands to `brain.ts`.

**Size**: small  
**Depends on**: STDP-W1, STDP-W2

### §9.4 STDP-I4: `cleo brain plasticity apply` manual trigger command

**Scope**: Implement the manual trigger command defined in §5.2. Calls `applyStdpPlasticity` directly with optional `--dry-run`.

**Size**: small  
**Depends on**: STDP-W2

### §9.5 STDP-I5: Session_id backfill migration for existing 38 rows

**Scope**: Add the date-bucketing SQL UPDATE to the STDP-W1 migration file so existing rows receive synthetic session IDs. Verify idempotency.

**Size**: small  
**Depends on**: STDP-W1

### §9.6 STDP-I6: Studio plasticity event feed (Phase 6)

**Scope**: `PlasticityFeed.svelte` component, `/api/brain/plasticity-events/+server.ts` route, LTP pulse animation on recent events. Gated on T663 (stub-node loader) being complete.

**Size**: medium  
**Depends on**: STDP-W2, T663

---

## §10 Summary of Decisions

| Decision | Chosen Option | Rationale |
|----------|---------------|-----------|
| Writer hook location | Option A: batch at session-end consolidation (Step 9) | Already wired; biological correctness; no hot-path impact |
| Observer ordering | Plasticity BEFORE reflector (consolidation priority 5 > reflector priority 4) | Correct causal direction; reflector should see fresh weights |
| session_id backfill | Option (b): date-bucketing synthetic session IDs | Better than null; simpler than proximity clustering |
| Auto-dream integration | Plasticity IS part of dream cycle (T628 expansion) | DRY; avoids parallel code paths |
| Functional test time strategy | Real SQLite timestamps (SQL datetime expressions), no sleep | No production code change; < 1s test execution |
| Functional test location | `packages/core/src/memory/__tests__/brain-stdp-functional.test.ts` | Alongside existing unit test; discovered by existing glob |
| Stub edge plasticity | Skip plasticity events for edges involving stub nodes | Prevents weight attribution to unresolved node references |
| T628 scope | Expand T628 to include `cleo memory dream` command that calls `runConsolidation` | T628 acceptance criteria already mention this |

---

*Integration complete. Cross-council dependencies flagged. Child tasks enumerated. No fabricated information — all citations traceable to source file:line in RCASD plan and codebase.*
