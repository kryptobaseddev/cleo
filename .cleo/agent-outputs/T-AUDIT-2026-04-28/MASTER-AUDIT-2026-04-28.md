# MASTER AUDIT — CLEO Code Ecosystem (2026-04-28)

**Auditor team**: 5 specialists run in parallel (Architecture, Studio/UI, Intelligence, Orchestration, Quality)
**HEAD**: `fd395af0f` (main, v2026.4.154)
**Active scope**: 461 tasks (279 pending / 26 active / 141 done / 15 cancelled). Grand total 1575 incl. 1114 archived.
**Source reports**: `SPECIALIST-{A,B,C,D,E}-*.md` in this directory.

---

## TL;DR — One Pattern Dominates

**The single biggest issue is SHIPPED-BUT-PENDING DRIFT.** Across 5 independent audits, every specialist found the same failure mode:

> **Code shipped → tests passing → commits in git → task remains `pending` because verification gates were never run.**

Conservative count: **~45+ tasks** are in this drifted state (≈ 16% of pending). The dashboard, `cleo next`, and the sentient proposer all consume this signal-noise. The problem also has a meta-irony: T1407/T-INV epic was created specifically to prevent this drift, and it is itself in the same drifted state — it shipped its self-enforcing tool (`cleo reconcile release`) but never ran it on itself.

The second-biggest issue is **task-DB pollution**: ~70+ test-fixture / benchmark / imported-task IDs are inflating the priority queue (T000-T035 pomodoro, T100-T106 tutorial, T1333-T1378 cross-project imports, T1246-T1248, T932 series, W*T*, EXT1, etc.). Specialist E estimates this is 30-40% of `cleo next` token budget.

The third-biggest issue is **duplicate filings inside epic T1555** (filed 2026-04-28): four duplicate task pairs (T1544/T1550, T1545/T1551, T1546/T1552, T1547/T1553) — likely caused by sentient proposer firing twice on the same audit output.

**The "real outstanding work" backlog is much smaller than the dashboard suggests** — probably ~25-35 genuinely-open tasks once drift, dupes, and fixtures are cleaned.

---

## Cross-Domain Findings (Confirmed by Multiple Specialists)

### F-1 — Mass shipped-but-pending drift (Specialists A + C + D corroborate)

