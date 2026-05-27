# E-PRIME-T07 / E-PRIME-T08b / E-PRIME-T09 — Integration Decomposition

> Planning artifact for CLEO Sentience Masterplan Tiers 7, 8.1+8.3, and 9.
> **Author**: cleo-prime planner (PLANNING-ONLY agent — no state mutated).
> **Source**: `/mnt/projects/cleocode/docs/plans/CLEO-PRIME-SENTIENT-MASTERPLAN.md` §5 Tier 7, §5 Tier 8.1+8.3, §5 Tier 9, §16.A.
> **Format**: CLEO ADR-066 task model (epic|task|subtask, kind, severity P0-P3, size, pipe-separated `--acceptance`, ADR-051 evidence atoms).
> **Anti-overlap**: Tiers 1-6, 8.2 (memory-git), 10-14 are dependencies only — never decomposed here.

Total: **3 epics → 16 phase tasks → ~115 atomic subtasks.**

---

## E-PRIME-T07 — Four-Bus Integration

### Identity

- **Kind**: epic / work
- **Severity**: P1 (foundational seam — blocks the "one nervous system" promise)
- **Size**: large
- **Parent**: PRIME masterplan (top-level)
- **Depends-on**: `E-PRIME-T03` (peer-graph for spawn injection — provides `canonicalPeerId`, peer-aware memory_blocks), `E-PRIME-T06` (BRAIN derivation/dream pipeline — produces the patterns/learnings that 7.1 reads), `T9245` (evidence-validator fix — prerequisite to trust any "shipped" claim that touches BRAIN/TASKS join).

### Vision

BRAIN ↔ NEXUS ↔ TASKS ↔ CONDUIT stop being parallel silos. Each spawn payload carries BRAIN evidence under a budget; each `nexus impact` carries memory evidence; each `tasks add` is advised by Nexus impact; wave completion publishes a brain-digest event; significant CONDUIT messages auto-ingest into BRAIN. Net: one nervous system, four buses.

### Acceptance Criteria (epic-level)

- `cleo orchestrate spawn <task> --dry-run` contains a `## Prior Context (from BRAIN)` section bounded to ≤ 1200 tokens.
- `cleo nexus impact <symbol> --json | jq .brainEvidence` returns ≥ 1 row when the symbol has linked decisions or observations.
- Wave completion publishes a `BrainDigestEvent` on `epic-<TID>.brain-digest` and a subscriber receives it within 5 s.
- `cleo memory find --source-type conduit-ingest` returns rows after a wave publishes a `decision` message.
- `cleo task plan --files a/x.ts,b/y.ts,c/z.ts` triggers `decomposition-impact-advisor.adviseDecomposition` and prints `shouldSplit + suggestedSplits`.
- No regression: all existing tests in `packages/core/src/{orchestrate,nexus,tasks,memory,conduit}/__tests__/` pass.

### Milestone Gates (measurable)

| Gate | Baseline | Target |
|---|---|---|
| G7.A | Spawn prompt contains `## Prior Context (from BRAIN)` section (regex match) | false | true |
| G7.B | `cleo nexus impact <sym> --json` `meta.brainEvidence` length on seeded symbol | 0 | ≥ 1 |
| G7.C | Wave-rollup publishes brain-digest event consumed by subscriber within 5 s | N/A | pass |
| G7.D | `% conduit messages with kind ∈ {task-blocked,status-flip,decision,brain-digest} ingested into brain_observations` | 0 % | 100 % |
| G7.E | Decomposition advisor recommends split for ≥ 3-module spread on seeded fixture | N/A | pass |
| G7.F | Spawn-context token budget never exceeds 1200 across 50 sampled spawns | unbounded | 100 % under cap |

---

### Phase Task E-PRIME-T07-P1 — BRAIN → TASKS spawn-context-builder (7.1)

- **Kind**: task / work · **Size**: large · **Severity**: P1
- **Depends-on**: E-PRIME-T03 (peer + memory_blocks), E-PRIME-T07-P4 (brain-digest reader contract — circular: 7.1 reads digests written by 7.4)
- **Files (create)**: `packages/core/src/orchestrate/spawn-context-builder.ts`
- **Files (edit)**: `packages/core/src/orchestrate/spawn-ops.ts` (composeSpawnForTask at line 234), `packages/core/src/cant/composer.ts` (render section), `packages/contracts/src/spawn.ts` (SpawnBrainContext type)

#### Subtasks

1. **T07-P1-S1** — `subtask / work / small / P2` — Add `SpawnBrainContext` type in `packages/contracts/src/spawn.ts` with fields `decisions`, `patterns`, `learnings`, `digests`, `tokenBudgetUsed`.
   - **Acceptance**: `pnpm --filter @cleocode/contracts run build` succeeds | type exported from contracts barrel | no `any` introduced.
   - **Evidence**: `tool:typecheck;files:packages/contracts/src/spawn.ts`.
2. **T07-P1-S2** — `subtask / work / small / P2` — Scaffold `spawn-context-builder.ts` with exported `buildSpawnBrainContext(taskId, opts)` returning `SpawnBrainContext`; empty bucket arrays initially.
   - **Acceptance**: function compiles | TSDoc complete on export | unit-test stub passes with empty fixture.
   - **Evidence**: `tool:test;files:packages/core/src/orchestrate/spawn-context-builder.ts`.
3. **T07-P1-S3** — `subtask / work / medium / P2` — Implement **Bucket 1 (touched-symbol decisions)**: query `task_touches_symbol` for the task, call `findMemoryNodesForCodeNode(symbolId)` per symbol, join to `brain_decisions`, cap at 4.
   - **Acceptance**: returns ≤ 4 rows | uses `findMemoryNodesForCodeNode` (bridge function, exact name) | seeded fixture with 6 candidates returns 4 highest-confidence.
   - **Evidence**: `tool:test;files:packages/core/src/orchestrate/spawn-context-builder.ts,packages/core/src/memory/graph-memory-bridge.ts`.
4. **T07-P1-S4** — `subtask / work / medium / P2` — Implement **Bucket 2 (type-matching patterns)**: call `searchBrainCompact({tables:['patterns'], mode:'hybrid', filter:{taskType:task.type}})`, cap at 3.
   - **Acceptance**: returns ≤ 3 patterns | hybrid mode flag set | falls back gracefully on retrieval error.
   - **Evidence**: `tool:test;files:packages/core/src/orchestrate/spawn-context-builder.ts`.
5. **T07-P1-S5** — `subtask / work / medium / P2` — Implement **Bucket 3 (epic 1-hop learnings)**: traverse `brain_memory_links` 1-hop from `task.epicId`, join `brain_learnings`, cap at 3.
   - **Acceptance**: returns ≤ 3 learnings | skips when `task.epicId` is null | does not double-count global-peer learnings.
   - **Evidence**: `tool:test;files:packages/core/src/orchestrate/spawn-context-builder.ts`.
6. **T07-P1-S6** — `subtask / work / medium / P1` — **Token-budget enforcement (≤ 1200)**: count tokens after rendering each bucket; truncate buckets in order pattern→learning→decision until under budget. Record `tokenBudgetUsed`.
   - **Acceptance**: 50-spawn fuzz test: 100 % under 1200 tokens | record telemetry to `meta.tokenBudgetUsed` | uses shared tokenizer util (no per-package duplication).
   - **Evidence**: `tool:test;files:packages/core/src/orchestrate/spawn-context-builder.ts;test-run:/tmp/spawn-budget-fuzz.json`.
