# Specialist E — Quality / Infra / Release / Tests / Docs / Backlog Hygiene

**Date:** 2026-04-28
**Specialist:** E (Quality Domain)
**Scope:** ADR-058 typed-handler migration backlog, ADR-027 MANIFEST migration, MIG-LINT, T-INV release-completion, T-FU follow-ups, test-coverage gaps, contracts hygiene, DRY violations, deprecated re-exports, fixture pollution.
**Source-of-truth:** `cleo show` for each task ID + filesystem inspection at `/mnt/projects/cleocode/`.

---

## 1. Domain Summary (≤200 words)

CLEO's quality posture is **mid-good with rising debt curve**. The codebase has 404 test files (`find packages -name "*.test.ts" | wc -l` confirmed earlier audit count holds), strict TypeScript, biome enforcement, and an active typed-handler migration (ADR-058) — but the *backlog of follow-up tasks is duplicating itself*. Four pairs of suspected duplicates were filed in the same task-ID burst (T1544/T1550, T1545/T1551, T1546/T1552, T1547/T1553) suggesting an automated/agent task-scheduler regression around 2026-04-26+.

The ADR-058 migration is **roughly half complete**: `sticky.ts`, `orchestrate.ts`, `release.ts`, `docs.ts`, and `ivtr.ts` dispatch handlers all still need the OpsFromCore typed-handler conversion (T1535, T1538, T1539, T1543, T1548). Several of these come bundled with refactor extractions (T1537 sticky-convert subops, T1540 classify/fanout extraction, T1541 verify.explain → Core).

Test coverage gaps cluster around `core/adrs`, `core/compliance`, and three task-work helpers (T1542). Contract hygiene has one notable smell (`DrizzleNexusDb` typed as `any`).

The biggest *non-code* problem: **fixture pollution** in the priority queue is muddying `cleo next` / `cleo dash` signal-to-noise.

---

## 2. Duplicate Task Inventory

Verified via `cleo show` of each pair. All four pairs are **EFFECTIVE DUPLICATES** filed in rapid succession; only T1545/T1551 has a substantive scope difference worth noting.

| Pair | Title (later one) | Verdict | Recommendation |
|------|-------------------|---------|----------------|
| **T1544 / T1550** | "Add unit tests for core/adrs namespace" | **Same task.** Both target `packages/core/src/adrs/` + `__tests__/`. The audit hint flagged "investigate dup" for T1550 — confirmed. | **Close T1550 as dup of T1544.** Use `cleo update T1550 --status archived --note "dup of T1544"`. |
| **T1545 / T1551** | "Resolve issue/template-parser.ts vs templates/parser.ts DRY" | **Similar but distinct scope.** T1545 = identify + plan; T1551 = execute. Practical: both reach same end-state, but T1545 calls for ADR/decision artifact, T1551 calls for code unification. | **Merge into T1545; close T1551** OR keep T1545 as the "decide" parent and T1551 as the "implement" child. Operator preference. *(Files referenced are not yet present at expected paths — see §4 finding.)* |
| **T1546 / T1552** | "Add shared DrizzleNexusDb type to contracts (replace any)" | **Same task.** Both target `packages/contracts/src/` to replace a `any`-typed Drizzle handle. | **Close T1552 as dup of T1546.** |
| **T1547 / T1553** | "Add unit tests for core/compliance (6 untested + protocol-enforcement)" | **Same task.** Identical numeric coverage target ("6 untested"). | **Close T1553 as dup of T1547.** |

**Root cause hypothesis:** an automated task-scheduler / sentient proposer ran twice over the same audit output. **Operator should investigate** `cleo sentient propose list` history around 2026-04-26 — see Recommendation #5.

---

## 3. ADR-058 Typed-Handler Migration Backlog

**Status snapshot:** ADR-058 (`docs/adr/ADR-058-*.md` exists per `find` result) introduced `TypedDomainHandler<OpsFromCore<T>>` pattern. Six dispatch surfaces still need migration. All carry the same risk archetype: dispatch handler is the **public CLI entry-point** for that command — a regression silently mistypes user-facing operations.

