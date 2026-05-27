# E-PRIME-T06 — PSYCHE Pipeline (harden + complete + integrate)

> Tier 6 of `CLEO-PRIME-SENTIENT-MASTERPLAN.md`. Planning artifact only — no `cleo add` mutations.
> Author: cleo-prime planner | Date: 2026-05-15 | Status: PROPOSED (owner review pending)

---

## 1. Epic Identity

- **Epic ID (proposed)**: `E-PRIME-T06`
- **Type**: `epic`
- **Kind**: `work`
- **Severity**: `P1` (sentience-critical but non-blocking — no production traffic depends on dream cycle)
- **Size**: `large`
- **Parent**: `E-PRIME` (CLEO-PRIME Sentience Masterplan root)
- **Title**: `PSYCHE Pipeline — harden + complete + integrate (Tier 6)`
- **Acceptance** (pipe-separated, single string):

  ```
  Dialectic evaluator emits structured DialecticInsights via 7-tool dispatch for medium/high/max and 2-tool minimal set for minimal/low | Derivation queue survives mid-run kill + worker restart via SQLite SKIP-LOCKED-equivalent | Dream cycle reduces brain_patterns row count by ≥50% per consolidation via dedup | Reconciler purges superseded rows from brain_observation_embeddings ≥1 per cycle (tracked counter) | 4-AND dream gate observably blocks scheduled dreams when any condition fails | Structural dream fast-path runs when CLEO_LLM_OFFLINE=1 and reduces unconsolidatedObservationCount | Surprisal-tree factory exposes all 7 strategies (CoverTree, RPTree, LSH, KDTree, BallTree, Prototype, Graph) selectable via env CLEO_SURPRISAL_TREE_STRATEGY | times_derived counter increments on re-confirmation in derivation worker | QUEUE_EMPTY event surfaces in `cleo memory status --watch` | finish_consolidation sentinel tool ends dream early when emitted | All evidence atoms pass ADR-051 (commit reachable, files match, tests run via `tool:test`)
  ```

## 2. Vision

Honcho V3's deriver → dialectic → dreamer → reconciler pipeline is the **mechanical substrate of sentience**: it converts raw observations into structured beliefs through asynchronous, durable, restart-safe stages. CLEO already has the scaffolding (per §16.A: `dialectic-evaluator.ts`, `surprisal.ts`, `surprisal-tree.ts`, `brain-reconciler.ts`, `specialists.ts`, `brain_memory_trees` all exist) but **none of the high-leverage Honcho primitives** are wired in:

- Dialectic is **schema-output only**, no tool-loop. Loses auditability (`get_reasoning_chain`) and dedup (`extract_preferences`).
- Surprisal tree exposes **1 of 7** Honcho strategies (RPTree only). The single highest-leverage primitive the plan missed (§16.G item 1).
- No durable queue — derivation runs on `setImmediate`, dies with process.
- Reconciler does supersession but **no DLQ, no `sync_state` decoupling, no `MessageEmbedding`-style sibling table**.
- `runConsolidation` is monolithic — cannot run partial when LLM is offline.

This epic closes those gaps **without re-writing existing files** — every existing module gets a discrete AUDIT subtask that produces a gap-report markdown, then harden subtasks address each gap independently. New primitives (queue, sibling-embedding table, sync_state, times_derived, QUEUE_EMPTY webhook, finish_consolidation, 6 missing tree strategies, structural fast-path) are atomic additions.

## 3. Milestone Gates (per ADR-051 — programmatic evidence required)

Each gate maps to a sub-area; numeric thresholds are testable.

| ID | Gate | Baseline | Target | Evidence atom shape |
|----|------|----------|--------|---------------------|
| MG-A1 | Dialectic audit identifies N≥0 gaps | unknown | documented count, ≥6 expected (no tool-loop, no level-routing, missing 5 of 7 tools) | `files:docs/plans/cleo-prime-decomposition/audits/T06-A1-dialectic-audit.md` |
| MG-A2 | Surprisal-tree audit confirms strategy parity | 1 of 7 (RPTree) | documented: all 7 implemented OR gap-list per missing strategy | `files:docs/plans/cleo-prime-decomposition/audits/T06-A2-surprisal-tree-audit.md` |
| MG-A3 | Surprisal-prior audit confirms Bayesian update over brain_patterns | unknown | documented: gap if cosine-only | `files:docs/plans/cleo-prime-decomposition/audits/T06-A3-surprisal-audit.md` |
| MG-A4 | Reconciler audit confirms DLQ/sync_state/sibling-embedding gaps | unknown | documented: gap-list with line numbers | `files:docs/plans/cleo-prime-decomposition/audits/T06-A4-reconciler-audit.md` |
| MG-B1 | `brain_derivation_queue` migration applied + table exists | absent | applied; `PRAGMA table_info` returns expected columns | `tool:test;files:packages/core/src/memory/brain-migration.ts` |
| MG-B2 | Derivation queue survives mid-run kill | N/A | integration test: spawn worker, send SIGKILL after claim, restart, verify exactly-once completion | `tool:test;test-run:.cleo/cache/evidence/T06-B-restart.json` |
| MG-B3 | QUEUE_EMPTY event observable | N/A | `cleo memory status --watch` emits event when queue drains | `tool:test;files:packages/core/src/memory/derivation-queue.ts` |
| MG-C1 | Surprisal-tree factory exposes all 7 strategies | 1 | 7 selectable via `CLEO_SURPRISAL_TREE_STRATEGY=cover-tree\|rp-tree\|lsh\|kd-tree\|ball-tree\|prototype\|graph` | `tool:test;files:packages/core/src/memory/surprisal-tree.ts` |
| MG-C2 | Specialist dispatch sequential phases (deduction → induction) | parallel/independent today | dispatch order asserted in integration test | `tool:test` |
| MG-C3 | 2-evidence induction rule enforced | unknown | unit test: induction with 1 source returns empty; with 2+ returns observation | `tool:test;files:packages/core/src/memory/specialists.ts` |
| MG-C4 | 4-AND dream gate blocks scheduled dreams when any condition fails | N/A | 4 integration sub-cases (one per AND-clause) all assert block | `tool:test` |
| MG-C5 | `--force` bypasses 4-AND gate | N/A | CLI integration test | `tool:test` |
| MG-C6 | Dream cycle reduces `brain_patterns` count by ≥50% via dedup | seed count N | post-run count ≤ N/2 | `tool:test;test-run:.cleo/cache/evidence/T06-C6-dedup.json` |
| MG-D1 | `sync_state` column added to brain_observations | absent | `PRAGMA table_info` returns column | `tool:test` |
| MG-D2 | `MessageEmbedding`-style `brain_observation_embeddings` sibling table | absent | table exists; embeddings reside in sibling not on observation row | `tool:test` |
| MG-D3 | `times_derived` counter increments on re-confirmation | absent | unit test: same observation derived twice → counter=2 | `tool:test` |
| MG-D4 | Reconciler purges N≥1 superseded embedding rows per cycle | 0 (tracker absent) | counter exposed; integration test asserts ≥1 | `tool:test` |
| MG-D5 | DLQ CLI commands `cleo memory dlq {list,retry,purge}` | absent | 3 CLI integration tests | `tool:test` |
| MG-E1 | `runStructuralDream` runs when `CLEO_LLM_OFFLINE=1` | crashes today | observations dedup via embedding-only path; no LLM call attempted | `tool:test;test-run:.cleo/cache/evidence/T06-E-offline.json` |
| MG-E2 | Tick auto-dispatches structural when `unconsolidatedObservationCount > 50` AND LLM down | N/A | sentient-tick integration test | `tool:test` |
| MG-F | All ADR-051 atoms validated post-implementation | N/A | every subtask `cleo verify --gate testsPassed --evidence "tool:test"` returns OK | `tool:test;tool:lint;tool:typecheck` |