7. **T07-P1-S7** — `subtask / work / small / P2` — Wire `buildSpawnBrainContext` call into `composeSpawnForTask` at `spawn-ops.ts:234` (NOT `composeSpawnPayload` — see §16.A); attach result to payload under `spawnBrainContext`.
   - **Acceptance**: payload typed via `SpawnBrainContext` | composeSpawnForTask remains backwards-compatible (field optional) | unit test asserts presence on epic-attached task.
   - **Evidence**: `tool:test;files:packages/core/src/orchestrate/spawn-ops.ts`.
8. **T07-P1-S8** — `subtask / work / small / P2` — Render `## Prior Context (from BRAIN)` section in `cant/composer.ts` from `spawnBrainContext`; bucketed subheadings (Decisions / Patterns / Learnings / Recent Digests).
   - **Acceptance**: `cleo orchestrate spawn <task> --dry-run` matches regex `/^## Prior Context \(from BRAIN\)/m` | renders empty placeholder when no context | preserves existing CANT-level mental-model-injection (DO NOT replace).
   - **Evidence**: `tool:test;files:packages/core/src/cant/composer.ts;commit:<sha>`.
9. **T07-P1-S9** — `subtask / work / small / P2` — Integration test: seed BRAIN with 6 decisions, 5 patterns, 4 learnings for fixture task → assert section renders 4+3+3 within budget.
   - **Acceptance**: vitest passes | uses `tmpdir`-scoped BRAIN db | no fixture leaks.
   - **Evidence**: `tool:test;test-run:/tmp/spawn-context-integration.json`.

**Milestone Gate G7.A + G7.F passes** on completion.

---

### Phase Task E-PRIME-T07-P2 — NEXUS → BRAIN code-aware retrieval (7.2)

- **Kind**: task / work · **Size**: medium · **Severity**: P2
- **Depends-on**: existing bridge `graph-memory-bridge.findMemoryNodesForCodeNode` at line 1026 (confirmed present per §16.A).
- **Files (edit)**: `packages/core/src/nexus/impact.ts`, `packages/core/src/nexus/__tests__/impact.test.ts`, `packages/contracts/src/nexus.ts` (extend `ImpactResult`), CLI renderer in `packages/cleo/src/cli/commands/nexus.ts`.

#### Subtasks

1. **T07-P2-S1** — `subtask / work / small / P2` — Extend `ImpactResult` contract: add `brainEvidence: { decisions: BrainDecisionRef[], observations: BrainObservationRef[] }` per impacted symbol.
   - **Acceptance**: type compiles | no `unknown` casts | TSDoc complete.
   - **Evidence**: `tool:typecheck;files:packages/contracts/src/nexus.ts`.
2. **T07-P2-S2** — `subtask / work / medium / P2` — In `impact.ts`, after impact set assembled, batch-call `findMemoryNodesForCodeNode(symbolId)` per impacted symbol; group results into `brainEvidence`.
   - **Acceptance**: single batched DB call per impact (not N+1) | empty-result safe | falls back when BRAIN unavailable.
   - **Evidence**: `tool:test;files:packages/core/src/nexus/impact.ts`.
3. **T07-P2-S3** — `subtask / work / small / P2` — CLI renderer: `cleo nexus impact <sym>` prints `## Memory Context` block per symbol when `brainEvidence` non-empty.
   - **Acceptance**: human-readable output | `--json` mode unaltered structurally | `--no-brain` flag opts out.
   - **Evidence**: `tool:test;files:packages/cleo/src/cli/commands/nexus.ts`.
4. **T07-P2-S4** — `subtask / work / small / P2` — Test: seed code node with 2 decisions + 1 observation → assert `meta.brainEvidence` length ≥ 3 across the impact set.
   - **Acceptance**: vitest passes | covers symbol-with-no-evidence path | covers BRAIN-down fallback path.
   - **Evidence**: `tool:test;test-run:/tmp/nexus-brain-evidence.json`.

**Milestone Gate G7.B passes** on completion.

---

### Phase Task E-PRIME-T07-P3 — TASKS → NEXUS decomposition advisor (7.3)

- **Kind**: task / work · **Size**: medium · **Severity**: P2
- **Files (create)**: `packages/core/src/tasks/decomposition-impact-advisor.ts`
- **Files (edit)**: `packages/core/src/tasks/add.ts`, `packages/core/src/tasks/atomicity.ts`
- **Distinct from**: `nexus-impact-gate.ts:108` (runs at COMPLETION). This runs at DECOMPOSITION.

#### Subtasks

1. **T07-P3-S1** — `subtask / work / small / P2` — Scaffold `decomposition-impact-advisor.ts` exporting `adviseDecomposition(task, files, projectRoot): Promise<{ shouldSplit: boolean, suggestedSplits: SplitSuggestion[], reason: string }>`.
   - **Acceptance**: compiles | typed result | TSDoc complete.
   - **Evidence**: `tool:typecheck;files:packages/core/src/tasks/decomposition-impact-advisor.ts`.
2. **T07-P3-S2** — `subtask / work / medium / P2` — Implement module-clustering: walk impact set, group by top-level module path (`packages/<pkg>/src/<module>/`); flag `shouldSplit=true` when ≥ 3 distinct top-level modules or ≥ 5 distinct subsystems touched.
   - **Acceptance**: 3-module fixture returns shouldSplit=true | 2-module fixture returns false | suggestedSplits each name a target module + file list.
   - **Evidence**: `tool:test;files:packages/core/src/tasks/decomposition-impact-advisor.ts`.
3. **T07-P3-S3** — `subtask / work / small / P2` — Wire into `tasks/add.ts`: when creating epic OR task with `--files`, call advisor and surface warning (non-blocking).
   - **Acceptance**: warning printed to stderr | `--no-advise` opts out | exit code unchanged.
   - **Evidence**: `tool:test;files:packages/core/src/tasks/add.ts`.
4. **T07-P3-S4** — `subtask / work / small / P2` — Wire into `tasks/atomicity.ts`: include advisor verdict as an atomicity signal (warn only, never reject).
   - **Acceptance**: existing atomicity tests pass unchanged | advisor verdict surfaces in `cleo task atomicity-check` JSON envelope.
   - **Evidence**: `tool:test;files:packages/core/src/tasks/atomicity.ts`.
5. **T07-P3-S5** — `subtask / work / small / P2` — Integration test: `cleo task plan --files a/x.ts,b/y.ts,c/z.ts` returns advisor verdict with `shouldSplit=true`.
   - **Acceptance**: CLI test passes | covers single-module no-split path.
   - **Evidence**: `tool:test;test-run:/tmp/decomposition-advisor-cli.json`.

**Milestone Gate G7.E passes** on completion.

---

### Phase Task E-PRIME-T07-P4 — BRAIN ↔ CONDUIT brain-digest events (7.4)

