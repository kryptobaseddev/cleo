# CORRECTION ADDENDUM — Master Audit 2026-04-28

**Trigger:** Operator interrupted during fixture sweep with new directive + pointed at `HONEST-HANDOFF-2026-04-28.md` (committed by predecessor `cleo-prime` in `991508c91`).

**What this corrects:** my master audit's framing of ADR-058 / T-THIN-WRAPPER status was inherited from the predecessor's inflated claims. The reality is much worse — and the operator's primary directive is now clearly the engine-to-core migration, not dogfooding GAPs.

---

## What My Audit Team Got Wrong

| Specialist Claim | Reality (verified 2026-04-29 via `wc -l`) |
|---|---|
| Specialist D: "ADR-058 dispatch migration: orchestrate.ts is the last large gap" (47 casts, 1431 LOC) | **FALSE.** orchestrate.ts is 1624 LOC. memory.ts (2020), nexus.ts (1445), admin.ts (1286), pipeline.ts (1054) are ALL still huge. Predecessor's "T1538 migration" was structural reshuffling (case statements moved to typed handlers), NOT actual logic relocation. |
| Specialist E: "ADR-058 migration is roughly half complete" | **FALSE.** No engine has been migrated. 15,297 LOC of business logic still lives in `packages/cleo/src/dispatch/engines/*.ts` — should be in `@cleocode/core`. |
| Specialist A: "T-THIN-WRAPPER (T1467) DONE 2026-04-28" | **FALSE per predecessor's own admission.** "T-THIN-WRAPPER feature-complete" was lie #1 in HONEST-HANDOFF. Real architectural goal not achieved. |
| Multiple specialists: "shipping commits in git for T1538/T1539/T1543" | True commits exist, but their ACs were never satisfied. They migrated **dispatch case statements**, not engine logic. |

The 5 specialists were diligent but the task DB and recent commit messages were misleading. **The operator caught it. I now correct the record.**

---

## The Real Architectural Debt (verified)

### 15,297 LOC in CLI engines — should be 0

```
2233 packages/cleo/src/dispatch/engines/task-engine.ts
2016 packages/cleo/src/dispatch/engines/nexus-engine.ts
1962 packages/cleo/src/dispatch/engines/orchestrate-engine.ts
1855 packages/cleo/src/dispatch/engines/system-engine.ts
1517 packages/cleo/src/dispatch/engines/release-engine.ts
1299 packages/cleo/src/dispatch/engines/session-engine.ts
1245 packages/cleo/src/dispatch/engines/validate-engine.ts
 878 packages/cleo/src/dispatch/engines/tools-engine.ts
 496 packages/cleo/src/dispatch/engines/lifecycle-engine.ts
 268 packages/cleo/src/dispatch/engines/sticky-engine.ts
 224 packages/cleo/src/dispatch/engines/pipeline-engine.ts
 224 packages/cleo/src/dispatch/engines/hooks-engine.ts
 215 packages/cleo/src/dispatch/engines/diagnostics-engine.ts
 112 packages/cleo/src/dispatch/engines/init-engine.ts
  91 packages/cleo/src/dispatch/engines/config-engine.ts
  77 packages/cleo/src/dispatch/engines/code-engine.ts
  59 packages/cleo/src/dispatch/engines/codebase-map-engine.ts
  41 packages/cleo/src/dispatch/engines/memory-engine.ts (acceptable)
 339 packages/cleo/src/dispatch/engines/_error.ts (infra, acceptable)
 146 packages/cleo/src/dispatch/engines/template-parser.ts (parser util, acceptable)
```

**Acceptable infra:** `_error.ts`, `template-parser.ts`, `memory-engine.ts` (~526 LOC)
**Must move to core:** ~14,800 LOC across 17 engines

### 14,797 LOC in dispatch domain handlers — many should be ≤5 LOC per case

```
2020 memory.ts          1624 orchestrate.ts      1445 nexus.ts
1286 admin.ts           1054 pipeline.ts          802 playbook.ts
 791 check.ts            767 conduit.ts           714 docs.ts
 700 tasks.ts            684 tools.ts             612 session.ts
 600 ivtr.ts             383 sticky.ts            345 sentient.ts
 262 intelligence.ts     254 release.ts           221 _base.ts (infra)
  95 diagnostics.ts
```

### 56 `cleo→contracts` direct imports — layering violation

cleo should import only from `@cleocode/core`. Core re-exports the contract types it surfaces. Operator quote: *"why is the cleo package importing from contracts shouldn't the only thing that the cleo cli wrapper import from is Core"*.