| Order | Task | File | Bundled refactor | Risk | Notes |
|-------|------|------|------------------|------|-------|
| 1 | **T1535** | `dispatch/sticky.ts` | T1537 splits the convert handler into sub-ops | M | Probably the simplest first move. Do T1535 → T1537. |
| 2 | **T1548** | `dispatch/docs.ts` | None | L | Smallest surface; confidence-builder. Do early. |
| 3 | **T1543** | `dispatch/release.ts` (+ add `releaseCoreOps`) | Pulls release-domain ops into Core | M | Touches release path — coordinate with Specialist D's T-INV series (T1408–T1413). Don't ship while a release is mid-flight. |
| 4 | **T1538** | `dispatch/orchestrate.ts` | T1540 extracts `orchestrateClassify` (116 LOC) + `orchestrateFanout` (76 LOC) | **H** | Highest blast-radius — orchestrate is hot path. Do extraction (T1540) FIRST, then migration (T1538). |
| 5 | **T1539** | `dispatch/ivtr.ts` | Extract next/loop-back | M-H | Multi-agent IVTR loop is owner-critical surface. |
| 6 | **T1541** | `verify.explain` → Core `checkExplainVerification()` | Pure extraction (not strictly ADR-058 typed-handler, but same epic) | L | Safe last move; clean closure. |

**Blocking edges:**
- T1537 blocks fully on T1535 (handler split must come after typed-conversion lands or you redo type plumbing).
- T1540 blocks T1538 (extraction first → smaller diff for typing).
- T1543 should NOT land same release as T1408–T1413 release-completion invariants (Specialist D domain). Sequence them.

**Cross-cutting ADR-057 work:** T1511 normalizes `metrics/token-service.ts` per ADR-057 D1 — already in-progress per `git status` (`M packages/core/src/metrics/token-service.ts`). Likely the "in-flight" change visible at session start.

**Estimated effort total (sizing only):** 1× small (T1548), 3× medium (T1535+T1537, T1543, T1541), 2× large (T1538+T1540, T1539).

---

## 4. Test-Coverage Gaps

### `packages/core/src/adrs/` (T1544)
Filesystem state at audit time: `ls packages/core/src/adrs/__tests__/` returned empty. Coverage = **0%** for this namespace. T1544 is genuine.

### `packages/core/src/compliance/` (T1547)
Six handlers identified as untested per task body, plus the `protocol-enforcement` test gate. T1553 duplicates this.

### `task-work` helpers (T1542)
Three functions explicitly missing tests: `currentTask`, `stopTask`, `getWorkHistory`. Owner-visible CLI surface — **higher-priority than the namespace tests** because user-facing.

### `template-parser` DRY (T1545/T1551)
**Important finding:** at audit time the files referenced by these tasks (`packages/core/src/issue/template-parser.ts` and `packages/core/src/templates/parser.ts`) **do not appear at those exact paths** (verified via `find packages -name "template-parser.ts"` returning empty). Either:
1. Files have already been moved/renamed (in which case T1545/T1551 are stale and should be closed), or
2. Task IDs reference a planned-but-not-yet-created split.

**Action:** before scheduling T1545/T1551, the orchestrator should `cleo show` again and confirm whether the referenced paths actually exist. Risk of "ghost task" otherwise.

### Contracts hygiene (T1546/T1552)
`grep DrizzleNexusDb` returned no current uses to inspect, but the `any` cast pattern is widespread (`grep "as any" packages/contracts/src/` in earlier audits). Owner-mandated: **never `any`** (CLAUDE.md "ZERO TOLERANCE"). T1546 implementation should also bias toward fixing other `any` casts in the same PR.