- **Kind**: task / work · **Size**: medium · **Severity**: P1
- **Depends-on**: existing Phase-Lead `rollupWaveStatus` aggregator (ADR-070).
- **Files (create)**: `packages/core/src/orchestrate/wave-rollup.ts`
- **Files (edit)**: `packages/core/src/conduit/ops.ts`, `packages/contracts/src/events.ts` (BrainDigestEvent type), `packages/core/src/orchestrate/spawn-context-builder.ts` (digest reader bucket from P1).

#### Subtasks

1. **T07-P4-S1** — `subtask / work / small / P2` — Add `BrainDigestEvent` type to `packages/contracts/src/events.ts` with all fields from masterplan §5 Tier 7.4 (type, epicId, waveNumber, emittedBy, emittedAt, insights{decisions,blockers,patternsConfirmed}, observationIds).
   - **Acceptance**: type exported | TSDoc complete | no `unknown`.
   - **Evidence**: `tool:typecheck;files:packages/contracts/src/events.ts`.
2. **T07-P4-S2** — `subtask / work / medium / P2` — Implement `wave-rollup.ts` exporting `publishBrainDigest(epicId, waveNumber, peerId)` — gathers wave observations, distills 3-bucket digest, publishes on topic `epic-<epicId>.brain-digest`.
   - **Acceptance**: deterministic heuristics (no LLM) | publishes via `conduit/ops.ts` | returns digest object for testing.
   - **Evidence**: `tool:test;files:packages/core/src/orchestrate/wave-rollup.ts`.
3. **T07-P4-S3** — `subtask / work / small / P2` — Hook into Phase-Lead convergence path: after `rollupWaveStatus` reports converged, call `publishBrainDigest`.
   - **Acceptance**: integration test: seeded wave converges → digest published within same tick | idempotent on repeated convergence.
   - **Evidence**: `tool:test;files:packages/core/src/orchestrate/wave-rollup.ts`.
4. **T07-P4-S4** — `subtask / work / small / P2` — Extend `spawn-context-builder.ts` (Bucket 4) to drain last N (default 3) brain-digest events from `epic-<task.epicId>.brain-digest` topic when `task.epicId` set.
   - **Acceptance**: drains under token budget | de-duplicates by `(epicId, waveNumber)` | gracefully empty when epic unattached.
   - **Evidence**: `tool:test;files:packages/core/src/orchestrate/spawn-context-builder.ts`.
5. **T07-P4-S5** — `subtask / work / small / P2` — Integration test: seeded wave publishes digest → subscriber on `epic-T*.brain-digest` receives within 5 s.
   - **Acceptance**: vitest passes with 5 s timeout | covers no-subscriber path | covers multi-subscriber fan-out.
   - **Evidence**: `tool:test;test-run:/tmp/brain-digest-event.json`.

**Milestone Gate G7.C passes** on completion. **Resolves circular dep with P1.**

---

### Phase Task E-PRIME-T07-P5 — CONDUIT → BRAIN significant-message ingester (7.5)

- **Kind**: task / work · **Size**: medium · **Severity**: P2
- **Files (create)**: `packages/core/src/memory/conduit-ingester.ts`
- **Files (edit)**: `packages/core/src/sentient/tick.ts` (schedule), `packages/core/src/memory/verify-and-store.ts` (accept `sourceType='conduit-ingest'`).

#### Subtasks

1. **T07-P5-S1** — `subtask / work / small / P2` — Scaffold `conduit-ingester.ts` exporting `ingestSignificantMessages(projectRoot, since): Promise<IngestResult>`; returns per-kind counts.
   - **Acceptance**: compiles | TSDoc complete | typed result.
   - **Evidence**: `tool:typecheck;files:packages/core/src/memory/conduit-ingester.ts`.
2. **T07-P5-S2** — `subtask / work / small / P2` — Implement deterministic heuristic: kind `task-blocked` (regex on body OR `kind=task-blocked` envelope) → significant.
   - **Acceptance**: positive + negative fixtures | no LLM call.
   - **Evidence**: `tool:test;files:packages/core/src/memory/conduit-ingester.ts`.
3. **T07-P5-S3** — `subtask / work / small / P2` — Heuristic: `status-flip` (task transition message envelope with kind=status-change).
   - **Acceptance**: fixtures pass | only flips, not all status messages.
   - **Evidence**: `tool:test;files:packages/core/src/memory/conduit-ingester.ts`.
4. **T07-P5-S4** — `subtask / work / small / P2` — Heuristic: `decision` (kind=decision envelope OR body contains `Decision:` header).
   - **Acceptance**: fixtures pass.
   - **Evidence**: `tool:test;files:packages/core/src/memory/conduit-ingester.ts`.
5. **T07-P5-S5** — `subtask / work / small / P2` — Heuristic: `brain-digest` (kind=brain-digest envelope from P4).
   - **Acceptance**: subsumes P4 events | de-dup by source message id.
   - **Evidence**: `tool:test;files:packages/core/src/memory/conduit-ingester.ts`.
6. **T07-P5-S6** — `subtask / work / medium / P2` — Route each significant message through `verifyAndStore` with `sourceType='conduit-ingest'`, `origin='auto-extract'`, `provenanceChain=[conduitMessageId]`.
   - **Acceptance**: row appears in `brain_observations` with sourceType=conduit-ingest | provenance chain intact | duplicate ingest is idempotent.
   - **Evidence**: `tool:test;files:packages/core/src/memory/conduit-ingester.ts,packages/core/src/memory/verify-and-store.ts`.
