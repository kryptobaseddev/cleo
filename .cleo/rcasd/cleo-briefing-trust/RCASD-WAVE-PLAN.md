# RCASD: BRAIN/Briefing Trust & Truth (BBTT)

**Status**: planning · **Date**: 2026-05-05 · **Source**: Council run `20260505T151335Z-42f8f52e` + owner directives on truth/provenance/health-checks
**Companion artifacts**: `.cleo/council-runs/20260505T151335Z-42f8f52e/{verdict.md,output.md}`

## Framing principle

Every read surface in BRAIN/briefing must be **truthful by enforcement, not by hope**. Today the system has rich plumbing (consolidation, decay, plasticity, hard-sweeper, retrieval bundle, attachment store, sentient daemon, dream cycle) and broken contracts at the joins. A field named `recentObservations` returns 11-day-old rows. A scheduler that's "configured" never runs. A "production" tasks table holds test fixtures. We will repair the joins layer-by-layer, with each layer adding a **truth check** that prevents regression.

The ordering is non-negotiable: **stop laundering staleness → restore read-truth → restore engine → enforce provenance → unify surfaces**. Reversing the order produces a smaller payload that lies more efficiently.

---

## R — Root cause (one sentence)

The system has accreted five overlapping context-assembly paths (briefing, spawn-prompt, getSessionMemoryContext, retrieval bundle, handoff) over a memory substrate (BRAIN tables + dream cycle + sentient daemon) **without a unifying truth contract**: no field-name enforcement, no liveness check on the consolidation engine, no provenance column distinguishing real data from test fixtures, no per-actor key on handoff state, no dedup discipline on pattern extraction.

## CA — Cause analysis (the five smoking guns + two the audit didn't surface)