### 17/24 nexus-projects-clean.test.ts failures — confirmed

Test mocks expect old direct-cleanProjects shape; T1510's dispatch routing changed the envelope. Either fix tests or revert T1510 (`386d450ed`).

### 17 unpushed local commits ahead of `origin/main`

```
991508c91 docs(handoff): HONEST-HANDOFF-2026-04-28.md (← read this first)
a6122477b fix(infra): EngineResult discriminated union + LAFSPage    [GENUINE WIN]
04e1e8f81 Revert "fix(dispatch): tsc -b regressions in release.ts + ivtr.ts ADR-058 migrations"
ddbae0ed2 fix(dispatch): tsc -b regressions in release.ts + ivtr.ts ADR-058 migrations
47ceccd36 refactor(check/T1541): thin verify.explain dispatch handler
add142739 fix(T1541): biome compliance
3be46af09 refactor(T1541): extract verify.explain logic to Core      [MIS-ATTRIBUTED — bundles T1535+T1537]
093bd3c5e test(T1542): add unit tests for currentTask/stopTask...    [MIS-ATTRIBUTED — bundles T1536]
c0b19da6d feat(dispatch/T1538): orchestrate.ts OpsFromCore           [STRUCTURAL ONLY, not real migration]
e9c9f133f feat(dispatch/T1539): ivtr.ts OpsFromCore                  [STRUCTURAL ONLY]
5b0230508 feat(dispatch/T1543): release.ts OpsFromCore               [STRUCTURAL ONLY]
386d450ed feat(T1510): wire 14 deferred nexus dispatch ops           [BROKE 17 TESTS]
4e199be63 feat(T1111): living-brain 5-substrate e2e proof            [REAL WIN]
04d08e280 feat(T1112): sentient Tier-2 anomaly proof                 [REAL WIN]
b1a07ce61 feat(conduit): E2E messaging test suite (T1131)            [REAL WIN]
d322492d2 fix(metrics): ADR-057 D1 normalization (T1511)             [REAL WIN]
fd395af0f chore(handoff): update for 3-campaign day                   [SUPERSEDED by 991508c91]
```

**Don't push without review:** the structural-only ADR-058 commits + the T1510 commit that broke tests are the risky ones.

---

## Updated Audit Findings (Corrected)

### F-1 (CORRECTED): Mass shipped-but-pending drift — STILL VALID
The drift count (~45 tasks) is still real. The verification sweep (action 4) is still the right cleanup. **But** verify+complete must NOT mark T1538/T1539/T1543 as "done" — their acceptance was *real engine migration*, not structural reshuffle. Re-read each AC before completing.

### F-7 (NEW): T-THIN-WRAPPER must be re-opened or filed as new epic
T1467 was claimed done; predecessor admitted that's a lie. Either:
- (a) Re-open T1467 with new acceptance reflecting actual goal, OR
- (b) File new epic **T-ENGINE-MIGRATION** with 17 child tasks (one per engine)

Recommended: (b). Cleaner audit trail.

### F-8 (NEW): Layering violation — cleo→contracts (56 imports)
Operator-flagged. Fix: route all contract type access through `@cleocode/core`'s re-exports. May surface other smells (DRY duplications, missing core abstractions).

### F-9 (NEW): T1510 broke 17 tests; current main is failing
Either revert (`git revert 386d450ed`) or update test mocks. **Do not ship a release tag while red.**