7. **T07-P5-S7** — `subtask / work / small / P2` — Schedule ingester inside daemon tick (`sentient/tick.ts`): each tick, ingest messages newer than last cursor.
   - **Acceptance**: cursor persisted | bounded batch size (default 100) | tick never blocks > 500 ms.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/tick.ts`.
8. **T07-P5-S8** — `subtask / work / small / P2` — Test: seed 4 messages (one per kind) → after one tick, `cleo memory find --source-type conduit-ingest` returns 4 rows.
   - **Acceptance**: vitest passes | covers no-significant-messages tick.
   - **Evidence**: `tool:test;test-run:/tmp/conduit-ingest-cli.json`.

**Milestone Gate G7.D passes** on completion.

---

## E-PRIME-T08b — Continuous Living (idle dream + archive compaction + skill distillation)

### Identity

- **Kind**: epic / work
- **Severity**: P1
- **Size**: large
- **Parent**: PRIME masterplan
- **Depends-on**: `E-PRIME-T03` (peer-aware memory_blocks + `append_block` op; required by 8.1 archive compaction AND 8.3 skill distillation), `E-PRIME-T06.3` (surprisal pickup / `surprisal.ts` integration — required by idleDreamGate to select top-5 high-surprisal observations), `E-PRIME-T06.5` (structural fast-path split of `runConsolidation` — required to support `mode:'partial'`).
- **Excludes**: Tier 8.2 memory-git (owned by another agent — cited only as `depends-on` from 8.3 when distilled skills want versioned memory snapshots).

### Vision

BRAIN learns continuously: idle time triggers partial-dream cycles that fold the highest-surprisal recent observations into learnings; monthly archive compaction promotes mature learnings into peer persona blocks; successful patterns auto-distill into reusable skills exposed via progressive disclosure.

### Acceptance Criteria

- 6 backdated observations + idle 10 min → `idleDreamGate` fires → ≥ 1 new row in `brain_learnings` tagged `partial-dream`.
- After monthly cycle on a seeded fixture, ≥ 1 learning with `confidence>=0.85, retrievalCount>=3, peer_id!='global'` is appended to its peer's `recent-decisions` or `persona` block; source rows carry `tier_promoted_at`.
- Pattern with `retrieval_count=6, success_rate=0.9, peer_id!='global'` emits one `SkillDistillationProposal`; on `cleo agent skills review --accept`, a `.md` file appears at `~/.cleo/skills/<peer-id>/<name>.md`; subsequent spawn of that peer surfaces the skill via progressive disclosure.

### Milestone Gates

| Gate | Baseline | Target |
|---|---|---|
| G8b.A | `idleDreamGate` fires on idle≥5 min AND obsSinceLastDream≥5 AND daemonHealth.ok | never | always (when conditions met) |
| G8b.B | Partial-dream cycle writes 1-3 new rows into `brain_learnings` | 0 | 1-3 |
| G8b.C | `archiveCompactionTick` runs monthly and promotes ≥ 1 learning per qualifying peer | N/A | pass |
| G8b.D | Source rows for promoted learnings carry `tier_promoted_at` non-null | always null | non-null on promotion |
| G8b.E | `SkillDistillationProposal` emitted for first matching pattern | 0 | ≥ 1 |
| G8b.F | `cleo agent skills review --accept <id>` materializes `.md` at canonical path | N/A | pass |
| G8b.G | Subsequent spawn of peer surfaces distilled skill via progressive disclosure | N/A | pass |

---

### Phase Task E-PRIME-T08b-P1 — idleDreamGate + runPartialDream (8.1 idle)

- **Kind**: task / work · **Size**: medium · **Severity**: P1
- **Depends-on**: E-PRIME-T06.3 (surprisal), E-PRIME-T06.5 (structural-fast-path split).
- **Files (edit)**: `packages/core/src/sentient/tick.ts`, `packages/core/src/sentient/dream-cycle.ts`, `packages/core/src/sentient/daemon-api.ts` (telemetry).

#### Subtasks

1. **T08b-P1-S1** — `subtask / work / small / P2` — Add `daemonHealth.ok: boolean` field + accessor in `daemon-api.ts` (derived from existing health checks).
   - **Acceptance**: typed | compiles | unit-tested.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/daemon-api.ts`.
2. **T08b-P1-S2** — `subtask / work / small / P2` — Add observation counter `observationsSinceLastDream` to daemon state with `incrementOnObserve` + `resetOnDream`.
   - **Acceptance**: thread-safe (single-writer daemon) | persisted across tick boundaries | reset is atomic.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/tick.ts`.
3. **T08b-P1-S3** — `subtask / work / small / P2` — Implement `idleDreamGate(state)` function in `sentient/tick.ts` with predicate `idleMinutes > 5 && observationsSinceLastDream > 5 && daemonHealth.ok`.
   - **Acceptance**: pure function | unit tests for each branch | logs gate decision.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/tick.ts`.
4. **T08b-P1-S4** — `subtask / work / medium / P2` — Implement `runPartialDream(topN, peerId)` in `dream-cycle.ts`: pull top-N high-surprisal observations via `surprisal.ts`, call `executeForRole('consolidation', { mode: 'partial' })`, write 1-3 insights into `brain_learnings`.
   - **Acceptance**: writes 1-3 rows | tagged `origin='partial-dream'` | respects `kill-switch` | timeout-bounded (default 30 s).
   - **Evidence**: `tool:test;files:packages/core/src/sentient/dream-cycle.ts`.
5. **T08b-P1-S5** — `subtask / work / small / P2` — Wire `idleDreamGate → runPartialDream` into tick loop; reset counters on success.
   - **Acceptance**: integration test fires gate after 5 idle obs + 6 min sim time | counters reset.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/tick.ts`.
6. **T08b-P1-S6** — `subtask / work / small / P2` — Telemetry: emit `partial-dream-fired` event on `sentient.events` with `(peerId, observationIds, learningCount)`.
   - **Acceptance**: event observable | format documented in TSDoc.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/events.ts`.
7. **T08b-P1-S7** — `subtask / work / small / P2` — Integration test: seed 6 backdated obs + simulate 10 min idle → assert ≥ 1 new `brain_learnings` row tagged `partial-dream`.
   - **Acceptance**: vitest passes | covers `daemonHealth.ok=false` no-fire path | covers kill-switch path.
   - **Evidence**: `tool:test;test-run:/tmp/idle-dream-integration.json`.

**Milestone Gates G8b.A + G8b.B pass** on completion.

---

### Phase Task E-PRIME-T08b-P2 — archiveCompactionTick (8.1 monthly promotion)

- **Kind**: task / work · **Size**: medium · **Severity**: P2
- **Depends-on**: E-PRIME-T03 (`memory_blocks.append_block` op + peer block layout).
- **Files (edit)**: `packages/core/src/sentient/tick.ts`, `packages/core/src/memory/memory-blocks.ts` (append_block hook), schema migration for `tier_promoted_at`.

#### Subtasks

1. **T08b-P2-S1** — `subtask / work / small / P2` — Schema migration: add `tier_promoted_at: TIMESTAMP NULL` to `brain_learnings`.
   - **Acceptance**: drizzle migration generated | applied | rollback works | typed in contracts.
   - **Evidence**: `tool:test;files:packages/core/src/memory/memory-schema.ts;commit:<sha>`.
2. **T08b-P2-S2** — `subtask / work / small / P2` — Query: `selectPromotionCandidates()` returns learnings with `confidence >= 0.85 AND retrievalCount >= 3 AND peer_id != 'global' AND tier_promoted_at IS NULL`.
   - **Acceptance**: indexed query | seeded fixture returns expected rows | global-peer excluded.
   - **Evidence**: `tool:test;files:packages/core/src/memory/memory-blocks.ts`.
3. **T08b-P2-S3** — `subtask / work / medium / P2` — Implement `archiveCompactionTick(state)`: month-cadence gate (last run >30 d ago), iterate candidates, append to owning peer's `recent-decisions` or `persona` block via `memory.append_block`.
   - **Acceptance**: month-cadence enforced | append uses existing `append_block` op (no schema bypass) | crash-safe (one-row-at-a-time transactions).
   - **Evidence**: `tool:test;files:packages/core/src/sentient/tick.ts`.
