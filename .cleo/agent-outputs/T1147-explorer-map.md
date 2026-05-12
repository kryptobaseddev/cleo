# T1147 Wave 7 — Reconciler Extension + 2440-Entry BRAIN Noise Sweep
# Explorer Map

**Generated**: 2026-04-24 (read-only deep-mapping pass)
**Spine slot**: v2026.4.132 — depends on T1146 W6 (v2026.4.131)
**Council mandate**: shadow-write envelope + brain_v2_candidate staging + 100-entry stratified validation + self-healing gated off during sweep tx

> **NOTE for .132 orchestrator**: This map proposes W7-5 (provenanceClass on retrieval bundle), but per council reconciliation M6 lives on **T1260 E3 (.128)**, not W7. Filter W7-5 into "consume the M6 field that .128 added" rather than "add it from scratch". Sweep updates the field's VALUE (unswept→swept-clean); schema landed in .128.

---

## 1. Reconciler Current State

**No dedicated reconciler module exists** as of HEAD `1c6a87ca5`.

The reconciler concept is distributed across:

| File | Role |
|------|------|
| `packages/core/src/memory/brain-lifecycle.ts` | `applyTemporalDecay`, `runConsolidation` (multi-step: dedup → quality-recompute → tier-promotion → contradiction-detection → soft-eviction → graph-strengthening → summaries). Current reconciler home. |
| `packages/core/src/memory/brain-retrieval.ts` | `populateEmbeddings` (vector backfill, batch-processes brain_observations). Pattern: batched, idempotent, non-blocking. |
| `packages/core/src/store/memory-schema.ts` | `brainBackfillRuns` table (T1003 pattern) — staged/approved/rolled-back workflow. Closest prior-art for shadow-write envelope. |
| `packages/core/src/memory/extraction-gate.ts` | Content-hash dedup + cosine similarity gate before every BRAIN write. |

**T1139 supersession scope in code terms**: aimed to wire automatic supersession (newer decision contradicts older → mark older `invalidAt = now()`). Belongs in `runConsolidation` Step 5 (contradiction detection). Stub exists; auto-supersession write path is not implemented. T1147 absorbs by extending `runConsolidation` with a full supersession pass that calls the graph's `contradicts` edge to trigger `invalidAt` writes.

**Timer / trigger**: `runConsolidation` triggered by session-end hook (`trigger: 'session_end'`) and manual invocation. No standalone timer loop. W7 should add a scheduled reconciler pass driven by `brain_consolidation_events` (last-run timestamp stored there).

---

## 2. Brain DB Schema Surface

**Schema file**: `packages/core/src/store/memory-schema.ts` (~1713 lines)

### Tables relevant to the 2440-entry sweep

| Table | Sweep relevance |
|-------|-----------------|
| `brain_observations` | HIGH — most noise lives here (episodic, low-quality from older sessions) |
| `brain_learnings` | MEDIUM — speculative entries default to `short` tier |
| `brain_decisions` | LOW — generally higher quality; check `sourceConfidence = 'speculative'` |
| `brain_patterns` | LOW |
| `brain_page_nodes` | Derivative — swept as side-effect |
| `brain_backfill_runs` | NOT swept; used AS the sweep mechanism |

### Quality score filter (already encoded)

- `quality_score < 0.3` → excluded from search results (T531, `QUALITY_SCORE_THRESHOLD`)
- `verified = 0` AND `source_confidence = 'speculative'` → candidate noise
- `invalidAt IS NOT NULL` → already superseded (skip)

### brain_v2_candidate staging table — conceptual