| Cluster | Count Pending | Count Actually Shipped | Detection method |
|---|---|---|---|
| T896-T909 (Orchestration Coherence v3) | 14 | 12 fully + 2 partial | Specialist D verified each commit/file |
| T1408-T1413 (T-INV release invariant) | 6 | 6 fully | Specialist D — commits `5153dd477`, `ee0e55592`, `a10994cc5`, `c4b9b27ea` |
| T1057-T1073 (Nexus tri-epic children) | 17 | 16 of 17 with shipping commits | Specialist C — `git log --grep T10[5-7][0-9]` returned 28+ commits |
| T1010, T1011, T1012, T1030 (Sentient Tier 3) | 4 | 3 fully (1 partial) | Specialist A — `tick.ts` 1059 LOC + `merge.ts` + `revert*.ts` confirmed |
| T948 (SDK + REST issue #97) follow-ups | 1 (T1493) | T948 itself DONE 2026-04-27 | Specialist A — verification.passed=true |
| T1131 (conduit Phase 4) | 0 (closed today) | done 2026-04-28T22:03:51Z | Specialist D |

**Total: ~40+ tasks in this drifted state.**

### F-2 — Test-fixture pollution sweep (Specialist E core deliverable, A confirms partial)

Confirmed cohorts:
- **T0xx pomodoro-bench fixtures**: T000-T035 (~36 tasks, from 2026-04-16 3-way bench)
- **T1xx tutorial / template fixtures**: T100-T106 (7 tasks)
- **Import bursts**: T1246-T1248, T1333-T1378 (~46 tasks like "JWT tokens (imported)", "Auth API (imported)")
- **Wave/external fixtures**: W1T1, W2T1, W2T2, W3T1, W3T2, W3T3, EXT1, T-cap-001, T932*, E1
- **Implementation-child fixtures**: T1359, T1360, T1383, T1384, T1340, T1367, T1369
- **Dispatch smoke-tests**: T1052, T1053 (Specialist A finding)

**Sweep recovers ~30-40% signal-to-noise on `cleo next` and `cleo dash`.** Backup `tasks.db` first via `cleo backup add`.

### F-3 — Four duplicate task pairs in T1555 (Specialist A + E both detected)

| Earlier ID | Later ID | Verdict | Action |
|---|---|---|---|
| T1544 | T1550 | Outright dup ("Add unit tests for core/adrs namespace") | Archive T1550 |
| T1545 | T1551 | Same target, scope-shifted (plan vs execute) | Merge or archive T1551 |
| T1546 | T1552 | Outright dup ("Add shared DrizzleNexusDb type") | Archive T1552 |
| T1547 | T1553 | Outright dup ("Add unit tests for core/compliance") | Archive T1553 |

Root cause hypothesis (Specialist E): sentient proposer ran twice on the same audit output. Investigate `cleo sentient propose list` history around 2026-04-26.

### F-4 — Real P0 dogfooding blockers (Specialist D)

| ID | Surface | Confirmed by grep | Effect |
|---|---|---|---|
| T1244 | worktree on unborn HEAD | `init.ts` lacks `git commit --allow-empty` | Every fresh `cleo init` → WARN, no isolation |
| T1242 | `cleo init` force-reinstall agents | seed-install.ts no `agent install --force` | 4 D-003 errors per fresh init |
| T1243 | `cleo upgrade` registry sync | `cleo upgrade` 7 actions, none touch registry | Migration ergonomics broken |

All small/medium. **All three together = 1 day of work.** Unblock new-project demos & tutorials.

### F-5 — Zombie tasks (Specialist A)

| ID | Status | Reality |
|---|---|---|
| T1139 | pending under cancelled parent T1106 | Superseded by T1147 (DONE) — `brain-reconciler.ts:14` says: *"This module absorbs the T1139 scope"* |
| T1047 | pending CRITICAL | Superseded by T1048 (V2 RECOMMENDATION-v2.md). V1 had MCP-server task that violates AGENTS.md |
| ADR-060 | missing | `docs/adr/` jumps 059→061. No git log result. Either fill slot or document intentional skip |

### F-6 — T990 Studio is shadow-executed off-graph (Specialist B)

T990 has `childRollup.total: 0` despite 5 waves shipped (Wave 0 + 1A-1E reports at `.cleo/agent-outputs/T990-design-work/`). **35-task decomposition already exists** at `.cleo/agent-outputs/T990-decomposition/WAVE-PLAN.md` — it was authored 2026-04-20 but never materialized as child tasks. Result: T990 is permanently unverifiable as currently filed. Of its 13 acceptance criteria: ~5 done, 4 partial, 2 not started, 2 architecturally done but operator-validation pending.

---

## Mass-Action Recommendations (Highest ROI)

These are **batch operations** that close many drifted tasks in one shot. Run them BEFORE adding any new code work.

### A-1: Run `cleo reconcile release --tag v2026.4.146` ⭐ TOP ROI
Specialist D: **Single CLI invocation** that closes T1408-T1413 (the T-INV epic) AND likely catches ~13 additional shipped-but-pending tasks across v2026.4.142-.154. Also serves as live proof-of-correctness for T1411. Estimated: 10 minutes.

### A-2: Verification sweep across T1057-T1073
Specialist C: 17 tri-epic children, 16 with shipping commits, ZERO verified. Run `cleo verify <id> --gate implemented --evidence "commit:<sha>;files:<list>"` + `tool:test` per task → `cleo complete`. Estimated: 30 min, converts ~13 pending → done. Re-frames the tri-epic from "stalled" to "ready to release."

### A-3: Verification pass for T896-T909
Specialist D: 14 tasks shipped, all pending. Single audited script. Each: `cleo verify <id> --evidence` then `cleo complete`. Estimated: 1-2 hours, closes the entire Orchestration Coherence v3 epic in one session.

### A-4: Verification pass for T1010-T1012 + T1030 (Tier 3 Sentient)
Specialist A: 4 tasks, code at `packages/core/src/sentient/{tick.ts,merge.ts,revert*.ts,kill-switch.ts,allowlist.ts,baseline.ts}`. Same playbook as T948. Estimated: 1-2 hours.

### A-5: DB hygiene sweep
- Archive 4 duplicates: T1550, T1551 (or merge), T1552, T1553 — 4 minutes.
- Close T1139 as superseded-by:T1147 — 1 minute.
- Cancel T1047 with note "superseded by T1048" — 1 minute.
- T948 follow-up T1493 close — 5 minutes.

### A-6: Test-fixture pollution archive sweep (Specialist E §6.2)
~70+ fixture IDs across 6 cohorts. **Backup `tasks.db` first**. Bulk-archive via shell loops:
```bash
cleo backup add  # MANDATORY safety net
for id in T000 T001 T002 ... T035; do cleo update "$id" --status archived --note "Pomodoro bench fixture — audit T-AUDIT-2026-04-28"; done
# (full script in SPECIALIST-E §6.2)
```
Estimated: 20 min, recovers 30-40% signal-to-noise.

### A-7: Decompose T990 into the 35 waiting children
Specialist B: Wave plan already authored at `.cleo/agent-outputs/T990-decomposition/WAVE-PLAN.md`. Script bulk-create T990-WA-001 ... T990-WE-*. Then retroactively `cleo verify` Wave 0 + 1A-1E children with `--evidence "files:<wave reports>"`. Estimated: 30-60 min.

---

## Genuinely Outstanding Work (After Drift Cleanup)

A small, focused list. Each is real new code or real spec.

### P0 (block dogfooding / new projects)
1. **T1244** — `git commit --allow-empty` in `init.ts` for unborn HEAD (5 line edit, small)
2. **T1242** — `cleo init` force-reinstall agents at project tier (medium)
3. **T1243** — `cleo upgrade` agent registry sync (medium, shares plumbing with T1242)

### P1 (real spec/code work)
4. **ADR-058 dispatch wave** — T1548 docs.ts, T1535+T1537 sticky.ts, T1543 release.ts, T1540+T1538 orchestrate.ts, T1539 ivtr.ts, T1541 verify.explain extraction. Sequence: smallest blast-radius first (T1548 → T1535+T1537 → T1543 → T1540+T1538 → T1539 → T1541). DO NOT ship T1543 same release as T1408-T1413.
5. **T1029 + T1030 + T1032** — Sentient Tier-3 architecture decision: extract `abort.ts` + `experiment-runner.ts` from `tick.ts` per spec OR rewrite acceptance to point at `tick.ts` as SSoT. (Spec call needed, then medium impl.)
6. **T1066** — BRAIN→NEXUS edge writers (`documents`, `modified_by`, `mentions`, `affects`). Confirmed-missing per Specialist C; downstream T1068/T1069 SDK return partial cross-substrate context until fixed.
7. **T1063** — Leiden community detection or formal defer (ADR accepting Louvain ceiling). 13× community-count gap vs gitnexus.
8. **T1139** — BRAIN auto-reconcile semantic conflict + auto-supersession. Stage=implementation, 12 ACs, large surface. (Note: NOT T1147 which is shipped.)
9. **T1494** — harden `core/src/index.ts` public API surface (56 namespace exports; needs scope clarification first).

### P2 (proof-of-life / proof-of-correctness)
10. **T1111** — 5-substrate end-to-end Living Brain sandbox proof. Owner-flagged "theater-breaker." Companion to T1112 (DONE). Without it, the Living Brain pitch is unverifiable.
11. **T1072 liveness** — confirm Hebbian rows now strengthen + STDP rows now write in production data (BUG-1/BUG-2/BUG-3 closed in code, no liveness proof).
12. **T1532/T1533/T1534** — dialectic evaluator iteration + telemetry + AST route shape inference.

### P3 (operator-blocked or low-value)
13. **T990 acceptance #7** — Code page GitNexus reference. Blocked on operator sharing reference code.
14. **T990 acceptance #13** — Operator page-by-page review on `localhost:3456`. Blocks epic close.
15. **T1214** — MIG-LINT-02 approach decision (grandfather/regenerate/severity). Blocks T1215 implementation.
16. **T1554** — README files for core namespaces. Defer until T1494 settles public-API surface (else moving target).

---

## Architecture Decisions Needed (Small, Operator Required)

| Decision | Options | Owner | Effort |
|---|---|---|---|
| T1029/T1030 split vs `tick.ts` SSoT | (a) Extract `abort.ts` + `experiment-runner.ts` (~200 LOC churn, cleaner for forge-ts); (b) Document tick.ts as SSoT, rewrite ACs (pragmatic) | Owner | 15 min |
| ADR-060 slot | (a) Fill with retrospective doc; (b) Document intentional skip in ADR-061 | Owner + author | 15 min |
| T990 route taxonomy | (a) Rename `/brain/{observations,decisions,...}` → `/memory/*` + 301 redirects; (b) Edit T990 acceptance #2 to align with `/brain/*` | Owner | 10 min |
| T990 epic re-scope | (a) Decompose now into 35 children + retro-verify waves; (b) Scope down to "Owner Review + Decomposition Hardening" + file sibling T990-IMPL | Owner | 5 min decision |
| T1063 Leiden ship vs defer | (a) Rust/JS port; (b) ADR formally accepting Louvain ceiling | Owner | Decision now, impl later |
| T1494 public API scope | What counts as "wildcard"? Namespace exports vs flat re-exports | Owner | 10 min |

---

## Recommended Session Flow

**This session (high leverage, low risk):**
1. `cleo backup add` (safety net)
2. A-1: `cleo reconcile release --tag v2026.4.146` → catches T1408-T1413 + ~13 sibling tasks
3. A-5: DB hygiene — close T1550/T1552/T1553, cancel T1047, supersede T1139
4. A-6: Fixture-pollution sweep (after backup)
5. A-2: Verification sweep on T1057-T1073 (~13 closures)

**Next session (real work):**
6. P0: Fix T1244 + T1242 + T1243 as one wave (~1 day)
7. P1: ADR-058 sequence starting with T1548 (smallest)
8. P1: T1066 edge writers investigation + ship if needed

**Ongoing:**
9. P1: T1494 + T1554 paired session
10. P2: T1111 5-substrate proof (theater-breaker)

---

## Test-Fixture Pollution Inventory (For Sweep Script)

```
T000 T001 T002 T003 T004 T005 T006 T007 T008 T009
T010 T011 T012 T013 T014 T015 T016 T017 T018 T019
T020 T021 T022 T023 T024 T025 T026 T027 T028 T029
T030 T031 T032 T033 T034 T035                        # Pomodoro 36
T100 T101 T102 T103 T104 T105 T106                   # Tutorial 7
T200 T201 T300 T301 T400 T401 T402 T500 T503 T600
T601 T602 T603 T604 T605 T606 T701 T702 T800 T802 T810   # smoke fixtures
T1052 T1053                                          # dispatch smoke
T1246 T1247 T1248                                    # output-pollution
T1332-T1378 (sample: T1333 T1334 T1335 T1336 T1337
  T1338 T1339 T1340 T1349 T1354 T1355 T1356 T1361
  T1362 T1363 T1364 T1365 T1366 T1367 T1368 T1369
  T1374 T1376 T1377 T1378)                          # imports ~25
T1340 T1367 T1369                                    # imported test
T1359 T1360 T1383 T1384                              # Implementation-child
T932 T932W T932WX T932E T932EP                       # T932 series
T-cap-001 EXT1                                       # external/cap
W1T1 W2T1 W2T2 W3T1 W3T2 W3T3                        # waves
E1                                                   # test epic
```

**Total ≈ 110 IDs** to archive.

---

## Gates Hygiene Action Items

After mass closure rituals run, these should be the standing rules going forward:

1. Every `cleo orchestrate spawn` worker MUST run `cleo verify ... --evidence` before `cleo complete`. (Already in CLEO-INJECTION.md but enforcement is loose.)
2. Every release `git tag` MUST be followed by `cleo reconcile release --tag <tag>` (T1411 already implements; just needs to run).
3. Sentient proposer should not re-propose tasks based on already-archived parents. (T1555 dup-burst likely caused by this.)
4. CI gate: refuse `git tag` if any child of "current release epic" has unverified gates. (Future work; possibly T-INV-7.)

---

## Files Written by This Audit

- `SPECIALIST-A-ARCHITECTURE.md` — Tier 3 + SDK (138 lines)
- `SPECIALIST-B-STUDIO.md` — Studio T990 (131 lines)
- `SPECIALIST-C-INTELLIGENCE.md` — Nexus tri-epic (148 lines)
- `SPECIALIST-D-ORCHESTRATION.md` — Agent registry + T-INV (228 lines)
- `SPECIALIST-E-QUALITY.md` — ADR-058 + dupes + fixtures (226 lines)
- `MASTER-AUDIT-2026-04-28.md` — this file

---

*End of master audit. Total tasks examined across all specialists: ~150+ unique IDs. Total commits scanned: ~150+ across last 6 weeks. Total code files cross-referenced: ~40+.*