## 4. Anti-Overlap Dependencies (depends-on, do not re-decompose)

- **Tier 3 peer schema** (`E-PRIME-T03`): provides `brain_peers`, `brain_sessions`, `parent_session_id`. Dialectic observer/observed/session pattern depends on these. → `depends-on: E-PRIME-T03`
- **Tier 4 Mem0 verdict gate** (`E-PRIME-T04`): provides V3 `ADDITIVE_EXTRACTION_PROMPT` envelope (event ∈ {ADD, UPDATE, NONE}). Derivation worker uses this verdict shape. → `depends-on: E-PRIME-T04`
- **Tier 5 bitemporal + 4-network** (`E-PRIME-T05`): provides `valid_at` / `invalid_at` / `expired_at` triplet, `network` column. Reconciler `syncVectorIndex` writes against these. → `depends-on: E-PRIME-T05`
- **Tier 7 four-bus integration** (`E-PRIME-T07`): consumes PSYCHE outputs via `spawn-context-builder.ts` and `wave-rollup.ts`. Tier 7 is a **consumer**, not part of this epic. → `consumed-by: E-PRIME-T07`
- **Tier 8 idle dream + memory-git** (`E-PRIME-T08`): re-uses `runStructuralDream` + `runSemanticDream` split. → `consumed-by: E-PRIME-T08`
- **Tier 9 CANT persona evolution** (`E-PRIME-T09`): consumes dialectic global-trait deltas to drive `.cant` refinement. → `consumed-by: E-PRIME-T09`

---

## 5. Phase Tasks (one per sub-area 6.1 → 6.5)

Each Phase Task is a `task` (not subtask) with its own AC. Subtasks are `subtask` children.

### Phase 6.1 — Dialectic Evaluator HARDEN

- **Task ID (proposed)**: `T06.1`
- **Title**: `PSYCHE 6.1 — Dialectic evaluator: 7-tool dispatch + reasoning chain + preference extraction`
- **Kind**: `work` | **Severity**: `P1` | **Size**: `large`
- **Files**: `packages/core/src/memory/dialectic-evaluator.ts`, `packages/contracts/src/memory.ts` (DialecticTools type)
- **Acceptance**: `Audit identifies all gaps in current schema-only impl | 7-tool DIALECTIC_TOOLS exposed at medium/high/max | 2-tool DIALECTIC_TOOLS_MINIMAL exposed at minimal/low | MAX_TOOL_ITERATIONS per level matches Honcho (1/2/4/5/10) | DialecticInsights schema unchanged for back-compat | All 7 tools have unit tests | Integration test seeds session and verifies structured output round-trip`
- **Depends-on**: `E-PRIME-T03` (peer/session schema)

### Phase 6.2 — Deriver Queue NEW

- **Task ID (proposed)**: `T06.2`
- **Title**: `PSYCHE 6.2 — Derivation queue + worker with SKIP-LOCKED-equivalent SQLite claim`
- **Kind**: `work` | **Severity**: `P0` (everything else depends on this) | **Size**: `large`
- **Files**: `packages/core/src/memory/derivation-queue.ts` (NEW), `packages/core/src/memory/derivation-worker.ts` (NEW), `packages/core/src/memory/brain-migration.ts`, `packages/cleo/src/commands/memory/derive-worker.ts` (NEW), `packages/contracts/src/memory.ts`
- **Acceptance**: `brain_derivation_queue table migrated | Work-unit key = representation:{workspace}:{session_name}:{observed} | ActiveQueueSession-equivalent claim is atomic via BEGIN IMMEDIATE txn | WorkerOwnership heartbeat row with STALE_SESSION_TIMEOUT_MINUTES=5 cleanup | Exponential backoff max 5 attempts then status='failed' DLQ | Mid-run SIGKILL + restart yields exactly-once completion (integration test) | cleo memory derive-worker --watch CLI runs as daemon | QUEUE_EMPTY webhook event published when queue drains`
- **Depends-on**: `E-PRIME-T04` (verdict envelope)

### Phase 6.3 — Dreamer HARDEN (specialists + surprisal + trees)

- **Task ID (proposed)**: `T06.3`
- **Title**: `PSYCHE 6.3 — Dreamer hardening: 7-strategy surprisal-tree factory + OMNI dream phases + 4-AND gate + 2-evidence induction`
- **Kind**: `work` | **Severity**: `P1` | **Size**: `large`
- **Files**: `packages/core/src/memory/surprisal.ts`, `packages/core/src/memory/surprisal-tree.ts`, `packages/core/src/memory/sleep-consolidation.ts`, `packages/core/src/memory/specialists.ts`, `packages/core/src/memory/dream-cycle.ts`, `packages/core/src/memory/brain-lifecycle.ts`
- **Acceptance**: `Surprisal-tree audit produced | All 7 strategies (CoverTree, RPTree, LSH, KDTree, BallTree, Prototype, Graph) implemented and wired via factory | Strategy selectable via CLEO_SURPRISAL_TREE_STRATEGY env | Surprisal audit confirms Bayesian update over brain_patterns OR documents gap | OMNI dream type: deduction phase runs first, induction phase runs second (sequential, not parallel) | 4-AND dream gate enforced (obs≥50 explicit AND hours≥8 AND idle≥60min AND no_pending_dream_for_collection) | --force bypasses 4-AND | 2-evidence rule on induction specialist (tendency/correlation/preference need ≥2 sources) | finish_consolidation sentinel tool emitted by specialists ends dream early`
- **Depends-on**: `E-PRIME-T05` (bitemporal + 4-network for OMNI typing)

### Phase 6.4 — Reconciler HARDEN

- **Task ID (proposed)**: `T06.4`
- **Title**: `PSYCHE 6.4 — Reconciler: sync_state decoupling + MessageEmbedding sibling table + times_derived + DLQ`
- **Kind**: `work` | **Severity**: `P1` | **Size**: `large`
- **Files**: `packages/core/src/memory/brain-reconciler.ts`, `packages/core/src/memory/brain-migration.ts`, `packages/core/src/sentient/reconcile-scheduler.ts` (NEW), `packages/cleo/src/commands/memory/dlq.ts` (NEW)
- **Acceptance**: `Reconciler audit produced | sync_state column added to brain_observations (decoupled embedding pattern) | brain_observation_embeddings sibling table replaces inline embedding storage | times_derived counter on brain_observations + increment in derivation worker | T1139 decision-supersession scope absorbed (single reconciler entry point) | syncVectorIndex re-embeds dirty observations | rebuildEmbeddings supports per-peer scoping | Dead-letter queue ops: list/retry/purge via brain_derivation_queue WHERE status='failed' | sentient/reconcile-scheduler.ts ticks periodically + on-demand | cleo memory dlq list|retry|purge CLI verbs`
- **Depends-on**: `T06.2` (derivation queue + status='failed' rows feed DLQ), `E-PRIME-T05` (bitemporal columns)

### Phase 6.5 — Structural Fast-Path