| # | Smoking gun | Where it lives | Why it survived |
|---|---|---|---|
| 1 | BM25-as-recency in `getSessionMemoryContext` | `packages/core/src/memory/session-memory.ts:411-415` | Field-name contract (`recentObservations`) was never enforced by a test that asserts a fresh row outranks a stale one. |
| 2 | Dead dream cycle | `packages/core/src/sentient/tick.ts:483-522` (wired correctly); daemon process not running in prod (`brain_consolidation_events`: 7 rows ever, last automated 2026-04-24) | No liveness/health check surfaces "dream is overdue." Operator has no signal that the engine stopped. |
| 3 | Test-fixture pollution in production tasks.db | 18 rows match test-shaped heuristics in live `.cleo/tasks.db`; 2 active (`T932EP`, `E1`) | No `origin` column. Test factories write same-shape rows as production. T1864 hardened `validateProjectRoot` but didn't gate test writes by intent. |
| 4 | Spawn-prompt parallel-implements briefing | `packages/core/src/orchestration/spawn-prompt.ts:1232` ("Mirrors `computeBriefing` path") | Forking was cheaper than refactoring at the moment of need; nothing later forced reconciliation. |
| 5 | Multi-orchestrator handoff race | `packages/core/src/sessions/handoff.ts:298-348` (`getLastHandoff` returns globally-most-recent) | Schema predates worktree-by-default (T1140/ADR-055); `(actor, scope)` index never added. |
| 6 | **Auto-extract barely working** (the audit didn't surface) | `brain_observations`: 2,819 rows · `brain_learnings`: only **11 rows** | Auto-extraction from observations → learnings is either disabled or filtering too aggressively. Briefing surfaces empty `recentLearnings: []`. |
| 7 | **Pattern explosion** (the audit didn't surface) | `brain_patterns`: 12,390 rows for 2,819 observations (4.4× ratio) — three near-identical "Agent type X fails" rows in a 21s window prove dedup is missing | Pattern extraction emits per-event without dedup pass; the dream cycle's plasticity step doesn't collapse near-duplicates by content hash. |

## S — Solution (layered, each layer adds a truth check)

**Layer A — Stop laundering** (W0): trim the cosmetic dead weight that doesn't carry staleness signal.
**Layer B — Read-truth** (W1): make `recent*` mean recent. Add field-name contract enforcement.
**Layer C — Engine liveness** (W2): make the dream cycle observably alive. Health check + self-healing.
**Layer D — Provenance** (W3): every row carries origin + validated_at. Test fixtures cannot leak.
**Layer E — Write discipline** (W4): handoff has slots, not freeform narrative.
**Layer F — Multi-actor** (W5): per-worktree handoff key.
**Layer G — Unification** (W6): one `assembleContext` primitive, three callers.
**Cross-cutting** (X): `cleo doctor brain` continuous truth dashboard; freshness sentinel CI gate.

## D — Decisions (the wave plan)

### Wave dependency graph

```
W0 (cosmetic, non-laundering)  ──────────────────────┐
                                                      │
W1 (read-truth) ───┬─ W4 (write-discipline) ────┐    │
                   │                             │    │
W2 (engine) ───────┴─ W3 (provenance) ──────────┴── W6 (unification)
                                                      │
                                  W5 (multi-actor) ──┘
                                                      │
                                  X (truth observability) ─ runs continuously, lands incrementally
```

- **W0 ships first** (1 hr) — non-laundering, council-blessed, unblocks everything
- **W1 + W2 in parallel** (this week) — independent files, both needed before W4/W6
- **W3 in parallel** with W2 (different package surfaces)
- **W4** depends on W1 contract types (slots render in `--mode pickup`)
- **W5** can run in parallel after W3 (provenance pattern reused for actor)
- **W6** is the strategic capstone — only after W1+W4 stable
- **X** is incremental — every wave adds at least one truth-check artifact

---

## WAVE 0 — Stop the bleeding (1 hour, 1 person)

Two non-laundering wedges that ship without touching staleness-bearing fields.

### T-W0-1 — Gate `relatedDocs` on `currentTaskId` (Council Executor's action)
- **Files**: `packages/core/src/sessions/briefing.ts:782-803` · `packages/core/src/sessions/__tests__/briefing-docs.test.ts:322`
- **Change**: wrap `relatedDocs` population in `if (currentTaskId !== undefined) { ... }`. Invert the existing test assertion; rename to `'returns no docsContext when no task is focused'`.
- **Verifiable success**: targeted vitest green, `cleo briefing --json | wc -c` drops ≥800 bytes (~1000 tokens). All other fields unchanged.
- **Reversible**: single revert.
- **Size**: small.

### T-W0-2 — Filter test-fixture-shaped epics from `computeActiveEpics` (heuristic wedge)
- **Files**: `packages/core/src/sessions/briefing.ts:636-667`
- **Change**: in the active-epic filter, additionally reject when `id` matches `^E\d+$` or `^T\d+EP$`, OR `title` contains `'Test Epic'` / `'standalone epic'` / `'with no files'` / `'fixture'`. Add a TSDoc note that this is a temporary heuristic until W3-1 lands the `origin` column.
- **Verifiable success**: live `cleo briefing` no longer surfaces `T932EP` or `E1` in `activeEpics`. Add a unit test that asserts a row matching the heuristic is excluded.
- **Why heuristic, not delete**: deletion is destructive and cascades — see Council Contrarian Finding 3. Filter at read-time, fix the source in W3.
- **Size**: small.

**Wave 0 gate**: both ship to main on the same PR; revertable; no schema changes.

---

## WAVE 1 — Read-truth: make field names enforce their promises (parallel, this week)

Three tasks. The first two can run concurrently; the third gates on either.

### T-W1-1 — Add `mode: 'recency' | 'lexical' | 'hybrid'` to `searchBrainCompact`
- **Files**: `packages/core/src/memory/brain-search.ts` (or wherever `searchBrainCompact` lives — verify) · `packages/core/src/memory/session-memory.ts:404-422`
- **Change**:
  - Extend the param object with `mode?: 'recency' | 'lexical' | 'hybrid'` (default `'hybrid'`) and `since?: string` (ISO timestamp).
  - `mode='recency'`: `WHERE created_at >= since` (default: 7d ago) ORDER BY `created_at` DESC, no BM25 contribution.
  - `mode='lexical'`: existing BM25 path.
  - `mode='hybrid'`: RRF combine of recency rank + BM25 rank, weighted (default 0.6 recency / 0.4 lexical).
  - In `getSessionMemoryContext`: `recentObservations` and `recentLearnings` use `mode='recency'`. `relevantPatterns` uses `mode='hybrid'` with `since=30d`.
- **Verifiable success**: new unit test fixtures a 2026-04-24 row and a 2026-05-05 row matching `'session'`; asserts the May row ranks first under `mode='recency'`. Run `cleo briefing` against live data; `recentObservations[0].date >= recentObservations[1].date` (descending).
- **Size**: medium.

### T-W1-2 — Pattern dedup at consolidation time
- **Files**: `packages/core/src/memory/brain-consolidator.ts` · plasticity step in `brain-lifecycle.ts`
- **Change**:
  - Add a `dedupePatterns` step in the dream pipeline: collapse rows where `(content_hash_or_normalized_title, peer_id)` matches AND `created_at` within 1hr window. Keep oldest, increment `occurrence_count`, append `originatingObservationIds` array.
  - Add `occurrence_count INT DEFAULT 1` and `last_seen_at` columns to `brain_patterns`.
- **Verifiable success**: dream cycle run on live `brain.db` reduces `brain_patterns` row count from 12,390 by ≥50% without losing any unique normalized title. Unit test asserts 3 near-identical patterns within a 21s window collapse to 1 row with `occurrence_count=3`.
- **Size**: medium.

### T-W1-3 — Field-name contract types + runtime assertion
- **Files**: `packages/contracts/src/operations/session.ts` · `packages/core/src/sessions/briefing.ts` (insertion point: end of `computeBriefing`)
- **Change**:
  - Add a `BriefingFieldContract` type defining max-age, dedup-key, and exclusion rules per field (e.g. `recentObservations: { maxAgeDays: 14, requireMonotonic: true }`, `relevantPatterns: { dedupBy: 'normalized_title' }`, `activeEpics: { excludeProvenance: ['test-fixture'] }`).
  - Add `assertBriefingContract(briefing): { violations: ContractViolation[] }`. Run after `computeBriefing` in `--strict` mode; in default mode emit a `warnings` field.
- **Verifiable success**: unit test feeding a stale fixture asserts a `recentObservations: stale` violation surfaces. CI runs `cleo briefing --strict` against a fixture-loaded DB and exits non-zero on violation.
- **Size**: small-medium.

**Wave 1 gate**: all three merged. The truth contract (`assertBriefingContract`) is the regression antibody for every future briefing change.

---

## WAVE 2 — Engine liveness: prove the dream cycle is alive (parallel, this week)

The code IS wired (`packages/core/src/sentient/tick.ts:483-522` properly calls `checkAndDream`). The failure is operational — the daemon process isn't running in production. Fix is to (a) make the failure visible, (b) add a redundant trigger path, (c) self-heal where possible.

### T-W2-1 — `cleo memory dream --status` CLI (liveness probe)
- **Files**: `packages/cleo/src/cli/commands/memory.ts` (extend existing `dream` subcommand) · `packages/core/src/memory/dream-cycle.ts` (export `getDreamStatus`)
- **Change**:
  - New subcommand `cleo memory dream --status` returns JSON: `{ lastConsolidatedAt, observationsSinceLastConsolidation, idleMinutesSinceLastRetrieval, tickLoopAlive: boolean, lastTickAt, dreamInFlight: boolean, lastError, isOverdue: boolean }`.
  - `isOverdue = (observationsSinceLastConsolidation > volumeThreshold * 5) OR (lastConsolidatedAt > 24h ago AND observationsSinceLastConsolidation > 0)`.
  - Exit code 1 if `isOverdue`, 0 otherwise.
- **Verifiable success**: `cleo memory dream --status` against current state returns `isOverdue: true` (we have ~1000 unconsolidated May observations).
- **Size**: small.

### T-W2-2 — Diagnose & document why `sentient/tick` isn't firing in production
- **Investigation steps** (file as a research subtask):
  1. `cleo sentient status` against live system — is the daemon running? When was last tick? `daemon-api.ts:92` exposes `lastSentientTickAt`.
  2. Inspect `~/.local/share/cleo/sentient.state.json` (per `sentient/state.ts`) for last-tick + lastError.
  3. Check kill-switch state (`cleo sentient kill --status`). Per CORE RULE in MEMORY.md, kill-switch is always respected.
  4. Decide: (a) process not started (operator never ran `cleo sentient start`), (b) crash with no restart, (c) tick loop disabled by config, (d) `dreamCycle: null` injected somewhere disabling it.
- **Output**: a 1-page doc `WHY-DREAM-DIDNT-RUN.md` in this RCASD dir + a fix decision.
- **Size**: small (likely 30 min once the above CLI is in place).

### T-W2-3 — Opportunistic dream trigger from `cleo briefing`
- **Files**: `packages/core/src/sessions/briefing.ts` (after computeBriefing returns)
- **Change**:
  - After `computeBriefing` resolves, fire `checkAndDream(projectRoot, { inline: false })` async. The existing 5-min cooldown + in-flight guard in `dream-cycle.ts:47-56` prevents over-firing.
  - Gate behind a config flag `briefing.opportunisticDream` defaulting `true`.
  - Guarantees: every `cleo briefing` call gives the dream cycle a chance to fire — turning the most-frequent BRAIN read into the engine's heartbeat (Council Expansionist Finding 4).
- **Verifiable success**: 10 rapid `cleo briefing` calls fire `checkAndDream` exactly once (cooldown holds). Unit test asserts cooldown semantics.
- **Why it's safe**: cooldown + in-flight guard are battle-tested; this adds redundancy, not a new failure mode.
- **Size**: small.

### T-W2-4 — `cleo doctor brain` health command
- **Files**: `packages/cleo/src/cli/commands/doctor.ts` (extend) · new `packages/core/src/memory/brain-doctor.ts` (or extend existing)
- **Change**: aggregate health view — table row counts, dedup ratio, last consolidation, `recentObservations` freshness check (max-age violation count), `recentLearnings` empty? (ratio: learnings/observations should be ≥0.5%; today it's 0.4%, flag), pattern bloat ratio (patterns/observations should be ≤2; today 4.4×, flag), test-fixture pollution count, sentient daemon liveness.
- **Verifiable success**: `cleo doctor brain` against current state surfaces all known issues from this RCASD as named flags. Each flag has a remediation hint pointing to the relevant W-task.
- **Size**: medium.

### T-W2-5 — Freshness sentinel as a CI gate
- **Files**: `.github/workflows/ci.yml` (or sentient-managed cron) · new `scripts/freshness-sentinel.ts`
- **Change**: a daily check that runs `cleo memory dream --status` against a canary project; alerts (issue or chat ping) if `isOverdue: true` for >24h. This is the "did the engine actually fire?" alarm.
- **Verifiable success**: deliberately stale fixture triggers the alert in CI.
- **Size**: small.

**Wave 2 gate**: T-W2-1 + T-W2-2 + T-W2-3 ship together. T-W2-4 + T-W2-5 follow within the same week.

---

## WAVE 3 — Provenance: every row carries truth (parallel, next week)

### T-W3-1 — `origin` column on `tasks` schema
- **Files**: `packages/core/src/store/migrations/` (new migration) · `packages/contracts/src/Task.ts` · `packages/core/src/tasks/ops.ts` (set origin) · briefing.ts:653 (filter)
- **Change**:
  - Migration: `ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'production' CHECK (origin IN ('production','test-fixture','imported','migrated'))`
  - Test factories in `packages/core/src/__tests__/`, `packages/studio/src/.../*.test.ts` set `origin='test-fixture'`. CI gate: lint rule rejects test code that doesn't set origin.
  - `computeActiveEpics` filters `origin='production'` only. The W0-2 heuristic filter is removed (replaced by structural enforcement).
  - Backfill: existing rows default to 'production'; a one-shot migration tags the 18 known fixtures as 'test-fixture'.
- **Verifiable success**: live `cleo briefing` after backfill no longer surfaces ANY test-fixture epic; lint rule blocks new test code that doesn't set origin.
- **Size**: medium.

### T-W3-2 — `origin` + `validated_at` on `brain_observations`
- **Files**: `packages/core/src/store/migrations/` · `packages/core/src/memory/brain-row-types.ts` · `brain-lifecycle.ts` (verifyAndStore)
- **Change**:
  - `origin: 'manual' | 'auto-extract' | 'transcript-ingest' | 'session-debrief' | 'test'` — what produced this row?
  - `validated_at: string | null` — when (if ever) ground-truth verification ran (per `cleo memory verify` per CLEO-INJECTION.md).
  - `provenance_chain: string | null` — JSON array of source observation IDs (for derived rows).
  - Briefing field contracts (W1-3) gain access to provenance: `recentObservations` filters `origin != 'test'`; high-trust mode requires `validated_at != null`.
- **Verifiable success**: every new observation written has `origin` set; `cleo doctor brain` reports provenance distribution.
- **Size**: medium.

### T-W3-3 — `cleo doctor scan-test-fixtures-in-prod` CLI
- **Files**: extend `packages/cleo/src/cli/commands/doctor.ts`
- **Change**: scan tasks.db for rows matching test heuristics (`/^E\d+$/`, `/^T\d+EP$/`, titles containing `'Test Epic'`, `'with no files'`, `'fixture'`). Flag each row with confidence score; offer interactive `--quarantine` flag that uses the T1864 quarantine pattern (move to `.cleo/quarantine/` rather than DELETE).
- **Verifiable success**: against current state, surfaces all 18 known fixture rows with the 2 active ones flagged HIGH-CONFIDENCE.
- **Size**: medium.

### T-W3-4 — Test-DB isolation enforcement
- **Files**: audit all `packages/{core,studio,cleo}/src/**/__tests__/*.ts` that touch tasks.db or brain.db
- **Change**:
  - Use in-memory SQLite (`:memory:`) or temp dirs (`os.tmpdir()`) per test suite. Never touch the project's `.cleo/`.
  - Build on T1864's `validateProjectRoot` — add `assertTestEnv()` that throws if `process.env.CLEO_TEST_MODE !== '1'` AND the resolved project root contains `/mnt/projects/cleocode/`.
  - CI gate: `pnpm test` runs with `CLEO_TEST_MODE=1`; any test that mutates the live `.cleo/tasks.db` fails the run.
- **Verifiable success**: introduce a deliberately-broken test that writes to live DB; CI fails.
- **Size**: medium-large (touches many test files).

### T-W3-5 — Auto-extract repair (the audit didn't surface)
- **Files**: `packages/core/src/memory/auto-extract.ts`
- **Investigation**: Why does `brain_learnings` have only 11 rows for 2,819 observations? Either auto-extract is disabled, the threshold is too aggressive, or it's broken silently.
- **Change**:
  - Add metrics: `auto-extract.invocations`, `auto-extract.candidates`, `auto-extract.promoted`, `auto-extract.rejected_reason_*`.
  - Surface in `cleo doctor brain` (W2-4).
  - Lower thresholds if appropriate; add unit tests asserting that 5+ matching observations produces a learning.
- **Verifiable success**: `brain_learnings` count grows after a dream cycle on a populated brain.db. `recentLearnings` in briefing is non-empty.
- **Size**: medium.

**Wave 3 gate**: T-W3-1 + T-W3-2 + T-W3-4 ship together (schema migrations bundled). T-W3-3 + T-W3-5 follow.

---

## WAVE 4 — Write-side discipline: schema-bound handoffs (next sprint)

### T-W4-1 — Structured slots on `HandoffData`
- **Files**: `packages/core/src/sessions/handoff.ts:30-49` · `packages/contracts/src/operations/session.ts`
- **Change**:
  - Add: `did: string[]` (≤10 items), `blocked: string[]`, `next: string[]`, `nextAction?: string`.
  - Cap `note` to 1,000 chars; warn at 800. Note becomes the freeform escape valve next to bounded slots.
  - Auto-populate slots from session activity:
    - `did` = `session.tasksCompleted`
    - `blocked` = `session.openBlockers`
    - `next` = top-3 from `tasks.next` (already computed by `computeNextSuggested`)
  - Operator can override any slot via `cleo session end --did "..." --blocked "..." --next "..."`.
- **Verifiable success**: new sessions ending without operator overrides still get auto-populated slots; briefing renders slots before the freeform note.
- **Size**: medium.

### T-W4-2 — Briefing `--mode pickup | fresh | debrief` (read-side incentive flywheel)
- **Files**: `packages/cleo/src/cli/commands/briefing.ts` · `packages/core/src/sessions/briefing.ts`
- **Change**:
  - `--mode pickup` (default when `currentTask` is set) — renders `did/blocked/next` slots prominently; brief note (≤200 chars truncation hint).
  - `--mode fresh` (default when `currentTask` is null) — emphasizes `nextTasks`, `activeEpics` (post-W3 filter), brain-recent slice.
  - `--mode debrief` — renders the full `DebriefData` from handoff.ts:380-401 (chain position, decisions, gitState).
  - Auto-detect when `--mode` not given.
- **Verifiable success**: each mode renders a distinct, scope-appropriate payload; orchestrator agents writing handoffs see immediate quality feedback at next session start.
- **Size**: medium.

**Wave 4 gate**: depends on W1-3 contracts (so slots have type-level enforcement).

---

## WAVE 5 — Multi-actor: per-worktree handoff key (later, after PRIME stable)

Per the user's note: "for now PRIME main orchestrator is sufficient." File the design now; ship after W1+W2+W3 are validated in production.

### T-W5-1 — ADR: per-worktree handoff schema
- **Files**: `docs/adr/ADR-068-per-worktree-handoff.md` (new)
- **Content**: design `(actor, scope, branch)` key on `session_handoff_entries`. Migration plan with backfill (`actorId='global'` for legacy rows). Contrarian Finding 2 (handoff-disappear) must be addressed in the migration test plan.
- **Size**: small (design doc).

### T-W5-2 — Implementation
- **Files**: migration + `handoff.ts` filter changes
- **Gate**: do not start until ADR is approved.
- **Size**: medium.

---

## WAVE 6 — Unification: one `assembleContext`, three callers (strategic capstone)

After W1-W4 stable.

### T-W6-1 — Define `assembleContext(actor, scope, mode, since)` primitive in core
### T-W6-2 — Migrate `cleo briefing` → `assembleContext(mode='resume')`
### T-W6-3 — Migrate `spawn-prompt.ts:1232` → `assembleContext(mode='spawn')`
### T-W6-4 — Add `mode='sibling-awareness'` for parallel-orchestrator collision detection

Reconciles the three parallel paths (briefing, spawn-prompt, getSessionMemoryContext) into one truth-carrying primitive. Council Expansionist Finding 1.

**Wave 6 gate**: Field contracts (W1-3), provenance (W3), structured handoffs (W4) must all be in production. Otherwise we unify around a broken contract.

---

## CROSS-CUTTING X — Truth observability (continuous, lands incrementally)

These are not a single wave — each W-task lands one of these as part of its acceptance criteria.

| Artifact | Lands in | Purpose |
|---|---|---|
| Field-name contract assertion | W1-3 | Briefing `--strict` exits non-zero on violation |
| `cleo memory dream --status` | W2-1 | Liveness probe with non-zero exit on overdue |
| `cleo doctor brain` | W2-4 | Truth dashboard (row counts, ratios, freshness, provenance dist, daemon liveness) |
| Freshness sentinel CI gate | W2-5 | Daily alert if dream is overdue >24h |
| `cleo doctor scan-test-fixtures-in-prod` | W3-3 | Pollution detector |
| Test-DB isolation CI gate | W3-4 | Prevents future test→prod leakage |
| Auto-extract metrics | W3-5 | Catches future "11 learnings for 2,819 observations" silently-broken state |

---

## What's deliberately OUT of scope (for now)

- **Embedding-based retrieval upgrade** — current BM25/RRF + recency mode is enough; embeddings is a separate epic.
- **Plasticity tuning** — STDP/synaptic-scaling parameters are correct in code (per T991 BRAIN Integrity); we're not retuning them.
- **Inter-orchestrator messaging** — Expansionist Finding 2's "sibling-awareness" mode is W6, not now.
- **Studio dashboard for BRAIN** — `cleo doctor brain` CLI ships first; UI is a follow-up.
- **Memory tier promotion logic changes** — T1000 already shipped typed promotion; we're not touching it.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| W1-1 mode='recency' returns nothing when DB hasn't been consolidated recently (because everything is "recent" relative to a long stale window) | Default `since=now()-30d` + log warning if result count is 0 + suggest running W2-2 dream check |
| W2-3 opportunistic dream from briefing could surprise users with background work | Cooldown holds (5min); add config flag `briefing.opportunisticDream` to disable |
| W3-1 origin migration breaks foreign keys when fixture rows are reassigned | Migration is read-only re-tagging — no DELETE, no FK changes. Quarantine is a separate operator-driven action |
| W3-4 test isolation gate breaks legitimate tests that need the live DB | Allow opt-in via `CLEO_TEST_DB_OVERRIDE=1` with audit log entry per ADR-051 pattern |
| W4-1 slot auto-population guesses wrong | Slots are advisory; freeform note remains the ground truth; operator can override |
| All-Accept peer review in Council run reflects leniency, not lane discipline | Future related runs should monitor; structured Phase 2.5 detected genuine divergence here |

## Success criteria for the epic

The system is honest when:

1. ✅ `cleo briefing` field names are enforced — `recentObservations[0]` is more recent than `[1]`, `relevantPatterns` are deduplicated, `activeEpics` excludes test fixtures (W1-3, W3-1)
2. ✅ Dream cycle observably fires — `cleo memory dream --status` returns `isOverdue: false` continuously for 7 days (W2-1, W2-2, W2-3)
3. ✅ Every BRAIN row has provenance — `origin != null` for 100% of rows; `cleo doctor brain` reports clean distribution (W3-2, W3-5)
4. ✅ Test fixtures cannot leak to prod — CI fails any test that writes to `.cleo/tasks.db` (W3-4)
5. ✅ Handoffs have schema — `did/blocked/next` slots populated; briefing `--mode pickup` renders them (W4-1, W4-2)
6. ✅ Field-contract violations fail CI — `cleo briefing --strict` is part of the canary check (W1-3, W2-5)
7. ⏳ One `assembleContext` primitive — three callers (briefing, spawn, sibling-awareness) (W6) — strategic, not in MVP

## Recommended sequencing for spawning

1. **Today** (1 hour): file W0-1 + W0-2 as a single PR. Ship to main.
2. **This week** (parallel waves):
   - One agent on W1-1 (recency mode) + W1-2 (pattern dedup) + W1-3 (contracts)
   - One agent on W2-1 (status CLI) + W2-2 (diagnose) + W2-3 (opportunistic trigger)
   - One agent on W2-4 (`doctor brain`) + W2-5 (freshness sentinel)
3. **Next week** (parallel after W1+W2 stable):
   - One agent on W3-1 (tasks.origin) + W3-3 (scanner) + W3-4 (test isolation)
   - One agent on W3-2 (observations.origin) + W3-5 (auto-extract repair)
4. **Sprint after** (depends on W1-3 contracts shipped):
   - W4-1 (slots) + W4-2 (modes)
5. **Quarter-end** (only after W1-W4 in prod for ≥2 weeks):
   - W5 design ADR
   - W6 unification

Each wave's exit criterion is "the truth check from X-table for that wave is green." No wave ships without its truth check.

## File this epic into CLEO

```bash
# After owner approval:
cleo task add --type epic --title "BBTT — BRAIN/Briefing Trust & Truth" --priority high \
  --acceptance "All 6 success criteria green | cleo doctor brain reports clean | recentObservations contract enforced | dream-cycle status overdue=false 7d | tests cannot pollute prod DB"

# Then spawn waves W0-W6 as child tasks under that epic with dependencies as documented above.
```