4. **T08b-P2-S4** — `subtask / work / small / P2` — On successful append, mark source rows `tier_promoted_at = now()` in same transaction.
   - **Acceptance**: idempotent re-runs are no-ops | timestamp matches block-append time | rollback on append failure.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/tick.ts`.
5. **T08b-P2-S5** — `subtask / work / small / P2` — Test: seed 3 qualifying learnings for `peer=cleo-prime` + 2 disqualifying → assert 3 appended, sources marked, 2 untouched.
   - **Acceptance**: vitest passes | covers cadence-not-yet-due path.
   - **Evidence**: `tool:test;test-run:/tmp/archive-compaction.json`.

**Milestone Gates G8b.C + G8b.D pass** on completion.

---

### Phase Task E-PRIME-T08b-P3 — Skill Distillation proposal emitter (8.3)

- **Kind**: task / work · **Size**: medium · **Severity**: P2
- **Depends-on**: E-PRIME-T03 (peer memory_blocks for `distilled_from` provenance), existing `progressive-disclosure` plumbing under `packages/skills/`, existing `proposal-dedup.ts` and `proposal-rate-limiter.ts` in sentient.
- **Files (create)**: `packages/core/src/agents/skill-distill.ts`
- **Files (edit)**: `packages/core/src/sentient/dream-cycle.ts`, `packages/contracts/src/skills.ts` (`SkillDistillationProposal` type).

#### Subtasks

1. **T08b-P3-S1** — `subtask / work / small / P2` — Add `SkillDistillationProposal` type with `{id, peerId, skillName, trigger, distilledFrom: ObservationRef[], confidence, sourceObsIds, createdAt, status}`.
   - **Acceptance**: typed | TSDoc | exported from contracts barrel.
   - **Evidence**: `tool:typecheck;files:packages/contracts/src/skills.ts`.
2. **T08b-P3-S2** — `subtask / work / medium / P2` — Implement detector in `skill-distill.ts`: scan `brain_patterns` for rows with `retrieval_count >= 5 AND success_rate >= 0.8 AND peer_id != 'global'`, emit one proposal per dedup-bucket.
   - **Acceptance**: dedup via existing `proposal-dedup.ts` (content_hash, 7-day window) | rate-limit via `proposal-rate-limiter.ts` | global-peer excluded.
   - **Evidence**: `tool:test;files:packages/core/src/agents/skill-distill.ts`.
3. **T08b-P3-S3** — `subtask / work / small / P2` — Schedule detector in `dream-cycle.ts` end-of-cycle hook (after semantic dream completes).
   - **Acceptance**: runs once per dream cycle | no impact on dream success path | bounded execution (< 5 s).
   - **Evidence**: `tool:test;files:packages/core/src/sentient/dream-cycle.ts`.
4. **T08b-P3-S4** — `subtask / work / small / P2` — Persist proposals to existing proposals table with `kind='skill-distillation'`.
   - **Acceptance**: queryable via `cleo sentient propose list --kind skill-distillation` | links back to source pattern + observations.
   - **Evidence**: `tool:test;files:packages/core/src/agents/skill-distill.ts`.
5. **T08b-P3-S5** — `subtask / work / small / P2` — Test: seed pattern (retrieval=6, success=0.9, peer=cleo-prime) → assert 1 proposal emitted | non-qualifying pattern emits 0.
   - **Acceptance**: vitest passes | covers dedup re-run.
   - **Evidence**: `tool:test;test-run:/tmp/skill-distill-detect.json`.

**Milestone Gate G8b.E passes** on completion.

---

### Phase Task E-PRIME-T08b-P4 — Skill review CLI + materialization (8.3 owner approval flow)

- **Kind**: task / work · **Size**: medium · **Severity**: P2
- **Depends-on**: T08b-P3.
- **Files (edit)**: `packages/cleo/src/cli/commands/agent.ts` (`skills review|list|accept|reject`), `packages/core/src/agents/skill-distill.ts` (materializer), `packages/skills/` integration.

#### Subtasks

1. **T08b-P4-S1** — `subtask / work / small / P2` — Add `cleo agent skills list` — lists pending `SkillDistillationProposal` rows with confidence + source counts.
   - **Acceptance**: JSON envelope LAFS-compliant | empty-list path | filter by peer.
   - **Evidence**: `tool:test;files:packages/cleo/src/cli/commands/agent.ts`.
2. **T08b-P4-S2** — `subtask / work / small / P2` — Add `cleo agent skills review <id>` — prints full proposal detail incl. excerpts of source observations.
   - **Acceptance**: human-readable | `--json` mode | exit 4 on not-found.
   - **Evidence**: `tool:test;files:packages/cleo/src/cli/commands/agent.ts`.
3. **T08b-P4-S3** — `subtask / work / small / P2` — Add `cleo agent skills accept <id>` — materializes `.md` at `~/.cleo/skills/<peer-id>/<skill-name>.md` with frontmatter `{name, trigger, distilled_from, confidence, source_obs_ids, created_at}`.
   - **Acceptance**: idempotent (re-accept is no-op) | path created atomically | proposal status flips to `accepted` in same transaction.
   - **Evidence**: `tool:test;files:packages/core/src/agents/skill-distill.ts`.
4. **T08b-P4-S4** — `subtask / work / small / P2` — Add `cleo agent skills reject <id> --reason "<r>"` — sets `status='rejected'` with reason; never deletes (auditable).
   - **Acceptance**: reason persisted | proposal still queryable via `--include-rejected` flag.
   - **Evidence**: `tool:test;files:packages/cleo/src/cli/commands/agent.ts`.
5. **T08b-P4-S5** — `subtask / work / small / P2` — Wire materialized `.md` into progressive disclosure: `packages/skills/` indexer scans `~/.cleo/skills/<peer-id>/` and surfaces them when that peer spawns.
   - **Acceptance**: indexer test: distilled skill appears in peer's spawn-prompt tier-1 manifest | does not pollute other peers.
   - **Evidence**: `tool:test;files:packages/skills/src/index.ts`.
6. **T08b-P4-S6** — `subtask / work / small / P2` — Integration test end-to-end: emit proposal → accept → assert `.md` exists → assert subsequent spawn of that peer contains skill.
   - **Acceptance**: vitest passes | uses tmp `~/.cleo/skills/` root via env override.
   - **Evidence**: `tool:test;test-run:/tmp/skill-distill-e2e.json`.

**Milestone Gates G8b.F + G8b.G pass** on completion.

---

## E-PRIME-T09 — Sentient Tier-2 + CANT Evolution

### Identity

- **Kind**: epic / work
- **Severity**: P1 (closes the autonomous proposal loop — Tier 2)
- **Size**: large
- **Parent**: PRIME masterplan
- **Depends-on**: `E-PRIME-T06.2` (derivation queue — `propose.ts` reads derived patterns), `E-PRIME-T03` (agent diary table, skill mastery table, rapport graph — all required by 9.5 `/reflect` directive and `agent-architect.cant` extension), `E-PRIME-T06` (BRAIN dream pipeline produces the patterns Tier-2 detector reads).

### Vision

Tier-2 propose-tick stops being a placeholder. The detector emits `contradiction|correlation|preference|tendency|card_update` proposals from BRAIN patterns under Honcho 2-evidence rule. Integration tests prove Tier 1+2+3 lifecycle. Tier-3 sandbox is properly deferred as T-SANDBOX with cleo-os dependency. 312-op surface audit instruments BRAIN ingestion for op-invocation events. CANT directive `/reflect` + `agent-review.cantbook` playbook close the persona-evolution loop.

### Acceptance Criteria

- Tier-2 detector emits ≥ 1 proposal per kind on a seeded fixture matching 2-evidence rule; dedup via content_hash + 7-day window.
- 4-AND gate (`obs >= 50 AND hours >= 8 AND idle >= 60 AND no_pending`) observably blocks propose-tick when any condition fails; `cleo sentient propose --force` bypasses (audited).
- `daemon-lifecycle.test.ts` exercises Tier 1+2+3 with seeded BRAIN; asserts kind-specific emissions.
- T-SANDBOX exists as a follow-up task with explicit `depends-on: cleo-os adapter work`; no code.
- `cleo agents reflect <peerId>` returns reflection envelope; `agent-review.cantbook` completes a self-review producing a refined `.cant` proposal for `cleo-prime`.
- BRAIN ingestion records op-invocation events; `.cleo/agent-outputs/T1250-op-audit.md` lists top-30 + dead aliases + undocumented essentials.

### Milestone Gates

| Gate | Baseline | Target |
|---|---|---|
| G9.A | Tier-2 detector emits each of {contradiction,correlation,preference,tendency,card_update} on seeded fixture | 0 | ≥ 1 each |
| G9.B | 4-AND gate blocks tick when any condition fails | always fires | blocked |
| G9.C | `--force` bypasses gate AND appends audit row | unavailable | works + audited |
| G9.D | `daemon-lifecycle.test.ts` exercises Tier 1+2+3 with seeded BRAIN | absent | green |
| G9.E | T-SANDBOX created as decision-only follow-up with cleo-os dep | absent | present |
| G9.F | `.cleo/agent-outputs/T1250-op-audit.md` lists top-30 + dead aliases | absent | present |
| G9.G | 3 new hook events present in `hook-mappings.json` | 31 events | 34 events |
| G9.H | `/reflect` directive parses in cant-core + TS validator | parse error | parses |
| G9.I | `agent-review.cantbook` completes self-review producing refined `.cant` for cleo-prime | N/A | pass |

---

### Phase Task E-PRIME-T09-P1 — T1644 Tier-2 detector wiring (9.1)

- **Kind**: task / work · **Size**: large · **Severity**: P1
- **Depends-on**: E-PRIME-T06.2 (derivation queue).
- **Files (create)**: `packages/core/src/sentient/propose.ts`
- **Files (edit)**: `packages/core/src/sentient/propose-tick.ts`, `packages/contracts/src/sentient.ts` (proposal kinds enum).

#### Subtasks

1. **T09-P1-S1** — `subtask / work / small / P2` — Extend `ProposalKind` union in contracts: add `contradiction | correlation | preference | tendency | card_update`.
   - **Acceptance**: typed | exported | exhaustive switches in callers compile.
   - **Evidence**: `tool:typecheck;files:packages/contracts/src/sentient.ts`.
2. **T09-P1-S2** — `subtask / work / small / P2` — Scaffold `propose.ts` with exported `runTier2Detector(state): Promise<TierProposalResult>` and per-kind helpers.
   - **Acceptance**: compiles | TSDoc | typed result.
   - **Evidence**: `tool:typecheck;files:packages/core/src/sentient/propose.ts`.
3. **T09-P1-S3** — `subtask / work / medium / P2` — Implement **contradiction** detector: find pairs of decisions with same `topic` but opposite `stance`; require 2 independent observations supporting each side.
   - **Acceptance**: 2-evidence rule enforced | seeded contradictory decisions emit 1 proposal | non-contradictory decisions emit 0.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/propose.ts`.