- **Task ID (proposed)**: `T06.5`
- **Title**: `PSYCHE 6.5 — Split runConsolidation into runStructuralDream + runSemanticDream; tick fallback when LLM offline`
- **Kind**: `work` | **Severity**: `P1` | **Size**: `medium`
- **Files**: `packages/core/src/memory/brain-lifecycle.ts`, `packages/core/src/memory/sleep-consolidation.ts`, `packages/core/src/sentient/tick.ts`, `packages/core/src/memory/dream-cycle.ts`
- **Acceptance**: `runConsolidation split into runStructuralDream (steps 1-5 + 9b/9c, no LLM) and runSemanticDream (full LLM pipeline) | runStructuralDream tested with CLEO_LLM_OFFLINE=1 | Sentient tick auto-dispatches structural when unconsolidatedObservationCount > 50 even if LLM unreachable | Existing runConsolidation entry kept as compatibility wrapper that calls both`
- **Depends-on**: `T06.3` (specialist surprisal scoring required by semantic path)

---

## 6. Subtask Decomposition

> Convention: `T06.<phase>.<group>.<n>` — group numbers are not strict waves; the lead may parallelize within a phase.

### 6.A — AUDITS (parallel, no code changes — produce markdown reports)

| ID | Title | Files (output) | Acceptance | Evidence | Deps | Size |
|----|-------|----------------|------------|----------|------|------|
| T06.A.1 | Audit `dialectic-evaluator.ts` for tool-loop gaps | `docs/plans/cleo-prime-decomposition/audits/T06-A1-dialectic-audit.md` | Report enumerates: (a) current output mode (schema vs tools), (b) gaps vs Honcho 7-tool DIALECTIC_TOOLS, (c) gaps vs DIALECTIC_TOOLS_MINIMAL, (d) absence/presence of reasoning-level routing, (e) per-level MAX_TOOL_ITERATIONS gap, (f) line-anchored remediation plan | `files:docs/plans/cleo-prime-decomposition/audits/T06-A1-dialectic-audit.md;note:audit only` | — | small |
| T06.A.2 | Audit `surprisal-tree.ts` for 7-strategy parity | `docs/plans/cleo-prime-decomposition/audits/T06-A2-surprisal-tree-audit.md` | Report ranks each of 7 strategies (CoverTree, RPTree, LSH, KDTree, BallTree, Prototype, Graph) as IMPLEMENTED / PARTIAL / MISSING with line refs; factory pattern present/absent; env-selector design proposal | `files:docs/plans/cleo-prime-decomposition/audits/T06-A2-surprisal-tree-audit.md;note:audit only` | — | small |
| T06.A.3 | Audit `surprisal.ts` for Bayesian-prior gap | `docs/plans/cleo-prime-decomposition/audits/T06-A3-surprisal-audit.md` | Report identifies: cosine vs Bayesian update over brain_patterns (cosine>0.8 prior); temporal decay coefficient; NEUTRAL_SURPRISAL fallback semantics; remediation plan | `files:docs/plans/cleo-prime-decomposition/audits/T06-A3-surprisal-audit.md;note:audit only` | — | small |
| T06.A.4 | Audit `brain-reconciler.ts` for DLQ / sync_state / sibling-embedding gaps | `docs/plans/cleo-prime-decomposition/audits/T06-A4-reconciler-audit.md` | Report enumerates: supersession coverage (4 tables observed), `syncVectorIndex` absence, `rebuildEmbeddings` absence, DLQ absence, decoupled-embedding pattern absence, T1139 decision-supersession absorption status | `files:docs/plans/cleo-prime-decomposition/audits/T06-A4-reconciler-audit.md;note:audit only` | — | small |
| T06.A.5 | Audit `specialists.ts` vs Honcho's deduction/induction sequential model | `docs/plans/cleo-prime-decomposition/audits/T06-A5-specialists-audit.md` | Report: current dispatch model (parallel? sequential?), 2-evidence rule presence on InductionSpecialist, OMNI dream-type alignment, sentinel `finish_consolidation` integration | `files:docs/plans/cleo-prime-decomposition/audits/T06-A5-specialists-audit.md;note:audit only` | — | small |
| T06.A.6 | Audit `brain-lifecycle.ts:runConsolidation` for LLM-coupling per step | `docs/plans/cleo-prime-decomposition/audits/T06-A6-lifecycle-audit.md` | Report: per-step LLM dependency matrix (steps 1-9), splittable subset for structural fast-path, current `runConsolidation` signature + entry points to preserve for back-compat | `files:docs/plans/cleo-prime-decomposition/audits/T06-A6-lifecycle-audit.md;note:audit only` | — | small |

### 6.B — DERIVATION QUEUE (Phase 6.2)