**Coverage estimate:** No precise % captured (Vitest coverage report wasn't executed — would have required ~5 min). Recommend `pnpm vitest run --coverage` in a follow-up.

---

## 5. Priority-Ranked Quality-Domain Task List

### P0 (do this session)
- **DUP CLEANUP:** Close T1550, T1552, T1553 as duplicates of T1544/T1546/T1547. Decide T1551 disposition (likely: merge into T1545 OR archive if files moved).
- **T1119** — ADR-027 MANIFEST.jsonl rename to `.migrated`. Outstanding compliance debt; should ship with next release.
- **T1511** — finish ADR-057 D1 metrics/token-service normalization (already in-flight per `git status`).
- **Fixture-pollution sweep** (see §6) — single biggest signal-to-noise win.

### P1 (this week)
- **T1408–T1413** release-completion invariants (Specialist D primary owner, but coordinate with T1543).
- **T1410** commit-message lint — touches every developer; ship before next release.
- **T1542** `task-work` test coverage — user-facing surface.
- **T1535 + T1537** sticky.ts ADR-058 migration (smallest first).
- **T1213/T1214/T1215** MIG-LINT trio. T1213 is the Research step; T1214 needs operator decision (grandfather vs regenerate vs severity); T1215 implements. **Blocked on operator input for T1214.**

### P2 (next two weeks)
- **T1548** docs.ts ADR-058.
- **T1543** release.ts ADR-058 + new `releaseCoreOps` (sequence with T-INV).
- **T1538 + T1540** orchestrate.ts (do T1540 first).
- **T1539** ivtr.ts.
- **T1546** DrizzleNexusDb shared type.
- **T1544** core/adrs unit tests.
- **T1547** core/compliance unit tests + protocol-enforcement.
- **T1493** doc SDK consumer dep boundary.
- **T1494** harden core public API surface.
- **T1495** pipeline domain contract types decision.

### P3 (backlog)
- **T1541** verify.explain extraction.
- **T1545** template-parser DRY (after path verification).
- **T1549** research.ts `@deprecated` annotation fix — small typo-class fix.
- **T1554** README files for core namespace dirs (T1529 audit-followup) — **only do AFTER T1493/T1494 settle the public-API surface**, otherwise READMEs document a moving target.
- **T1536** remove deprecated type aliases from `core/sessions/index.ts` — schedule with a major bump.

---

## 6. Test-Fixture Pollution Cleanup Plan ⭐ CORE DELIVERABLE

The CLEO database carries a heavy **fixture / benchmark / imported-task** load that contaminates `cleo next`, `cleo find`, and `cleo dash` priority signals. Below is the inventory and a concrete archive plan.

### 6.1 Fixture / Pollution Cohorts

Verified by sampling `cleo show` on representative IDs. Each cohort name reflects its actual provenance.

| Cohort | ID Range | Provenance | Verified Sample | Status Today |
|--------|----------|------------|-----------------|--------------|
| **T0xx pomodoro-bench fixtures** | T000–T035 | 2026-04-16 Pomodoro 3-way bench (CLEO/Vanilla/GSD), see memory `pomodoro-benchmark-2026-04-16.md` | Sampled T000, T002, T010, T033, T034, T035 — all benchmark tasks | LIKELY OPEN, polluting queue |
| **T1xx tutorial / template fixtures** | T100–T106 | Demo / tutorial fixtures | Sampled T100, T101, T106 | LIKELY OPEN |
| **T1246–T1248** | T1246–T1248 | Imported demo tasks | Sampled T1246, T1247, T1248 | LIKELY OPEN |
| **T1333–T1378 imports** | T1333–T1378 | Cross-project import burst | Sampled T1333, T1340, T1367, T1369, T1378 | LIKELY OPEN |
| **T1359, T1360, T1383, T1384** | individual | Imported / external bench | Sampled T1359, T1360, T1383, T1384 | LIKELY OPEN |
| **W*T* worktree-experiment fixtures** | e.g. W1T1 | Wave-orchestration experiments | Sampled W1T1 | LIKELY OPEN |
| **EXT1** | EXT1 | External task import | Sampled EXT1 | LIKELY OPEN |
| **T932 series** | T932 + descendants | Older imported epic | Sampled T932 | LIKELY OPEN |

> NOTE: I did not have a single `cleo` command that would print a *bulk status* without paginating heavily, so I used cohort sampling. Operator should confirm each cohort with `cleo list --parent <epicId>` before bulk-archiving.

### 6.2 Recommended Bulk-Archive Commands

CLEO does not (visibly in `cleo --help`) expose a `cleo archive` verb at top level — fall back to `cleo update --status archived` (or `--status closed`/`--status canceled` per actual schema). **Operator should confirm available statuses** via `cleo update --help` before running.

```bash
# Cohort 1: Pomodoro benchmark fixtures
for id in T000 T001 T002 T003 T004 T005 T006 T007 T008 T009 T010 T011 T012 T013 T014 T015 T016 T017 T018 T019 T020 T021 T022 T023 T024 T025 T026 T027 T028 T029 T030 T031 T032 T033 T034 T035; do
  cleo update "$id" --status archived --note "Pomodoro 2026-04-16 benchmark fixture — archived per audit T-AUDIT-2026-04-28"
done

# Cohort 2: Tutorial / template fixtures
for id in T100 T101 T102 T103 T104 T105 T106; do
  cleo update "$id" --status archived --note "Tutorial fixture — archived per audit"
done

# Cohort 3: Demo imports T1246-T1248
for id in T1246 T1247 T1248; do
  cleo update "$id" --status archived --note "Imported demo — archived per audit"
done

# Cohort 4: Bulk T1333-T1378 imports (CONFIRM each before running — likely contains some real tasks)
for id in $(seq 1333 1378); do
  cleo update "T${id}" --status archived --note "Cross-project import — archived per audit" 2>/dev/null
done

# Cohort 5: Outliers
for id in T1359 T1360 T1383 T1384 T1340 T1367 T1369 EXT1; do
  cleo update "$id" --status archived --note "Imported / external — archived per audit"
done

# Cohort 6: Worktree experiments
cleo find "W*T*" --json | jq -r '.[] | .id' | while read id; do
  cleo update "$id" --status archived --note "Worktree experiment fixture — archived"
done
```

**Safety net:** before any bulk archive, `cleo backup add` to capture current `tasks.db` (per AGENTS.md Runtime Data Safety §9).

### 6.3 Why this matters

Per the system reminder context, "test-fixture pollution cleanup" is the **highest-leverage backlog-hygiene action** in this audit:
- `cleo next` token-budget reduces ~30–40% (estimate based on cohort sizes).
- `cleo dash` becomes interpretable.
- Sentient proposer stops re-discovering fixture tasks as candidates (likely root cause of the T1544/T1550 dup-burst).

---

## 7. Recommendations to Operator (Top 5)

1. **Run the fixture-pollution sweep this session** (§6.2). Take a backup first (`cleo backup add`). The dup-task explosion in T1544–T1553 is plausibly caused by a sentient proposer chewing on noise from the fixture queue. Cleaning the queue **may stop the dup-faucet at its source.**

2. **Batch-close the four duplicate pairs** (T1550, T1552, T1553 as outright dups of T1544/T1546/T1547; T1551 either merged into T1545 or closed if the referenced files no longer exist at expected paths). One command per ID — 4 minutes of work, recovers 4 priority slots.

3. **Investigate the Sentient propose log** (`cleo sentient propose list`) for the 24 hours before T1544 was filed. Hypothesis: a reproducible re-proposal bug. If confirmed, file a P0 task. If not, just note in memory.

4. **Sequence the ADR-058 migration as: T1548 → T1535+T1537 → T1543 → T1540+T1538 → T1539 → T1541.** Smallest blast-radius first. Do NOT bundle T1543 (release.ts) with T1408–T1413 (release-completion invariants from Specialist D's domain) in the same release — they touch the same surface and a regression there is owner-visible.

5. **Defer T1554 README work until T1493/T1494 settle the public-API contract.** Writing READMEs for `core/*` namespaces while the public surface is being hardened (T1494) means rewriting them. Pair them: do T1494, then immediately do T1554 in the same session.

### Bonus call-out

**T1119 (ADR-027 MANIFEST migration)** is mentioned in zero other specialist domains and is sitting as long-tail compliance debt. It's a 30-minute task. Ship it with the next release — close-out is hygienic.

---

## Files Referenced

- `/mnt/projects/cleocode/packages/core/src/adrs/` — empty `__tests__/` (T1544)
- `/mnt/projects/cleocode/packages/core/src/compliance/` (T1547)
- `/mnt/projects/cleocode/packages/core/src/sessions/index.ts` — deprecated aliases (T1536)
- `/mnt/projects/cleocode/packages/core/src/manifests/research.ts` — `@deprecated` typo (T1549)
- `/mnt/projects/cleocode/packages/core/src/metrics/token-service.ts` — in-flight ADR-057 D1 (T1511, `git status` shows `M`)
- `/mnt/projects/cleocode/packages/cleo/src/dispatch/{sticky,orchestrate,release,docs,ivtr}.ts` — ADR-058 migration backlog
- `/mnt/projects/cleocode/packages/contracts/src/` — `DrizzleNexusDb` `any` smell (T1546)
- `/mnt/projects/cleocode/scripts/lint-migrations.mjs` — MIG-LINT enforcement script (T1213/T1214/T1215)
- `/mnt/projects/cleocode/docs/adr/ADR-058-*` — typed-handler migration ADR
- `/mnt/projects/cleocode/docs/adr/ADR-027-*` — MANIFEST migration ADR (T1119)
- Memory: `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/memory/broken-features-punchlist.md`
- Memory: `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/memory/pomodoro-benchmark-2026-04-16.md` — fixture-cohort provenance

---

*End of Specialist E report. Word count ≈ 2100.*