4. **T09-P1-S4** — `subtask / work / medium / P2` — Implement **correlation** detector: find pairs of BRAIN entries that co-occur ≥ K (default 3) times in nexus plasticity graph; require 2 independent sessions.
   - **Acceptance**: 2-evidence (≥ 2 distinct sessions) enforced | uses existing `brain_plasticity_events` table.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/propose.ts`.
5. **T09-P1-S5** — `subtask / work / medium / P2` — Implement **preference** detector: tool X chosen over Y across ≥ 2 sessions in observation log.
   - **Acceptance**: 2-evidence enforced | suggests config-update task body.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/propose.ts`.
6. **T09-P1-S6** — `subtask / work / medium / P2` — Implement **tendency** detector: worker-class fails a gate ≥ 2 times in observation log.
   - **Acceptance**: 2-evidence enforced | links to worker-class identity.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/propose.ts`.
7. **T09-P1-S7** — `subtask / work / medium / P2` — Implement **card_update** detector: stable fact about operator/codebase emerges (≥ 2 independent observations, ≥ 7-day half-life).
   - **Acceptance**: 2-evidence enforced | proposes specific persona-block edit.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/propose.ts`.
8. **T09-P1-S8** — `subtask / work / small / P2` — Dedup all detectors through existing `proposal-dedup.ts` (content_hash + 7-day window).
   - **Acceptance**: re-run on same state emits 0 net-new | content_hash deterministic.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/proposal-dedup.ts`.
9. **T09-P1-S9** — `subtask / work / medium / P2` — Implement 4-AND Honcho gate in `propose-tick.ts`: `obs >= 50 AND hours >= 8 AND idle >= 60 AND no_pending` (`no_pending` = no in-flight Tier-2 proposals for this peer).
   - **Acceptance**: each AND-branch unit-tested for false → no fire | all-true → fires.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/propose-tick.ts`.
10. **T09-P1-S10** — `subtask / work / small / P2` — Add `cleo sentient propose --force` override that bypasses gate AND appends `force-bypass.jsonl` audit row.
    - **Acceptance**: audit row format matches existing override conventions | bypass works exactly once per invocation.
    - **Evidence**: `tool:test;files:packages/core/src/sentient/propose-tick.ts`.
11. **T09-P1-S11** — `subtask / work / small / P2` — Integration test: seed BRAIN with patterns matching each kind → run propose tick → assert 5 proposals (one per kind).
    - **Acceptance**: vitest passes | dedup re-run emits 0 | gate-failure path emits 0.
    - **Evidence**: `tool:test;test-run:/tmp/tier2-detector.json`.

**Milestone Gates G9.A + G9.B + G9.C pass** on completion.

---

### Phase Task E-PRIME-T09-P2 — T1646 daemon-lifecycle integration test (9.2)

- **Kind**: task / work · **Size**: medium · **Severity**: P2
- **Files (create)**: `packages/core/src/sentient/__tests__/daemon-lifecycle.test.ts`

#### Subtasks

1. **T09-P2-S1** — `subtask / work / small / P2` — Build seeded-BRAIN fixture: 60 observations spanning 5 pattern shapes (one per Tier-2 kind), 3 Tier-1 hygiene candidates, 1 Tier-3 deferred-sandbox marker.
   - **Acceptance**: fixture deterministic | tmpdir-scoped DB | seed function reusable.
   - **Evidence**: `tool:test;files:packages/core/src/sentient/__tests__/daemon-lifecycle.test.ts`.
2. **T09-P2-S2** — `subtask / work / medium / P2` — Test Tier-1 path: hygiene scan emits 3 hygiene proposals.
   - **Acceptance**: assert count = 3 | kinds match `hygiene` | dedup re-run = 0.
   - **Evidence**: `tool:test;test-run:/tmp/daemon-lifecycle-t1.json`.
3. **T09-P2-S3** — `subtask / work / medium / P2` — Test Tier-2 path: detector emits 5 proposals (one per kind).
   - **Acceptance**: kind-by-kind assertion | 2-evidence verified per emission.
   - **Evidence**: `tool:test;test-run:/tmp/daemon-lifecycle-t2.json`.