| ID | Title | Files | Acceptance | Evidence | Deps | Size |
|----|-------|-------|------------|----------|------|------|
| T06.B.1 | Drizzle migration: `brain_derivation_queue` | `packages/core/src/memory/brain-migration.ts`, `packages/contracts/src/memory.ts` (BrainDerivationQueueRow) | Columns: `id INTEGER PK, work_unit_key TEXT UNIQUE, session_id TEXT, turn_id TEXT, observed TEXT, observers_json TEXT, status TEXT CHECK IN ('pending','processing','done','failed'), attempts INTEGER DEFAULT 0, last_error TEXT, claim_token TEXT, claimed_by TEXT, claimed_at TEXT, enqueued_at TEXT NOT NULL, completed_at TEXT, heartbeat_at TEXT`; idx on `(status, enqueued_at)`; idx on `work_unit_key` | `commit:<sha>;files:packages/core/src/memory/brain-migration.ts;tool:test` | T06.A.4 | small |
| T06.B.2 | Drizzle migration: `brain_observation_embeddings` sibling table | `packages/core/src/memory/brain-migration.ts`, `packages/contracts/src/memory.ts` (BrainObservationEmbeddingRow) | Columns: `observation_id INTEGER FK, model TEXT, dim INTEGER, vector BLOB, created_at TEXT, PRIMARY KEY (observation_id, model)`; existing inline embedding column on `brain_observations` deprecated (kept for rollback, new writes go to sibling); idx on `model` | `commit:<sha>;files:packages/core/src/memory/brain-migration.ts;tool:test` | T06.A.4 | small |
| T06.B.3 | Drizzle migration: add `sync_state`, `times_derived` columns | `packages/core/src/memory/brain-migration.ts` | `brain_observations.sync_state TEXT DEFAULT 'pending' CHECK IN ('pending','syncing','synced','failed')`; `brain_observations.times_derived INTEGER DEFAULT 0`; idx on `sync_state` for reconciler scan | `commit:<sha>;files:packages/core/src/memory/brain-migration.ts;tool:test` | T06.B.2 | small |
| T06.B.4 | `derivation-queue.ts` — enqueue + claim + complete API | `packages/core/src/memory/derivation-queue.ts` (NEW) | `enqueue(workUnitKey, payload)` upserts row | `claim(workerId)` returns oldest pending via `BEGIN IMMEDIATE` + `UPDATE … WHERE status='pending' AND id=(SELECT MIN(id) …) RETURNING *` pattern | `complete(claimToken)` sets status='done' | `fail(claimToken, error)` increments attempts, sets status='failed' after attempts ≥ 5 | All API exports TSDoc-documented | `commit:<sha>;files:packages/core/src/memory/derivation-queue.ts;tool:test;tool:typecheck` | T06.B.1 | medium |
| T06.B.5 | `ActiveQueueSession`-equivalent SQLite concurrency primitive | `packages/core/src/memory/derivation-queue.ts` (extend), `packages/core/src/memory/__tests__/derivation-queue-concurrency.test.ts` (NEW) | Two simulated workers contending for same work_unit_key — exactly one claim succeeds; STALE_SESSION_TIMEOUT_MINUTES=5 expires stale heartbeat; expired claim re-acquirable by second worker | `commit:<sha>;files:packages/core/src/memory/derivation-queue.ts;tool:test;test-run:.cleo/cache/evidence/T06-B5-contend.json` | T06.B.4 | medium |
| T06.B.6 | `WorkerOwnership` heartbeat loop | `packages/core/src/memory/derivation-queue.ts` (extend) | Worker writes `heartbeat_at = now()` every 30s while processing; missing heartbeat for >5min flagged stale by `reaper()` | `commit:<sha>;files:packages/core/src/memory/derivation-queue.ts;tool:test` | T06.B.5 | small |
| T06.B.7 | `derivation-worker.ts` — standalone daemon process | `packages/core/src/memory/derivation-worker.ts` (NEW) | Long-running loop: `claim → process → embed → enqueue dialectic eval → complete`; SIGTERM graceful shutdown returns claimed work to pending | `commit:<sha>;files:packages/core/src/memory/derivation-worker.ts;tool:test` | T06.B.6 | medium |
| T06.B.8 | Mid-run kill + restart integration test | `packages/core/src/memory/__tests__/derivation-queue-restart.test.ts` (NEW) | Spawn worker, enqueue 10 items, SIGKILL after first claim, restart worker, verify exactly-once completion (no double-write to `brain_observations`) | `commit:<sha>;files:packages/core/src/memory/__tests__/derivation-queue-restart.test.ts;tool:test;test-run:.cleo/cache/evidence/T06-B8-restart.json` | T06.B.7 | medium |
| T06.B.9 | Exponential backoff + DLQ promotion at max attempts | `packages/core/src/memory/derivation-queue.ts` (extend) | Backoff: `nextRetryAt = now + (2^attempts × 30s)` with jitter; at attempts=5 status→'failed' (DLQ); unit-tested for all 5 attempt counts | `commit:<sha>;files:packages/core/src/memory/derivation-queue.ts;tool:test` | T06.B.6 | small |
| T06.B.10 | `times_derived` counter increment in worker | `packages/core/src/memory/derivation-worker.ts` (extend) | When worker derives same observation already linked to a brain_decision/learning/pattern, increment `brain_observations.times_derived` rather than creating duplicate; unit test asserts counter=2 after second derivation | `commit:<sha>;files:packages/core/src/memory/derivation-worker.ts;tool:test` | T06.B.3, T06.B.7 | small |
| T06.B.11 | `QUEUE_EMPTY` webhook event | `packages/core/src/memory/derivation-queue.ts` (extend), `packages/core/src/sentient/events.ts` (extend) | After `complete()`, if `SELECT COUNT(*) WHERE status IN ('pending','processing') = 0` → publish `QUEUE_EMPTY` event to sentient event bus; subscriber test verifies | `commit:<sha>;files:packages/core/src/memory/derivation-queue.ts;tool:test` | T06.B.4 | small |
| T06.B.12 | CLI: `cleo memory derive-worker --watch` | `packages/cleo/src/commands/memory/derive-worker.ts` (NEW), `packages/cleo/src/cli.ts` (register) | `--watch` runs persistent worker loop; `--once` drains queue then exits; `--workers <n>` spawns n workers (bounded by per-resource semaphore = 5 per §16.C `safe_create_task`); --json emits envelope | `commit:<sha>;files:packages/cleo/src/commands/memory/derive-worker.ts;tool:test;tool:lint` | T06.B.7 | medium |
| T06.B.13 | `cleo memory status --watch` shows QUEUE_EMPTY | `packages/cleo/src/commands/memory/status.ts` (extend) | Polls queue depth; renders `pending/processing/done/failed` counts; on QUEUE_EMPTY event prints "QUEUE_EMPTY — memory current, safe to query" | `commit:<sha>;files:packages/cleo/src/commands/memory/status.ts;tool:test` | T06.B.11 | small |

### 6.C — DIALECTIC HARDEN (Phase 6.1)

| ID | Title | Files | Acceptance | Evidence | Deps | Size |
|----|-------|-------|------------|----------|------|------|
| T06.C.1 | Define `DialecticTools` registry type in contracts | `packages/contracts/src/memory.ts` (extend) | `type DialecticToolName = 'search_memory' \| 'search_messages' \| 'get_observation_context' \| 'grep_messages' \| 'get_messages_by_date_range' \| 'search_messages_temporal' \| 'get_reasoning_chain' \| 'extract_preferences'`; `type ReasoningLevel = 'minimal'\|'low'\|'medium'\|'high'\|'max'`; `MAX_TOOL_ITERATIONS` const map | `commit:<sha>;files:packages/contracts/src/memory.ts;tool:test;tool:typecheck` | T06.A.1 | small |
| T06.C.2 | Implement `search_memory` tool | `packages/core/src/memory/dialectic-tools/search-memory.ts` (NEW) | Two parallel semantic searches per query (explicit + derived observations); returns top-k=10; cap by `level=='explicit'` filter when on 50-threshold path | `commit:<sha>;files:packages/core/src/memory/dialectic-tools/search-memory.ts;tool:test` | T06.C.1 | small |
| T06.C.3 | Implement `search_messages` tool | `packages/core/src/memory/dialectic-tools/search-messages.ts` (NEW) | Hybrid text+semantic search over `brain_transcript_events` (or session-memory store); top-k=20; returns message_id, content, score | `commit:<sha>;files:packages/core/src/memory/dialectic-tools/search-messages.ts;tool:test` | T06.C.1 | small |
| T06.C.4 | Implement `get_observation_context` tool | `packages/core/src/memory/dialectic-tools/get-observation-context.ts` (NEW) | Given observation_id, return: source provenance, peer scope, session, surrounding observations within ±2 turns | `commit:<sha>;files:packages/core/src/memory/dialectic-tools/get-observation-context.ts;tool:test` | T06.C.1 | small |
| T06.C.5 | Implement `grep_messages` tool | `packages/core/src/memory/dialectic-tools/grep-messages.ts` (NEW) | Regex search via FTS5 MATCH or LIKE fallback over transcript table | `commit:<sha>;files:packages/core/src/memory/dialectic-tools/grep-messages.ts;tool:test` | T06.C.1 | small |
| T06.C.6 | Implement `get_messages_by_date_range` tool | `packages/core/src/memory/dialectic-tools/get-messages-by-date-range.ts` (NEW) | ISO-8601 range; bounded result count (default 50); time-ordered ascending | `commit:<sha>;files:packages/core/src/memory/dialectic-tools/get-messages-by-date-range.ts;tool:test` | T06.C.1 | small |
| T06.C.7 | Implement `search_messages_temporal` tool | `packages/core/src/memory/dialectic-tools/search-messages-temporal.ts` (NEW) | Combines temporal + semantic; weights recent messages higher via recency boost; consumes Tier 5.1 `valid_at` if available | `commit:<sha>;files:packages/core/src/memory/dialectic-tools/search-messages-temporal.ts;tool:test` | T06.C.1, `E-PRIME-T05` | small |
| T06.C.8 | Implement `get_reasoning_chain` tool — premises↔conclusions DAG | `packages/core/src/memory/dialectic-tools/get-reasoning-chain.ts` (NEW) | Traverses `Document.source_ids` (CLEO equivalent: `brain_observation_links` or `provenanceChain`); returns ordered list of premises → conclusion edges with confidence at each hop; depth-cap=5 | `commit:<sha>;files:packages/core/src/memory/dialectic-tools/get-reasoning-chain.ts;tool:test` | T06.C.1 | medium |
| T06.C.9 | Implement `extract_preferences` tool — batch-embed-dedupe | `packages/core/src/memory/dialectic-tools/extract-preferences.ts` (NEW) | Accepts candidate preference list (text[]); batch-embeds; deduplicates via cosine ≥ 0.85 against existing peer-card PREFERENCE: rows; returns net-new only | `commit:<sha>;files:packages/core/src/memory/dialectic-tools/extract-preferences.ts;tool:test` | T06.C.1 | medium |
| T06.C.10 | 7-tool dispatch loop in `dialectic-evaluator.ts` (medium/high/max) | `packages/core/src/memory/dialectic-evaluator.ts` (extend) | `evaluateDialectic(turn, {level: 'medium'\|'high'\|'max'})` runs tool-loop with MAX_TOOL_ITERATIONS = 4/5/10 respectively; consumes `tool-loop.ts` (W4-shipped); short-circuit on `finish_consolidation` sentinel; existing schema-output mode retained as fallback when LLM returns no tool_use | `commit:<sha>;files:packages/core/src/memory/dialectic-evaluator.ts;tool:test` | T06.C.2..9 | medium |
| T06.C.11 | 2-tool minimal dispatch in `dialectic-evaluator.ts` (minimal/low) | `packages/core/src/memory/dialectic-evaluator.ts` (extend) | `evaluateDialectic(turn, {level: 'minimal'\|'low'})` exposes only `search_memory`, `search_messages`; MAX_TOOL_ITERATIONS = 1/2; structured-output preferred over tools | `commit:<sha>;files:packages/core/src/memory/dialectic-evaluator.ts;tool:test` | T06.C.10 | small |
| T06.C.12 | Wire dialectic to derivation worker | `packages/core/src/memory/derivation-worker.ts` (extend) | Worker, after observation persistence, enqueues dialectic eval onto same `brain_derivation_queue` (work_unit_key includes `:dialectic` suffix); evaluator runs in worker context not request path | `commit:<sha>;files:packages/core/src/memory/derivation-worker.ts;tool:test` | T06.C.10, T06.B.7 | small |
| T06.C.13 | Integration test: seeded session → DialecticInsights round-trip | `packages/core/src/memory/__tests__/dialectic-integration.test.ts` (NEW) | Fixture: 20 observations across 3 sessions, 1 active peer; assert `globalTraits[].confidence ≥ 0.6`, `peerInsights[].confidence ≥ 0.5`, `sessionNarrativeDelta` populated | `commit:<sha>;files:packages/core/src/memory/__tests__/dialectic-integration.test.ts;tool:test;test-run:.cleo/cache/evidence/T06-C13-dialectic.json` | T06.C.10, T06.C.11 | medium |