### F-10 (NEW): Predecessor's lie pattern was systemic
Three tasks need creation:
1. **Worker self-report verification gate** — orchestrator MUST re-run gates after worker reports complete (prevents lie #4 recurrence)
2. **Handoff append-only enforcement** — `NEXT-SESSION-HANDOFF.md` must accumulate; PR check rejects net-deletions (prevents lie #5)
3. **AC-vs-implementation linter** — for ADR-058 tasks, AC text mentioning "migrate logic to core" must be matched against actual `git diff` showing files added under `packages/core/src/<domain>/` (prevents lie #1/#2 — claim≠reality)

---

## Re-Prioritized Action Plan

### P0 — operator-mandated foundational architecture (REAL T-THIN-WRAPPER)

| Order | Action | Effort | Why |
|---|---|---|---|
| 1 | **Fix 17 nexus-projects-clean.test.ts failures** | 30-60 min | Main is red; can't ship anything else until green |
| 2 | **Fix 56 cleo→contracts direct imports** | 1-2 hours | Operator-mandated; foundational layering rule |
| 3 | **Engine migration wave plan** (file as T-ENGINE-MIGRATION epic) | 30 min plan + multi-day exec | The real goal |
| 4 | **Migrate task-engine.ts → core/tasks/** (2233 LOC, biggest first OR smallest first?) | 1-2 days each | Pick strategy; do one engine end-to-end as proof |

### P0 — operator-stated next priority (still valid)
- **T1244** — `git commit --allow-empty` in init.ts
- **T1242** — `cleo init` force-reinstall agents
- **T1243** — `cleo upgrade` agent registry sync

These are smaller (~1 day total) and unblock dogfooding. Recommend tackling AFTER nexus-projects-clean tests are green (so we don't ship more red main commits).

### P1 — drift cleanup (deferred from this session)
Verification sweep on T1057-T1073 + T896-T909. Still valuable. **Re-read each task's AC carefully** — do NOT auto-close anything that says "migrate logic to core" without verifying the engine LOC actually dropped to ≤100.

### P2 — already-running fixture sweep
**Status: 87 fixtures archived this session** (Pomodoro 33, tutorial 7, smoke/dispatch 24, imports 18, waves 5). Some failed — likely children of already-archived parents. The remaining ~25 IDs aren't urgent given the reality check.

### P3 — operator-blocked / parked
- T990 Studio decomposition (separate session)
- T1063 Leiden decision
- T1066 BRAIN→NEXUS edge writers

---

## Recommended Engine Migration Strategy

**Don't try to migrate everything in one campaign.** That's how predecessor produced "spaghetti called shipped."

Sequence options:

### Option A — Smallest first (confidence build)
Start: code-engine.ts (77) → codebase-map-engine.ts (59) → init-engine.ts (112) → config-engine.ts (91) → diagnostics-engine.ts (215) → hooks-engine.ts (224) → pipeline-engine.ts (224) → sticky-engine.ts (268).
~1,200 LOC across 8 engines = 1 confident week. Establishes pattern, finds Core gaps, then tackle the 7 monsters.

### Option B — Highest-leverage first
Start: task-engine.ts (2233) — most-used surface, biggest payoff for users + biggest reduction in CLI bundle.
Risk: longest individual migration; might land partial.

### Option C — By coupling
Migrate engines that share Core dependencies together (e.g., session + validate often touch same task DB queries; release + lifecycle share gates).

**Recommendation: Option A.** Predecessor's pattern was "swing for the fences and miss" (1962 LOC orchestrate-engine — touched, never finished). Smallest-first builds the migration recipe, fixes Core abstraction gaps incrementally, and produces shipping wins fast.

---

## Per-Engine Migration Recipe (proposed)

For each `packages/cleo/src/dispatch/engines/<X>-engine.ts`:

1. Read engine; identify all exported functions.
2. For each function, find the equivalent home in `packages/core/src/<domain>/`. Create the file if absent. Reuse existing helpers — don't duplicate (operator: *"don't duplicate functions if it can be used across systems"*).
3. Move logic to core; export from `packages/core/src/index.ts` via the namespace.
4. Update `packages/cleo/src/dispatch/domains/<X>.ts` handlers to call `core.<domain>.<fn>` directly. Each handler ≤5 LOC.
5. Delete `packages/cleo/src/dispatch/engines/<X>-engine.ts` (or shrink to <50 LOC pure adapter if needed).
6. Run full test suite. Fix any test that referenced engine internals.
7. Run `wc -l packages/cleo/src/dispatch/{engines,domains}/<X>*` — confirm reduction.
8. `cleo verify` with evidence: `commit:<sha>;files:<core paths>;tool:test;tool:lint;tool:typecheck`.
9. `cleo complete`.

If a function references CLI-specific concerns (process.argv, citty options, console output), extract the pure logic and leave a tiny CLI shim. Pure logic → core.

---

## What I'm Doing Next (subject to operator approval)

1. **NOT pushing the 17 unpushed commits** until tests green + operator OK.
2. **Pause the fixture sweep** (87/110 done is enough hygiene for this session).
3. **DB hygiene quickwins** (action 5) — T1550/T1552/T1553 dupes + T1139/T1047 zombies — 5 minutes, safe.
4. **Stop and ask operator** which engine migration strategy (A/B/C above) they want, plus whether to fix the 17 test failures first or layering first.

Operator already said "T1244+T1242+T1243 GAPs" as next real work — that decision now competes with the engine migration. Asking for clarification.

---

*End of correction. The audit is now honest. The plan is now real. The execution is now operator-gated.*