4. **T09-P2-S4** — `subtask / work / small / P2` — Test Tier-3 path: sandbox marker present → tick logs deferred notice, emits 0 proposals.
   - **Acceptance**: log line matches regex | exit non-error.
   - **Evidence**: `tool:test;test-run:/tmp/daemon-lifecycle-t3.json`.
5. **T09-P2-S5** — `subtask / work / small / P2` — Test kill-switch: enable mid-lifecycle → asserts no further emissions.
   - **Acceptance**: emissions halt within 1 tick | switch state respected.
   - **Evidence**: `tool:test;test-run:/tmp/daemon-lifecycle-kill.json`.

**Milestone Gate G9.D passes** on completion.

---

### Phase Task E-PRIME-T09-P3 — T-SANDBOX deferred follow-up (9.3, decision-only)

- **Kind**: task / spike · **Size**: small · **Severity**: P3
- **Depends-on**: future cleo-os adapter work (no code in this phase).
- **Files (create)**: ADR stub at `.cleo/adrs/ADR-XXX-tier3-sandbox-defer.md` + BRAIN decision row (decision-only subtask).

#### Subtasks

1. **T09-P3-S1** — `subtask / spike / small / P3` — Record decision in BRAIN: "Tier-3 sandbox deferred pending cleo-os container adapter. Letta uses in-process sleep-time agents; CLEO has worktrees but not containers."
   - **Acceptance**: `cleo memory decision-find --query "tier-3 sandbox"` returns 1 row | status=`accepted` | linked to ADR.
   - **Evidence**: `decision:<id>;note:tier-3 sandbox deferred per masterplan §5 Tier 9.3`.