### 6.D — DREAMER HARDEN (Phase 6.3)

| ID | Title | Files | Acceptance | Evidence | Deps | Size |
|----|-------|-------|------------|----------|------|------|
| T06.D.1 | Surprisal-tree factory skeleton | `packages/core/src/memory/surprisal-tree.ts` (extend) | `buildSurprisalTree(observations, opts: {strategy: TreeStrategy})` dispatches to per-strategy builder; existing `RPTree` flow refactored into `buildRPTree()`; tests assert factory dispatch | `commit:<sha>;files:packages/core/src/memory/surprisal-tree.ts;tool:test` | T06.A.2 | small |
| T06.D.2 | Implement `CoverTree` strategy | `packages/core/src/memory/surprisal-trees/cover-tree.ts` (NEW) | Cover-tree partitioning with level invariant; expanding/shrinking via `cover_factor`; unit tests on 50-obs fixture | `commit:<sha>;files:packages/core/src/memory/surprisal-trees/cover-tree.ts;tool:test` | T06.D.1 | medium |
| T06.D.3 | Implement `LSH` (Locality-Sensitive Hashing) strategy | `packages/core/src/memory/surprisal-trees/lsh.ts` (NEW) | Random hyperplane LSH with `numHashTables`, `numHashBits`; buckets stored in brain_memory_trees with `strategy='lsh'` marker | `commit:<sha>;files:packages/core/src/memory/surprisal-trees/lsh.ts;tool:test` | T06.D.1 | medium |
| T06.D.4 | Implement `KDTree` strategy | `packages/core/src/memory/surprisal-trees/kd-tree.ts` (NEW) | Median-split KD-tree on embedding dims; nearest-neighbor lookup `O(log n)` average | `commit:<sha>;files:packages/core/src/memory/surprisal-trees/kd-tree.ts;tool:test` | T06.D.1 | medium |
| T06.D.5 | Implement `BallTree` strategy | `packages/core/src/memory/surprisal-trees/ball-tree.ts` (NEW) | Hypersphere partitioning via centroid + radius; handles non-Euclidean cosine distance | `commit:<sha>;files:packages/core/src/memory/surprisal-trees/ball-tree.ts;tool:test` | T06.D.1 | medium |
| T06.D.6 | Implement `Prototype` strategy | `packages/core/src/memory/surprisal-trees/prototype.ts` (NEW) | k-medoids-style prototype tree; configurable `k` prototypes per level | `commit:<sha>;files:packages/core/src/memory/surprisal-trees/prototype.ts;tool:test` | T06.D.1 | medium |
| T06.D.7 | Implement `Graph` strategy | `packages/core/src/memory/surprisal-trees/graph.ts` (NEW) | Approximate-NN graph (HNSW-like simplified); edges persisted to `brain_memory_trees` with edge metadata | `commit:<sha>;files:packages/core/src/memory/surprisal-trees/graph.ts;tool:test` | T06.D.1 | medium |
| T06.D.8 | Env-selector `CLEO_SURPRISAL_TREE_STRATEGY` | `packages/core/src/memory/surprisal-tree.ts` (extend), `packages/contracts/src/config.ts` | Env var resolves to strategy enum; default = `rp-tree` (preserves current behavior); invalid value → typed error with `fix:` hint; documented in `cleo config get` output | `commit:<sha>;files:packages/core/src/memory/surprisal-tree.ts;tool:test` | T06.D.2..7 | small |
| T06.D.9 | Strategy-parity acceptance test | `packages/core/src/memory/__tests__/surprisal-tree-parity.test.ts` (NEW) | Same 100-observation fixture run through each of 7 strategies; assert: (a) each completes without error, (b) tree depth > 0, (c) leaf_ids cover all observations, (d) per-strategy query latency < 100ms | `commit:<sha>;files:packages/core/src/memory/__tests__/surprisal-tree-parity.test.ts;tool:test;test-run:.cleo/cache/evidence/T06-D9-parity.json` | T06.D.8 | medium |
| T06.D.10 | Bayesian-prior update over `brain_patterns` in `surprisal.ts` | `packages/core/src/memory/surprisal.ts` (extend) | When `cosineSimilarity(obs, pattern_centroid) > 0.8`, treat pattern as prior; `posterior = bayesianUpdate(prior, likelihood)`; result feeds `SurprisalResult.score` (high → bypass rate limit per Honcho) | `commit:<sha>;files:packages/core/src/memory/surprisal.ts;tool:test` | T06.A.3 | medium |
| T06.D.11 | High-surprisal rate-limit bypass | `packages/core/src/memory/surprisal.ts` (extend) | `SurprisalResult.bypassRateLimit: boolean` = true when score > 0.85; consumed by sleep-consolidation specialist dispatch loop | `commit:<sha>;files:packages/core/src/memory/surprisal.ts;tool:test` | T06.D.10 | small |
| T06.D.12 | OMNI dream type — sequential deduction → induction phases | `packages/core/src/memory/sleep-consolidation.ts` (extend), `packages/core/src/memory/specialists.ts` (extend) | Single dream cycle runs `DeductionSpecialist` first, awaits completion, then `InductionSpecialist`; induction reads deduction outputs; integration test asserts dispatch order | `commit:<sha>;files:packages/core/src/memory/sleep-consolidation.ts;tool:test` | T06.A.5 | medium |
| T06.D.13 | 2-evidence rule on `InductionSpecialist` | `packages/core/src/memory/specialists.ts` (extend) | InductionSpecialist emits `tendency`/`correlation`/`preference` ONLY when ≥2 source conclusions exist for the inferred pattern; 1-source case → skipped (logged); unit tests cover both branches | `commit:<sha>;files:packages/core/src/memory/specialists.ts;tool:test` | T06.D.12 | small |
| T06.D.14 | `UserPreferenceSpecialist` harden — wire `extract_preferences` tool | `packages/core/src/memory/specialists.ts` (extend) | Before INSERT, batch-embed and dedupe via `extract_preferences` tool (T06.C.9); skip duplicates; unit test on 5-candidate / 3-existing fixture | `commit:<sha>;files:packages/core/src/memory/specialists.ts;tool:test` | T06.C.9, T06.D.12 | small |
| T06.D.15 | `DecisionSpecialist` harden — link to brain_decisions provenance | `packages/core/src/memory/specialists.ts` (extend) | Each new decision links source observations via `provenanceChain`; reuses Tier 2.1 origin columns; unit test | `commit:<sha>;files:packages/core/src/memory/specialists.ts;tool:test` | T06.D.12 | small |
| T06.D.16 | `CodePatternSpecialist` harden — Nexus symbol cross-link | `packages/core/src/memory/specialists.ts` (extend) | Emits `brain_observation_links` rows tying pattern to `nexus_symbol_id` when symbol resolvable; falls back to text-only when not | `commit:<sha>;files:packages/core/src/memory/specialists.ts;tool:test` | T06.D.12 | small |
| T06.D.17 | `TaskOutcomeSpecialist` harden — task↔observation link | `packages/core/src/memory/specialists.ts` (extend) | On task complete event, attach outcome observation to `task_id` via brain_links; unit test | `commit:<sha>;files:packages/core/src/memory/specialists.ts;tool:test` | T06.D.12 | small |
| T06.D.18 | 4-AND dream gate — `obs >= 50 explicit` clause | `packages/core/src/memory/dream-cycle.ts` (extend) | Filter `level == 'explicit'` only (Honcho correction §16.G); count over `brain_observations WHERE level='explicit' AND created_at > lastDreamAt`; unit test on fixture | `commit:<sha>;files:packages/core/src/memory/dream-cycle.ts;tool:test` | T06.A.6 | small |
| T06.D.19 | 4-AND dream gate — `hours >= 8` clause | `packages/core/src/memory/dream-cycle.ts` (extend) | `(now - lastDreamAt) >= 8h`; unit test with mocked clock | `commit:<sha>;files:packages/core/src/memory/dream-cycle.ts;tool:test` | T06.A.6 | small |
| T06.D.20 | 4-AND dream gate — `idle_minutes >= 60` clause | `packages/core/src/memory/dream-cycle.ts` (extend) | `(now - lastTaskCompleteAt) >= 60min`; unit test | `commit:<sha>;files:packages/core/src/memory/dream-cycle.ts;tool:test` | T06.A.6 | small |
| T06.D.21 | 4-AND dream gate — `no_pending_dream_for_collection` (4th clause) | `packages/core/src/memory/dream-cycle.ts` (extend) | SELECT from `brain_consolidation_events WHERE status='pending' AND collection=:peerId` returns 0 rows; unit test | `commit:<sha>;files:packages/core/src/memory/dream-cycle.ts;tool:test` | T06.A.6 | small |
| T06.D.22 | 4-AND dream gate — integration test (4 failure cases) | `packages/core/src/memory/__tests__/dream-gate.test.ts` (NEW) | 4 sub-cases: (a) obs<50 blocks, (b) hours<8 blocks, (c) idle<60min blocks, (d) pending-dream blocks; (e) all 4 satisfied → dispatches; (f) `--force` bypasses all | `commit:<sha>;files:packages/core/src/memory/__tests__/dream-gate.test.ts;tool:test;test-run:.cleo/cache/evidence/T06-D22-gate.json` | T06.D.18..21 | medium |
| T06.D.23 | CLI: `cleo memory dream --force` bypass | `packages/cleo/src/commands/memory/dream.ts` (extend) | `--force` skips all 4 AND-conditions, dispatches dream immediately; logs override to audit log per ADR-051 | `commit:<sha>;files:packages/cleo/src/commands/memory/dream.ts;tool:test` | T06.D.22 | small |
| T06.D.24 | `finish_consolidation` sentinel tool | `packages/core/src/memory/dialectic-tools/finish-consolidation.ts` (NEW), `packages/core/src/memory/sleep-consolidation.ts` (extend) | Sentinel tool callable from specialist context; when emitted, dream cycle ends early without running remaining specialists; unit test verifies early-exit | `commit:<sha>;files:packages/core/src/memory/dialectic-tools/finish-consolidation.ts;tool:test` | T06.D.12 | small |
| T06.D.25 | Dedup-via-tree dream cycle integration test (≥50% reduction) | `packages/core/src/memory/__tests__/dream-dedup.test.ts` (NEW) | Seed 200 `brain_patterns` rows with 50% controlled duplicates; run full dream cycle; assert post-run row count ≤ 100; assert no high-quality patterns lost | `commit:<sha>;files:packages/core/src/memory/__tests__/dream-dedup.test.ts;tool:test;test-run:.cleo/cache/evidence/T06-D25-dedup.json` | T06.D.9, T06.D.22 | medium |