```sql
CREATE TABLE brain_v2_candidate (
  id TEXT PRIMARY KEY,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  sweep_run_id TEXT NOT NULL,
  action TEXT NOT NULL,          -- 'purge' | 'reclassify' | 'promote' | 'keep'
  new_quality_score REAL,
  new_invalid_at TEXT,
  new_provenance_class TEXT,     -- 'swept-clean' | 'noise-purged' | 'unswept-pre-T1151'
  validation_status TEXT DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

Extends `brain_backfill_runs` pattern: one `brain_backfill_runs` row anchors the sweep (kind: `noise-sweep-2440`, status: `staged`); `brain_v2_candidate` rows hold per-entry action plan.

### Embedding write path

`brain-retrieval.ts:938-950` — `INSERT OR REPLACE INTO brain_embeddings (id, embedding) VALUES (?, ?)`. `brain_embeddings` is a `vec0` virtual table, not Drizzle-managed. Rebuild after sweep: for `action='purge'`, delete from `brain_embeddings`. For promoted entries, trigger `populateEmbeddings`.

### DLQ

No DLQ exists. `brain_backfill_runs.rolled-back` status is closest analog. Sweep entries failing 100-entry validation should remain in `brain_v2_candidate` with `validation_status = 'pending'` (owner review). Sweep run moves to `rolled-back`.

---

## 3. Shadow-Write Envelope Pattern

**Search results for "shadow-write"**: zero hits. Pattern doesn't exist under that name.

**Closest prior-art** — `brain_backfill_runs` (T1003 pattern, `memory-schema.ts:1525-1596`):

```
status: 'staged' → 'approved' | 'rolled-back'
rollbackSnapshotJson: string[]
approvedAt: ISO timestamp
approvedBy: agent or 'human'
```

**T1147 envelope flow**:

1. Open SQLite tx on `brain.db`.
2. Write candidate rows to `brain_v2_candidate`.
3. Write `brain_backfill_runs` row with `status: 'staged'`, `kind: 'noise-sweep-2440'`.
4. Commit (only staging committed; live tables untouched).
5. Present 100 stratified samples to validator.
6. On approval: open second tx, apply actions (`UPDATE brain_observations SET invalid_at = ?`, `DELETE FROM brain_embeddings WHERE id = ?`), update `brain_backfill_runs.status = 'approved'`, commit.
7. On rejection: `UPDATE brain_backfill_runs SET status = 'rolled-back'`, discard `brain_v2_candidate` rows.

**Deadlock risk**: SQLite WAL serializes writes. Risk is write-lock contention with concurrent `runConsolidation` (session-end), not true deadlock. Mitigation: keep cutover tx small (bulk UPDATE+DELETE, no cursor iteration) and run outside session-end hooks.

---

## 4. Self-Healing Gate

**Existing primitive**: `packages/core/src/sentient/kill-switch.ts`

Reads `.cleo/sentient-state.json` via `fs.watch` with 100ms debounce. Designed for Tier-3 merge ritual.

**T1151 Sentient Self-Healing** doesn't exist as code yet. Planned as dispatch-time reflex.

**"Self-healing gated off during sweep tx" options**:

- **Option A (simplest)**: Before opening sweep staging tx, write `{ "killSwitch": true, "activatedBy": "sweep-tx-gate", "activatedAt": "<ISO>" }` to `.cleo/sentient-state.json`. Restore to `false` after commit/rollback. Existing kill-switch watcher skips Tier-3 reflex.
- **Option B (cleaner for T1148 W8)**: Add `sweepLock` field to `.cleo/sentient-state.json`. Teach future Sentient v1 daemon to check `sweepLock` before self-healing.

**Recommendation**: Option A for T1147 (reuse existing primitive). Document Option B as a T1148 cleanup.

---

## 5. 2440-Entry BRAIN Noise Number

**No measurement script in repo.**

The 2440 figure appears in `MEMORY.md:67` as "2440 noise patterns" from prior BRAIN council. Likely derived from:

```sql
SELECT COUNT(*) FROM brain_observations WHERE quality_score < 0.3 OR quality_score IS NULL;
```

Or union across all four tables.

**Recommendation**: derive count dynamically at sweep execution time. 2440 is a planning estimate, not a contract.

**Stratified sample design** (100 entries, proportional):
- ~60 from `brain_observations`
- ~20 from `brain_learnings`
- ~10 from `brain_decisions`
- ~10 from `brain_patterns`

Sample criterion: `quality_score < 0.3 AND verified = 0 AND invalid_at IS NULL ORDER BY RANDOM() LIMIT N`.

---

## 6. Atomic Decomposition Proposal (8 worker tasks)

### W7-1: Reconciler core module (medium)
**Path**: `packages/core/src/memory/brain-reconciler.ts` (new)
**Acceptance**: Exports `runReconciler(projectRoot, options)` that extends `runConsolidation` with supersession pass (sets `invalidAt` on entries with `contradicts` edge weight > 0.8); T1139 auto-supersession detection; `brain_consolidation_events` trigger type `'reconciler'` added.

### W7-2: Shadow-write envelope infra (medium)
**Paths**: `packages/core/src/store/memory-schema.ts` (add `brain_v2_candidate`), new Drizzle migration
**Acceptance**: `brain_v2_candidate` table created via Drizzle migration (preserve timestamp); `brain_backfill_runs.kind` enum extended with `'noise-sweep-2440'`; `BrainV2CandidateRow` type exported from contracts.

### W7-3: Noise detector (medium)
**Path**: `packages/core/src/memory/brain-noise-detector.ts` (new)
**Acceptance**: Exports `detectNoiseCandidates(projectRoot, options)` querying all four brain_* tables with quality/verified filters, writes to `brain_v2_candidate`, returns counts by table; 100-entry stratified sample extraction function exported.

### W7-4: Sweep executor with self-healing gate (large)
**Path**: `packages/core/src/memory/brain-sweep-executor.ts` (new)
**Acceptance**: Opens SQLite tx; toggles `.cleo/sentient-state.json` killSwitch (or sweepLock if Option B) before tx; bulk UPDATE (`invalid_at`, `quality_score`) + DELETE from `brain_embeddings`; clears flag on commit/rollback; updates `brain_backfill_runs` status; logs to `brain_consolidation_events`.

### W7-5: provenanceClass VALUE updates from sweep (small)
**Note**: Schema/contract for `provenanceClass` lives in T1260 E3 (.128). W7 only updates VALUES.
**Path**: `packages/core/src/memory/brain-sweep-executor.ts`
**Acceptance**: For each `action='purge'`, set `new_provenance_class = 'noise-purged'`; for each `action='keep'`, set `new_provenance_class = 'swept-clean'`; cutover transaction propagates these values to live tables.

### W7-6: CLI surface (small)
**Path**: `packages/cleo/src/cli/commands/memory.ts` (or equivalent dispatch domain)
**Acceptance**: `cleo memory sweep --dry-run` triggers detector; `cleo memory sweep --approve <runId>` triggers executor; `cleo memory sweep --status` queries `brain_backfill_runs`; `cleo memory doctor --assert-clean` returns exit 0 when no `brain_v2_candidate` rows in `pending` state.

### W7-7: M7 gate wiring (small)
**Path**: `packages/cleo/src/commands/sentient/propose.ts` (or equivalent)
**Acceptance**: `cleo sentient propose enable` returns non-zero when `cleo memory doctor --assert-clean` exits non-zero — implemented as pre-flight check in propose-enable handler. Council mandate.

### W7-8: Integration test (medium)
**Path**: `packages/core/src/__tests__/brain-sweep-e2e.test.ts` (new)
**Acceptance**: E2E inserts 20 low-quality observations, runs sweep dry-run, asserts candidate count, approves, asserts `invalid_at` set on purged rows, asserts `buildRetrievalBundle` no longer returns purged entries; no `brain_embeddings` touched (vector not required in test env).

---

## 7. Risk Callouts

### R1: Shadow-write txn deadlock under WAL
SQLite WAL serializes writes. Concurrent `runConsolidation` (session-end) with sweep cutover tx → consolidation retries up to busy_timeout. **Mitigation**: `PRAGMA busy_timeout = 10000`; document sweep should not run while session active.

### R2: Vector sync OOM on 2440 entries
`populateEmbeddings` batches of 50. 2440 × 384-float × 4 bytes = ~3.7 MB live vectors (manageable). Local transformer model load may spike RSS > 2GB. **Mitigation**: W7-4 must NOT trigger `populateEmbeddings` for sweep; embedding rebuild is separate optional post-sweep step.

### R3: kill-switch co-option semantics
Option A repurposes `killSwitch` for sweep window — semantically ambiguous. **Mitigation**: add `sweepLock` field to `.cleo/sentient-state.json`; update reader to treat `sweepLock === true` same as `killSwitch === true` for Tier-3 ritual purposes. 5-line change.

### R4: brain_v2_candidate Drizzle migration timestamp
Per Lesson 3: deleting + regenerating creates new timestamp; journal rejects new folder. **Mitigation**: Generate migration once with `pnpm db:new`, keep timestamp, never regenerate.

### R5: 2440 count is stale
Number measured in prior session; live `brain.db` may have grown/shrunk. **Mitigation**: W7-3 recomputes actual count at execution; 100-entry sample proportional to actual count.

---

## Essential Files Reference

| File | Why essential |
|------|--------------|
| `packages/core/src/store/memory-schema.ts` | All brain_* table definitions; `brain_backfill_runs` is shadow-write prior art |
| `packages/core/src/memory/brain-retrieval.ts` | `buildRetrievalBundle` (M6 target — schema in .128, values updated by sweep), `observeBrain`, embedding write path |
| `packages/core/src/memory/brain-lifecycle.ts` | `runConsolidation` (reconciler current home), `applyTemporalDecay` |
| `packages/core/src/memory/extraction-gate.ts` | Quality gate before every BRAIN write |
| `packages/core/src/sentient/kill-switch.ts` | Self-healing gate primitive; `.cleo/sentient-state.json` shape |
| `packages/core/src/orchestration/hierarchy.ts` | Hardcoded legacy agent tree (T1258 E1 deletion target) |
| `packages/core/src/orchestration/index.ts` | Re-exports `OrchestrationHierarchyImpl` (barrel consumer) |
| `packages/core/src/sessions/briefing.ts` | Calls `buildRetrievalBundle`; provenance filter flows through here |
| `.cleo/agent-outputs/CAMPAIGN-2026-04-24-overnight-execution-plan.md` | Spine and execution rules |
| `.cleo/agent-outputs/T-COUNCIL-RECONCILIATION-2026-04-24/council-output.md` | Shadow-write envelope spec, M6/M7 binding gates |
| `.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md` | BRAIN-integrity insertion-point map |