2. **T09-P3-S2** — `subtask / spike / small / P3` — Write ADR stub naming the dependency (cleo-os adapter) + the deferred surface (sandbox transport abstraction patterned on Letta's local/E2B/Modal layering).
   - **Acceptance**: ADR file exists | RFC 2119 language | links Letta tool-sandbox reference per §16.C.
   - **Evidence**: `files:.cleo/adrs/ADR-XXX-tier3-sandbox-defer.md;decision:<id>`.

**Milestone Gate G9.E passes** on completion. **Decision-only — no code.**

---

### Phase Task E-PRIME-T09-P4 — T1659 op-surface audit (9.4)

- **Kind**: task / research · **Size**: medium · **Severity**: P2
- **Files (create)**: `.cleo/agent-outputs/T1250-op-audit.md` (output artifact)
- **Files (edit)**: BRAIN ingestion path (instrumentation only — exact site discovered during S1).

#### Subtasks

1. **T09-P4-S1** — `subtask / research / small / P2` — Survey ingestion path; identify single insertion point where op-invocations can be observed (CLI dispatch boundary).
   - **Acceptance**: site documented | doesn't break existing telemetry.
   - **Evidence**: `files:.cleo/agent-outputs/T1250-op-audit-survey.md;decision:<id>`.
2. **T09-P4-S2** — `subtask / work / medium / P2` — Instrument the dispatch boundary to emit `op-invocation` observation into BRAIN (kind=`op-invocation`, payload=`{opName, args-hash, exit}`).
   - **Acceptance**: emits per invocation | bounded (no PII in args-hash) | feature-flagged `BRAIN_OP_AUDIT=1`.
   - **Evidence**: `tool:test;files:packages/cleo/src/cli/dispatch.ts`.
3. **T09-P4-S3** — `subtask / research / small / P2` — Run audit collection over 1 representative session (e.g., feed a recorded transcript) → produce frequency map.
   - **Acceptance**: ≥ 100 invocations sampled | frequency map deterministic given input.
   - **Evidence**: `test-run:/tmp/op-audit-frequencies.json`.
4. **T09-P4-S4** — `subtask / research / small / P2` — Identify top-30, dead aliases, undocumented essentials; write `.cleo/agent-outputs/T1250-op-audit.md`.
   - **Acceptance**: top-30 list | dead-alias list with proposed removals | undocumented-essentials list with proposed docs tasks.
   - **Evidence**: `files:.cleo/agent-outputs/T1250-op-audit.md;decision:<id>`.

**Milestone Gate G9.F passes** on completion.

---

### Phase Task E-PRIME-T09-P5 — CANT persona evolution: hook events (9.5 part 1)

- **Kind**: task / work · **Size**: small · **Severity**: P2
- **Files (edit)**: `packages/caamp/providers/hook-mappings.json` (31 → 34 events), `crates/cant-core/src/*` (Rust enum), `packages/contracts/src/cant.ts` (TS types).

#### Subtasks

1. **T09-P5-S1** — `subtask / work / small / P2` — Add `AgentSigilUpdated` hook event to `hook-mappings.json` with semantic + payload schema.
   - **Acceptance**: SSoT updated | downstream codegen runs clean.
   - **Evidence**: `tool:test;files:packages/caamp/providers/hook-mappings.json`.
2. **T09-P5-S2** — `subtask / work / small / P2` — Add `AgentSkillMasteryChanged` hook event.
   - **Acceptance**: same as S1.
   - **Evidence**: `tool:test;files:packages/caamp/providers/hook-mappings.json`.
3. **T09-P5-S3** — `subtask / work / small / P2` — Add `AgentDiaryWritten` hook event.
   - **Acceptance**: same as S1.
   - **Evidence**: `tool:test;files:packages/caamp/providers/hook-mappings.json`.
4. **T09-P5-S4** — `subtask / work / small / P2` — Regenerate Rust enum (`crates/cant-core/src/`) + TS types (`packages/contracts/src/cant.ts`) from SSoT.
   - **Acceptance**: enum count = 34 | both languages compile | parity test passes.
   - **Evidence**: `tool:test;tool:typecheck;files:crates/cant-core/src/events.rs,packages/contracts/src/cant.ts`.

**Milestone Gate G9.G passes** on completion.

---

### Phase Task E-PRIME-T09-P6 — `/reflect` directive in CANT (9.5 part 2)

- **Kind**: task / work · **Size**: medium · **Severity**: P2
- **Depends-on**: E-PRIME-T03 (agent diary table, skill mastery table, rapport graph).
- **Files (edit)**: `crates/cant-core/src/parser.rs` (or equivalent), `packages/contracts/src/cant.ts` (TS directive shape), `packages/core/src/agents/reflect.ts` (NEW — handler), `packages/cleo/src/cli/commands/agents.ts` (CLI `reflect`).

#### Subtasks

1. **T09-P6-S1** — `subtask / work / small / P2` — Define grammar for `/reflect @<peerId> "<prompt>"` directive in cant-core parser.
   - **Acceptance**: Rust parser unit tests pass | grammar documented inline.
   - **Evidence**: `tool:test;files:crates/cant-core/src/parser.rs`.
2. **T09-P6-S2** — `subtask / work / small / P2` — Mirror directive shape in TS validator (`packages/contracts/src/cant.ts`).
   - **Acceptance**: parity test with Rust passes.
   - **Evidence**: `tool:typecheck;files:packages/contracts/src/cant.ts`.
3. **T09-P6-S3** — `subtask / work / medium / P2` — Implement handler `reflectAgent(peerId, prompt): Promise<ReflectionEnvelope>` in `packages/core/src/agents/reflect.ts`; pulls diary + skill mastery + rapport graph; returns structured reflection.
   - **Acceptance**: typed result | TSDoc | feature-flagged behind config | deterministic for fixture input.
   - **Evidence**: `tool:test;files:packages/core/src/agents/reflect.ts`.
4. **T09-P6-S4** — `subtask / work / small / P2` — Add `cleo agents reflect <peerId> [--prompt "..."]` CLI command dispatching to handler.
   - **Acceptance**: LAFS-compliant envelope | exit 4 on unknown peer | `--json` mode.
   - **Evidence**: `tool:test;files:packages/cleo/src/cli/commands/agents.ts`.
5. **T09-P6-S5** — `subtask / work / small / P2` — Integration test: seed peer diary + skill rows → `cleo agents reflect cleo-prime --prompt "what worked today"` returns reflection citing seeded rows.
   - **Acceptance**: vitest passes | covers no-diary path.
   - **Evidence**: `tool:test;test-run:/tmp/reflect-cli.json`.

**Milestone Gate G9.H passes** on completion.

---

### Phase Task E-PRIME-T09-P7 — `agent-architect` extension + `agent-review.cantbook` (9.5 part 3)

- **Kind**: task / work · **Size**: medium · **Severity**: P2
- **Depends-on**: T09-P6 (`/reflect` directive must exist), T09-P5 (hook events).
- **Files (edit)**: `packages/agents/meta/agent-architect.cant`
- **Files (create)**: `packages/playbooks/agent-review.cantbook`

#### Subtasks

1. **T09-P7-S1** — `subtask / work / medium / P2` — Extend `agent-architect.cant`: given diary + skill mastery + rapport graph, propose a refined `.cant` definition (tier upgrade, skill additions, tool removals).
   - **Acceptance**: structured proposal output | refined `.cant` validates against schema | dry-run produces diff against current `.cant`.
   - **Evidence**: `tool:test;files:packages/agents/meta/agent-architect.cant`.
2. **T09-P7-S2** — `subtask / work / medium / P2` — Create `packages/playbooks/agent-review.cantbook` with stages: `reflect → propose refinements → owner approves → re-emit .cant`.
   - **Acceptance**: YAML validates against playbook schema | HMAC-signed HITL gate at "owner approves" stage | resume token works.
   - **Evidence**: `tool:test;files:packages/playbooks/agent-review.cantbook`.
3. **T09-P7-S3** — `subtask / work / small / P2` — Wire `agent-review.cantbook` execution: `cleo playbook run agent-review --peer cleo-prime` → runs through to HITL gate.
   - **Acceptance**: gate pauses correctly | `cleo orchestrate pending` lists run | `cleo orchestrate approve <token>` resumes | re-emitted `.cant` lands in `packages/agents/<peer>/<peer>.cant`.
   - **Evidence**: `tool:test;files:packages/playbooks/agent-review.cantbook`.
4. **T09-P7-S4** — `subtask / work / small / P2` — Integration test: seed cleo-prime diary + mastery → run playbook → owner approves → assert refined `.cant` written + matches expected diff snapshot.
   - **Acceptance**: vitest passes | covers owner-reject path (no write).
   - **Evidence**: `tool:test;test-run:/tmp/agent-review-cantbook.json`.

**Milestone Gate G9.I passes** on completion.

---

## Cross-cutting risks + deferred follow-ups

### Risks

- **R1 — Circular dep E-PRIME-T07.1 ↔ T07.4**: spawn-context-builder (P1) reads brain-digest events written by wave-rollup (P4). Mitigation: ship P4 first or land them together as one PR; the contract type (`BrainDigestEvent`) is the shared seam.
- **R2 — Token-budget creep on G7.F**: as buckets 1-4 stack, 1200 tokens is tight. Need shared tokenizer + bucket truncation order (pattern → learning → decision → digest).
- **R3 — `propose.ts` is NEW (T09-P1-S2)**: §16.A confirmed `propose-tick.ts` exists but `propose.ts` does not. Phase task must create it; do not assume any prior surface.
- **R4 — Schema migrations (T08b-P2-S1 + possibly T09-P4-S2)**: any schema bump requires owner approval + ADR; flag in the migration generator before running. CalVer-tagged migration.
- **R5 — `findMemoryNodesForCodeNode` signature**: bridge function presence is confirmed (§16.A) but exact signature not re-verified during planning. Verify in T07-P1-S3 before coding.
- **R6 — Op-audit (T09-P4) requires owner consent for instrumentation feature-flag default**: flag must default OFF unless owner opts in (privacy posture).
- **R7 — `progressive-disclosure` integration (T08b-P4-S5)**: indexer at `packages/skills/` must not pollute other peers' spawn manifests. Strict per-peer scoping is load-bearing.
- **R8 — Wave-rollup writer is NEW (T07-P4-S2)**: no existing Phase-Lead aggregator hook published events before. Need to confirm ADR-070 surface allows publish from convergence path.

### Deferred follow-ups (not decomposed here)

- **T-SANDBOX** (Tier 9.3) — Tier-3 sandbox; depends on cleo-os container adapter; tracked as decision-only via E-PRIME-T09-P3.
- **Tier 8.2 memory-git** — owned by another agent; cited as `depends-on` only from T08b-P3 (skill `.md` versioning) and T07-P1 (decision provenance) if those phases want versioned diff history.
- **Tier 10 Conduit A2A** — `CANT /handoff` directive replacing redirect stubs; ships in R6 per masterplan §5 Tier 10.
- **Tier 11 (NEW from §16.B)** — `MemoryProvider` plugin ABC: BRAIN/NEXUS/llmtxt-core implement same Hermes-style ABC. Adopt only after E-PRIME-T07 lands so the seams are stable.
- **Mem0 V3 envelope adoption** (§16.D) — applies to Tier 4 extraction, not in this scope.
- **Letta v2 memory-tool family adoption** (§16.C) — applies to Tier 3.2, not in this scope.

---

## Phase-task count summary

| Epic | Phase Tasks | Subtasks |
|---|---|---|
| E-PRIME-T07 | 5 | 9 + 4 + 5 + 5 + 8 = 31 |
| E-PRIME-T08b | 4 | 7 + 5 + 5 + 6 = 23 |
| E-PRIME-T09 | 7 | 11 + 5 + 2 + 4 + 4 + 5 + 4 = 35 |
| **Total** | **16** | **89** |

Total atomic subtasks: **89** (within 80-150 target band). Increase headroom available if owner wants finer-grain split on T09-P1 (detector kinds), T08b-P4 (CLI surface), or T07-P5 (heuristics).

---

## Notes

- All file paths in this spec are absolute relative to `/mnt/projects/cleocode/` repo root.
- `composeSpawnForTask` is used everywhere — never `composeSpawnPayload` (per §16.A).
- Evidence atoms follow ADR-051: `tool:test`, `tool:typecheck`, `files:<list>`, `commit:<sha>`, `test-run:<path>`, `decision:<id>`, `note:<text>`.
- No `cleo add` was executed during planning. This spec is the artifact; task creation happens in a separate execution phase.