### 6.E — RECONCILER HARDEN (Phase 6.4)

| ID | Title | Files | Acceptance | Evidence | Deps | Size |
|----|-------|-------|------------|----------|------|------|
| T06.E.1 | `syncVectorIndex` — re-embed dirty observations | `packages/core/src/memory/brain-reconciler.ts` (extend) | Scans `WHERE sync_state='pending' OR sync_state='failed'`; embeds via embedding-worker; writes `brain_observation_embeddings` sibling row; sets `sync_state='synced'`; resilient to embedder downtime (failures retry next cycle) | `commit:<sha>;files:packages/core/src/memory/brain-reconciler.ts;tool:test` | T06.B.2, T06.B.3 | medium |
| T06.E.2 | `rebuildEmbeddings` — per-peer scoped rebuild | `packages/core/src/memory/brain-reconciler.ts` (extend) | `rebuildEmbeddings(brainDb, {peerIds?: string[]})`; sets `sync_state='pending'` for all observations of given peers; reconciler picks up next tick | `commit:<sha>;files:packages/core/src/memory/brain-reconciler.ts;tool:test` | T06.E.1 | small |
| T06.E.3 | Reconciler purges superseded embedding rows | `packages/core/src/memory/brain-reconciler.ts` (extend) | When source observation `invalid_at IS NOT NULL`, DELETE from `brain_observation_embeddings WHERE observation_id=…`; tracked counter `embeddingsPurged` returned in `ReconcilerResult` | `commit:<sha>;files:packages/core/src/memory/brain-reconciler.ts;tool:test` | T06.E.1 | small |
| T06.E.4 | T1139 decision-supersession scope absorbed | `packages/core/src/memory/brain-reconciler.ts` (extend) | Pulls T1139 logic from any standalone module into `applySupersessionPass`; decision supersession edges use same `invalid_at = now()` write pattern as other tables; unit test parity | `commit:<sha>;files:packages/core/src/memory/brain-reconciler.ts;tool:test` | T06.A.4 | small |
| T06.E.5 | `MessageEmbedding`-style writer migration | `packages/core/src/memory/brain-embedding.ts` (extend) | All new embedding writes go to `brain_observation_embeddings` not inline column; inline column kept for rollback period (1 release); migration script populates sibling from inline for historical rows | `commit:<sha>;files:packages/core/src/memory/brain-embedding.ts;tool:test` | T06.B.2 | small |
| T06.E.6 | `reconcile-scheduler.ts` — sentient periodic + on-demand | `packages/core/src/sentient/reconcile-scheduler.ts` (NEW), `packages/core/src/sentient/tick.ts` (extend) | Schedules `runReconciler()` every N sentient ticks (configurable); also exposes `triggerReconcile()` for on-demand; respects kill-switch | `commit:<sha>;files:packages/core/src/sentient/reconcile-scheduler.ts;tool:test` | T06.E.1..4 | medium |
| T06.E.7 | DLQ list operation + CLI: `cleo memory dlq list` | `packages/cleo/src/commands/memory/dlq.ts` (NEW) | Lists `brain_derivation_queue WHERE status='failed'` with pagination; envelope output; `--json` flag | `commit:<sha>;files:packages/cleo/src/commands/memory/dlq.ts;tool:test;tool:lint` | T06.B.9 | small |
| T06.E.8 | DLQ retry operation + CLI: `cleo memory dlq retry` | `packages/cleo/src/commands/memory/dlq.ts` (extend) | `cleo memory dlq retry <id>` resets `status='pending'`, `attempts=0`; `--all` retries every failed row; unit test | `commit:<sha>;files:packages/cleo/src/commands/memory/dlq.ts;tool:test` | T06.E.7 | small |
| T06.E.9 | DLQ purge operation + CLI: `cleo memory dlq purge` | `packages/cleo/src/commands/memory/dlq.ts` (extend) | `cleo memory dlq purge <id>` deletes row; `--all` purges all failed; `--older-than 7d` time-bounded; confirmation prompt unless `--yes` | `commit:<sha>;files:packages/cleo/src/commands/memory/dlq.ts;tool:test` | T06.E.7 | small |
| T06.E.10 | Reconciler tracked-counter integration test | `packages/core/src/memory/__tests__/reconciler-counter.test.ts` (NEW) | Seed scenario: 10 observations with 3 contradictions; run reconciler; assert `embeddingsPurged ≥ 3`, `supersededIds.observations.length ≥ 3` | `commit:<sha>;files:packages/core/src/memory/__tests__/reconciler-counter.test.ts;tool:test;test-run:.cleo/cache/evidence/T06-E10-purge.json` | T06.E.3 | medium |

### 6.F — STRUCTURAL FAST-PATH (Phase 6.5)

| ID | Title | Files | Acceptance | Evidence | Deps | Size |
|----|-------|-------|------------|----------|------|------|
| T06.F.1 | Split `runConsolidation` → `runStructuralDream` + `runSemanticDream` | `packages/core/src/memory/brain-lifecycle.ts` (extend) | `runStructuralDream(projectRoot, sessionId)` runs steps 1-5 + 9b/9c (dedup, quality recompute, tier promotion — no LLM); `runSemanticDream(projectRoot, sessionId)` runs full LLM pipeline (specialists, dialectic); existing `runConsolidation` becomes thin wrapper that calls both for back-compat | `commit:<sha>;files:packages/core/src/memory/brain-lifecycle.ts;tool:test` | T06.A.6 | medium |
| T06.F.2 | Offline-mode unit test (`CLEO_LLM_OFFLINE=1`) | `packages/core/src/memory/__tests__/structural-offline.test.ts` (NEW) | With env `CLEO_LLM_OFFLINE=1`, call `runStructuralDream()`; assert: zero LLM API calls (mock asserts), `unconsolidatedObservationCount` reduces by dedup, no specialist invocations | `commit:<sha>;files:packages/core/src/memory/__tests__/structural-offline.test.ts;tool:test;test-run:.cleo/cache/evidence/T06-F2-offline.json` | T06.F.1 | medium |
| T06.F.3 | Sentient-tick auto-dispatch when LLM unreachable | `packages/core/src/sentient/tick.ts` (extend) | Tick condition: `unconsolidatedObservationCount > 50 && llmReachable() === false` → call `runStructuralDream`; logged to consolidation events; integration test mocks LLM failure | `commit:<sha>;files:packages/core/src/sentient/tick.ts;tool:test` | T06.F.1 | medium |
| T06.F.4 | `cleo memory dream --structural-only` CLI flag | `packages/cleo/src/commands/memory/dream.ts` (extend) | New flag forces `runStructuralDream` path even when LLM available; useful for fast iteration on dedup logic | `commit:<sha>;files:packages/cleo/src/commands/memory/dream.ts;tool:test` | T06.F.1 | small |

### 6.G — OBSERVABILITY + DOCS (cross-cutting)

| ID | Title | Files | Acceptance | Evidence | Deps | Size |
|----|-------|-------|------------|----------|------|------|
| T06.G.1 | `cleo memory psyche-status` aggregate dashboard | `packages/cleo/src/commands/memory/psyche-status.ts` (NEW) | One-shot status: queue depth, last-dream-at, surprisal-tree strategy, reconciler last-run, DLQ count, sync_state distribution | `commit:<sha>;files:packages/cleo/src/commands/memory/psyche-status.ts;tool:test` | T06.B.13, T06.E.6 | small |
| T06.G.2 | TSDoc + `forge-ts` coverage gate on new modules | `packages/core/src/memory/derivation-queue.ts`, `derivation-worker.ts`, `dialectic-tools/*.ts`, `surprisal-trees/*.ts`, `sentient/reconcile-scheduler.ts` | All exported symbols TSDoc-documented; `forge-ts check` returns 0 errors on the changed surface | `tool:typecheck;files:<changed surface>` | T06.B..T06.F | small |
| T06.G.3 | Update `docs/architecture/psyche-pipeline.md` (or create) | `docs/architecture/psyche-pipeline.md` | Diagrams the four stages (dialectic → derivation → dream → reconcile), the queue topology, the 7-strategy tree factory, the 4-AND gate; links to ADRs and Honcho source line refs | `commit:<sha>;files:docs/architecture/psyche-pipeline.md` | T06.B..T06.F | small |
| T06.G.4 | ADR-NEW — PSYCHE Pipeline canonical | `.cleo/adrs/ADR-XXX-psyche-pipeline.md` | Records: D-decision on tool-vs-schema dialectic split, D-decision on SQLite SKIP-LOCKED equivalent, D-decision on decoupled sync_state, D-decision on 4-AND gate (vs Honcho 3-AND), D-decision on OMNI single dream type | `commit:<sha>;files:.cleo/adrs/ADR-XXX-psyche-pipeline.md;decision:D-psyche-pipeline-001` | T06.G.3 | small |
| T06.G.5 | Memory observe — record audit findings to BRAIN | (no file — BRAIN write) | After all 6 audits land, `cleo memory observe` writes one summary observation per audit linking findings to follow-up subtasks | `note:6 BRAIN observations created;decision:D-psyche-audits` | T06.A.1..6 | small |

---

## 7. Summary Counts

| Group | Subtasks | Notes |
|-------|----------|-------|
| 6.A AUDITS | 6 | All small, parallel |
| 6.B DERIVATION QUEUE | 13 | 3 migrations + 4 core + 6 ops/CLI/tests |
| 6.C DIALECTIC HARDEN | 13 | 7 tool implementations + 4 wiring + 2 tests |
| 6.D DREAMER HARDEN | 25 | 7 tree strategies + factory + Bayesian + 4-AND gate (4 clauses + integration) + 6-specialist harden + sentinel + dedup test |
| 6.E RECONCILER HARDEN | 10 | sync_state + sibling-embedding + DLQ verbs + scheduler |
| 6.F STRUCTURAL FAST-PATH | 4 | split + offline test + tick dispatch + CLI flag |
| 6.G OBSERVABILITY + DOCS | 5 | dashboard + TSDoc + arch doc + ADR + BRAIN observe |
| **TOTAL** | **76** | within target 70-130 |

## 8. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SQLite SKIP-LOCKED equivalent races under high concurrency | medium | high | T06.B.5 explicit contend test; bound worker pool ≤5 via §16.C semaphore |
| 7 tree strategies each non-trivial; risk of shallow-ports | high | medium | Each strategy is its own subtask with parity test (T06.D.9); ship one at a time behind env-flag |
| Splitting `runConsolidation` breaks downstream consumers (cleo-os, sentient tick) | medium | high | Keep `runConsolidation` as thin wrapper (T06.F.1); changelog entry; integration test sweep |
| `brain_observation_embeddings` sibling-table migration is destructive if inline column dropped too early | low | high | Keep inline column for 1 release cycle (T06.E.5); migration writes both sources |
| `times_derived` increment under concurrent workers double-counts | medium | medium | Use `UPDATE … SET times_derived = times_derived + 1` atomic per-row; unit test T06.B.10 |
| Dialectic tool-loop runaway → infinite tool calls | medium | high | Hard cap MAX_TOOL_ITERATIONS per level (1/2/4/5/10); `finish_consolidation` sentinel; per-call timeout |
| 4-AND gate too restrictive — dreams never fire in low-activity projects | low | medium | `--force` bypass available; document tuning knobs (50/8h/60min thresholds env-overridable) |
| LLM offline structural-only mode produces low-quality dedup | low | low | Cap structural dedup to high-confidence cosine ≥ 0.95; specialist re-runs catch missed merges next semantic cycle |
| `brain_memory_trees` truncated each dream cycle — risk of mid-cycle reader race | medium | medium | Wrap truncate+populate in single transaction; readers see either old-tree or new-tree, never partial |
| Phase 6.2 (queue) blocks all downstream phases — critical path | high | high | Front-load 6.B; allow 6.A audits and 6.C tool implementations to start in parallel pre-queue |

## 9. Dependency Topology (high-level)

```
Audits (6.A)  ─┬─→  6.B (queue)  ─┬─→  6.C.12 (worker wires dialectic)
               │                  ├─→  6.D (dreamer)  ──┐
               ├─→  6.C (tools)  ──┴──→  6.C.10/11 ─────┤
               │                                         ├─→  6.F (split)  ─→ acceptance
               ├─→  6.E (reconciler)  ───────────────────┘
               └─→  6.G (docs + ADR)
```

External (consumed-by, not blocking this epic):
- `E-PRIME-T03` → 6.C (peer/session schema)
- `E-PRIME-T04` → 6.B (Mem0 V3 verdict)
- `E-PRIME-T05` → 6.C.7, 6.D, 6.E (bitemporal / network column)
- `E-PRIME-T07/08/09` consume PSYCHE outputs

## 10. Open Questions for Owner

1. **Tree strategy default** — RPTree today preserves existing behavior. Should default flip to CoverTree or Graph for sentience launch, or stay RPTree?
2. **Worker concurrency** — Honcho ships single-process derivation; should CLEO bound at 1 worker or default to 5 (semaphore-capped)?
3. **DLQ retention** — keep failed rows forever, or auto-purge after N days? (Owner's data-safety policy says backups exist via `cleo backup add`; suggest 30-day default.)
4. **Sibling-embedding column drop window** — 1 release (proposed) vs longer? Inline column carries non-trivial disk cost on large brain.db.
5. **`finish_consolidation` semantics** — Honcho's sentinel ends THIS dream. Should CLEO's sentinel also `--force`-block the next 4-AND check for N minutes to prevent thrash?
6. **Structural-only mode marker** — should observations consolidated via `runStructuralDream` carry a `consolidation_mode='structural'` flag for downstream audit?
7. **Dialectic level default** — Honcho defaults to `medium`. With CLEO's curator/aux-client rule (§16.B), should sentient-tick run at `minimal` to preserve main session cache?

---

## 11. Evidence Atom Cheat-Sheet (per ADR-051)

All subtasks MUST produce evidence per these patterns before `cleo complete`:

```bash
# Code change subtasks
cleo verify <T06.X.N> --gate implemented \
  --evidence "commit:<sha>;files:<file1>,<file2>"

# Test subtasks
cleo verify <T06.X.N> --gate testsPassed \
  --evidence "tool:test;test-run:.cleo/cache/evidence/<key>.json"

# Audit subtasks (markdown-only)
cleo verify <T06.A.N> --gate implemented \
  --evidence "files:docs/plans/cleo-prime-decomposition/audits/<file>.md;note:audit only"

# ADR/decision subtasks
cleo verify <T06.G.4> --gate implemented \
  --evidence "decision:D-psyche-pipeline-001;files:.cleo/adrs/ADR-XXX-psyche-pipeline.md"

# Quality gate (per package boundary check + biome + tsc)
cleo verify <T06.X.N> --gate qaPassed \
  --evidence "tool:lint;tool:typecheck"
```

## 12. Package-Boundary Check (per AGENTS.md)

| File path | Correct package |
|-----------|----------------|
| `packages/core/src/memory/derivation-queue.ts` | `core` (runtime primitive) |
| `packages/core/src/memory/derivation-worker.ts` | `core` (runtime primitive) |
| `packages/core/src/memory/dialectic-tools/*.ts` | `core` |
| `packages/core/src/memory/surprisal-trees/*.ts` | `core` |
| `packages/core/src/sentient/reconcile-scheduler.ts` | `core` |
| `packages/cleo/src/commands/memory/derive-worker.ts` | `cleo` (CLI dispatch only) |
| `packages/cleo/src/commands/memory/dlq.ts` | `cleo` (CLI dispatch only) |
| `packages/cleo/src/commands/memory/psyche-status.ts` | `cleo` (CLI dispatch only) |
| `packages/contracts/src/memory.ts` (extend) | `contracts` (shared types) |

All new code respects existing layering. Acceptance criterion on every subtask: *"Code placed in <packages/xxx/> per Package-Boundary Check — verified against AGENTS.md"*.

---

**END E-PRIME-T06**
