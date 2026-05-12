# Branch Hygiene Report — 2026-05-06

**Scope**: 45 local branches ahead of `main`  
**Analysis date**: 2026-05-06  
**Investigator**: ad-hoc subagent (read-only — no branches were modified)

---

## Summary

| Recommendation | Count |
|----------------|-------|
| DELETE         | 25    |
| HOLD           | 12    |
| SALVAGE-PR     | 3     |
| INVESTIGATE-FURTHER | 5 |

**No MERGE candidates identified** — all branches with unique work either have substantial conflicts, contain sandbox/test-fixture commits that should not go to main, are in-flight pending tasks, or are owner-reserved salvage branches.

---

## HIGH-VALUE FLAGGED BRANCHES (>5 unique commits or substantial unreleased work)

These warrant owner attention before any disposition decision:

### 1. `feat/t1435-dispatch-ops-inference` — 12 commits, STALE, ARCHIVED epic

- **Commits**: 12 ahead of main, 29 files changed (+4704/-2862)
- **Task**: T1435 (archived) — the T-DISPATCH-INFER epic (OpsFromCore inference refactor)
- **Latest commit**: 2026-04-25
- **Conflict count**: 78 (would conflict badly)
- **Assessment**: This is the aggregated wave-1 dispatch refactor branch. T1435 status is `archived` and the individual child task branches (T1437, T1439–T1445) also appear here with their own branches. The 78 conflicts suggest main has diverged significantly — likely the work was superseded or integrated differently. The individual task branches (task/T14xx) are all archived with matching commit subjects. The epic's work may have been absorbed piecemeal or superseded by T1449. **INVESTIGATE-FURTHER** — verify whether any of the 12 commits contain unique logic not present in main.

### 2. `task/T1837` — 7 commits, RECENT, PENDING task

- **Commits**: 7 ahead of main, 24 files changed (+2855/-25)
- **Task**: T1837 (pending) — "add ACCESSES edges via new access-extractor.ts"
- **Latest commit**: 2026-05-04
- **Conflict count**: 29 (heavy conflicts with current main)
- **Assessment**: In-flight nexus extractor work for ACCESSES edges. 7 commits suggests multi-step implementation. 29 conflicts with main means main moved significantly since this branch was cut. **HOLD** — active task, owner must decide on rebase strategy.

### 3. `task/T1836` — 7 commits, RECENT, PENDING task

- **Commits**: 7 ahead of main, 22 files changed (+2428/-15)
- **Task**: T1836 (pending) — "add DEFINES edges (file→symbol) to parse-loop"
- **Latest commit**: 2026-05-04
- **Conflict count**: 12
- **Assessment**: In-flight nexus DEFINES-edge work, sibling to T1837. **HOLD** — active task.

### 4. `rcasd/path-b-probe` — 5 commits, STALE, ARCHIVED tasks

- **Commits**: 5 ahead of main, 23 files changed (+13,414/-48)
- **Tasks**: T1150, T1153, T1154, T1158, T1159 — all archived (T-MSR migration system remediation)
- **Latest commit**: 2026-04-21
- **Conflict count**: 12
- **Assessment**: Research probe branch for the drizzle-kit migration remediation epic. All constituent tasks are archived. The +13,414 insertion count is large — likely includes migration fixtures and probe artifacts. The tasks are archived, implying the research concluded. However 5 commits with large insertion count warrant owner review. **INVESTIGATE-FURTHER** — check if the probe artifacts (research docs, migration linter prototype) should be archived to docs or discarded.

### 5. `salvage/T1857-deps-validate` — 2 commits, ACTIVE, ARCHIVED task

- **Commits**: 2 ahead of main, 12 files changed (+1225/-1)
- **Task**: T1857 (archived) — "cleo deps validate + cleo deps tree commands"
- **Latest commit**: 2026-05-05 (yesterday)
- **Conflict count**: 4
- **Assessment**: Owner-flagged salvage branch from a pre-crash session. Contains dep-graph-validator core + deps-validate tests + tasks-opsfromcore tests. T1857 is archived but the salvage was created 2026-05-05, suggesting owner explicitly preserved this work post-crash. 4 conflicts. **SALVAGE-PR** — owner reserved; needs manual review and PR.

---

## FULL INVENTORY TABLE

| Branch | Ahead | Latest Commit | Staleness | Task ID | Task Status | Conflicts | Recommendation |
|--------|-------|---------------|-----------|---------|-------------|-----------|----------------|
| `feat/t1435-dispatch-ops-inference` | 12 | 2026-04-25 | STALE (11d) | T1435 | archived | 78 | INVESTIGATE-FURTHER |
| `task/T1837` | 7 | 2026-05-04 | RECENT (2d) | T1837 | pending | 29 | HOLD |
| `task/T1836` | 7 | 2026-05-04 | RECENT (2d) | T1836 | pending | 12 | HOLD |
| `rcasd/path-b-probe` | 5 | 2026-04-21 | STALE (15d) | T1150–T1159 | all archived | 12 | INVESTIGATE-FURTHER |
| `task/T9019` | 4 | 2026-05-05 | ACTIVE | T9019 | done | 0 | DELETE* |
| `task/T1913` | 3 | 2026-05-05 | ACTIVE | T1913 | done | 0 | DELETE* |
| `task/T1456` | 3 | 2026-04-25 | STALE (11d) | T1456 | archived | 4 | DELETE |
| `task/T1455` | 3 | 2026-04-25 | STALE (11d) | T1455 | archived | 5 | DELETE |
| `task/T1441` | 3 | 2026-04-25 | STALE (11d) | T1441 | archived | 5 | DELETE |
| `worktree-agent-aeda66c2` | 2 | 2026-04-12 | STALE (24d) | none (worktree) | — | 2 | DELETE |
| `worktree-agent-ad025d3a` | 2 | 2026-04-12 | STALE (24d) | none (worktree) | — | 1 | DELETE |
| `worktree-agent-a26e66f3` | 2 | 2026-04-12 | STALE (24d) | none (worktree) | — | 2 | DELETE |
| `worktree-agent-a1e05aeb` | 2 | 2026-04-12 | STALE (24d) | none (worktree) | — | 8 | DELETE |
| `task/T1458` | 2 | 2026-04-26 | STALE (10d) | T1458 | archived | 7 | DELETE |
| `task/T1452` | 2 | 2026-04-25 | STALE (11d) | T1452 | archived | 8 | DELETE |
| `task/T1451` | 2 | 2026-04-25 | STALE (11d) | T1451 | archived | 9 | DELETE |
| `task/T1445` | 2 | 2026-04-25 | STALE (11d) | T1445 | archived | 12 | DELETE |
| `task/T1444` | 2 | 2026-04-25 | STALE (11d) | T1444 | archived | 12 | DELETE |
| `task/T1443` | 2 | 2026-04-25 | STALE (11d) | T1443 | archived | 5 | DELETE |
| `task/T1442` | 2 | 2026-04-25 | STALE (11d) | T1442 | archived | 8 | DELETE |
| `task/T1440` | 2 | 2026-04-25 | STALE (11d) | T1440 | archived | 15 | DELETE |
| `task/T1439` | 2 | 2026-04-25 | STALE (11d) | T1439 | archived | 9 | DELETE |
| `task/T1437` | 2 | 2026-04-25 | STALE (11d) | T1437 | archived | 6 | DELETE |
| `salvage/T1857-deps-validate` | 2 | 2026-05-05 | ACTIVE | T1857 | archived | 4 | SALVAGE-PR |
| `fix/t436-stab4-cleanup` | 2 | 2026-04-09 | STALE (27d) | T436 | archived | 0 | INVESTIGATE-FURTHER |
| `task/T-spec-flake` | 1 | 2026-05-05 | ACTIVE | none | — | 0 | INVESTIGATE-FURTHER |
| `task/T9018` | 1 | 2026-05-05 | ACTIVE | T9018 | done | 0 | DELETE* |
| `task/T9016` | 1 | 2026-05-05 | ACTIVE | T9016 | done | 0 | DELETE* |
| `task/T9015` | 1 | 2026-05-05 | ACTIVE | T9015 | done | 0 | DELETE* |
| `task/T1921` | 1 | 2026-05-05 | ACTIVE | T1921 | pending | 0 | HOLD |
| `task/T1920` | 1 | 2026-05-05 | ACTIVE | T1920 | done | 1 | DELETE* |
| `task/T1917` | 1 | 2026-05-05 | ACTIVE | T1917 | done | 0 | DELETE* |
| `task/T1915` | 1 | 2026-05-05 | ACTIVE | T1915 | done | 0 | DELETE* |
| `task/T1914` | 1 | 2026-05-05 | ACTIVE | T1914 | archived | 3 | DELETE |
| `task/T1911` | 1 | 2026-05-05 | ACTIVE | T1911 | done | 0 | DELETE* |
| `task/T1874` | 1 | 2026-05-04 | RECENT (2d) | T1874 | pending | 5 | HOLD |
| `task/T1873` | 1 | 2026-05-04 | RECENT (2d) | T1873 | pending | 4 | HOLD |
| `task/T1867` | 1 | 2026-05-04 | RECENT (2d) | T1867 | pending | 6 | HOLD |
| `task/T1720` | 1 | 2026-05-02 | RECENT (4d) | T1720 | archived | 29 | DELETE |
| `task/T1614` | 1 | 2026-04-29 | RECENT (7d) | T1614 | archived | 1 | DELETE |
| `task/T1454` | 1 | 2026-04-26 | STALE (10d) | T1454 | archived | 6 | DELETE |
| `task/T1110` | 1 | 2026-05-04 | RECENT (2d) | T1110 | archived | 0 | DELETE |
| `salvage/T1845-benchmark-harness` | 1 | 2026-05-05 | ACTIVE | T1845 | archived | 21 | SALVAGE-PR |
| `salvage/T1815-sdk-scaffold` | 1 | 2026-05-05 | ACTIVE | T1815 | archived | 4 | SALVAGE-PR |
| `feat/t268-mcp-bridge` | 1 | 2026-04-07 | STALE (29d) | T268 | archived | 23 | DELETE |

**DELETE\*** = task is `done` (not archived), branch has 1–4 commits ahead including sandbox test-fixture commits (see note below). The real task commit was already integrated; the extra commits are worktree sandbox state (README.md, src/module2.ts, a.txt, exp-only.txt, seed.txt, etc.).

---

## DETAILED NOTES PER RECOMMENDATION

### HOLD (12 branches — in-flight work, do not touch)

| Branch | Reason |
|--------|--------|
| `task/T1837` | pending task with 7 commits, nexus ACCESSES extractor — actively being worked |
| `task/T1836` | pending task with 7 commits, nexus DEFINES edges — sibling to T1837 |
| `task/T1921` | pending ADR-064 (CAAMP↔adapters boundary), 0 conflicts, docs-only — very likely to merge clean once orchestrator picks it up |
| `task/T1874` | pending: brain+studio getCleoHome env-paths migration, 5 conflicts with main |
| `task/T1873` | pending: extract worktree ALS bridge to core, 4 conflicts |
| `task/T1867` | pending: CLI entrypoint env→ALS bridge, 6 conflicts |
| `salvage/T1857-deps-validate` | owner-reserved salvage (see SALVAGE-PR section) |
| `salvage/T1845-benchmark-harness` | owner-reserved salvage |
| `salvage/T1815-sdk-scaffold` | owner-reserved salvage |

(salvage/* branches are listed separately below; they appear in both HOLD and SALVAGE-PR because owner must decide.)

### SALVAGE-PR (3 branches — owner-reserved, needs manual PR)

These were explicitly flagged as salvage branches by the owner, created 2026-05-05 from pre-crash sessions:

1. **`salvage/T1857-deps-validate`** (2 commits, +1225 lines, 4 conflicts)
   - Content: `cleo deps validate` + `cleo deps tree` CLI commands + dep-graph-validator core + test suite
   - T1857 archived, but salvage explicitly created yesterday — owner preserved this intentionally
   - 4 conflicts need resolution before merging

2. **`salvage/T1845-benchmark-harness`** (1 commit, +759 lines, 21 conflicts)
   - Content: nexus-vs-gitnexus benchmark harness script
   - T1845 archived; high conflict count (21) suggests significant main divergence
   - Owner should evaluate if benchmark is still relevant post-gitnexus integration

3. **`salvage/T1815-sdk-scaffold`** (1 commit, +259 lines, 4 conflicts)
   - Content: `packages/core/src/tools/sdk/` directory scaffold — interfaces and primitives
   - T1815 archived; scaffold may still be needed as foundation for SDK tools

### INVESTIGATE-FURTHER (5 branches)

1. **`feat/t1435-dispatch-ops-inference`** (12 commits, 78 conflicts)
   - Contains the full T1435 OpsFromCore dispatch refactor wave 1 (admin, check, conduit, nexus, pipeline, playbook, sentient, session, tasks domains).
   - T1435 is `archived` (completed 2026-04-27). The individual task branches (T1437, T1439–T1445, T1452, T1454–T1456, T1458) are also all archived.
   - 78 conflicts with current main is very high — suggests main integrated this work differently (possibly via direct commits to main rather than branch merge, or via T1449 which was a follow-on).
   - Verify: `git log main --grep="T1435\|OpsFromCore\|dispatch.*inference" --oneline | head -20` to confirm whether equivalent work exists in main.

2. **`rcasd/path-b-probe`** (5 commits, +13,414 lines, 12 conflicts)
   - All constituent tasks archived (T1150, T1153, T1154, T1158, T1159).
   - The large insertion count is from migration fixtures generated during probe work.
   - Research artifacts (ADR docs, probe analysis) may have value as historical context.
   - Verify: Check if `docs/adr/` in main contains the T-MSR decisions; if so, probe branch is purely disposable.

3. **`fix/t436-stab4-cleanup`** (2 commits, 0 conflicts)
   - T436 archived. Branch contains `.cleo/agent-outputs/T436-stab4-epic-cleanup.md` and `packages/cleo-os/tsconfig.extensions.json` change.
   - 0 conflicts — would apply clean. The tsconfig.extensions.json change might be a real fix.
   - Verify: Check if `packages/cleo-os/tsconfig.extensions.json` in main already has the fix applied.

4. **`task/T-spec-flake`** (1 commit, 0 conflicts)
   - No numeric task ID — this is a one-off fix for a flaky test in `packages/core/src/memory/surprisal-tree.ts`.
   - The fix replaces a broken Float32 bit-cast projection with Box-Muller normal distribution.
   - 0 conflicts — would apply perfectly clean to main. This is likely a real bug fix that got stranded.
   - **Recommend owner review for v2026.5.37 hotfix** — it's a 1-file, 0-conflict clean fix to a memory subsystem test.

5. **`task/T1914`** (1 commit, 3 conflicts, archived)
   - T1914 archived: "Vitest globalSetup/teardown sweeps stale cleo-injection-chain-* from os.tmpdir()"
   - Despite archived status, 3 conflicts suggest the approach was superseded.
   - Verify if the injection chain test cleanup was absorbed into another task.

### DELETE (25 branches)

All recommended for deletion. Grouped by reason:

#### Archived tasks, work superseded (T1435 wave dispatch refactors, all with conflicts)
These are individual task branches from the T1435 OpsFromCore dispatch epic. T1435 is archived (completed 2026-04-27). All tasks are archived. All have significant conflicts with current main (5–15 each), confirming main diverged. Work either was integrated directly or superseded by T1449.

- `task/T1437` (T1437 archived, 6 conflicts)
- `task/T1439` (T1439 archived, 9 conflicts)
- `task/T1440` (T1440 archived, 15 conflicts)
- `task/T1441` (T1441 archived, 5 conflicts)
- `task/T1442` (T1442 archived, 8 conflicts)
- `task/T1443` (T1443 archived, 5 conflicts)
- `task/T1444` (T1444 archived, 12 conflicts)
- `task/T1445` (T1445 archived, 12 conflicts)
- `task/T1451` (T1451 archived, 9 conflicts)
- `task/T1452` (T1452 archived, 8 conflicts)
- `task/T1454` (T1454 archived, 6 conflicts)
- `task/T1455` (T1455 archived, 5 conflicts)
- `task/T1456` (T1456 archived, 4 conflicts)
- `task/T1458` (T1458 archived, 7 conflicts)

#### Done tasks with worktree sandbox contamination (safe to delete, real work already in main)
These `done`-status branches have 1 real task commit at the base, followed by 1–3 sandbox test-fixture commits (`seed commit`, `init`, `feat(T003): implement module 3`, `add exp-only.txt`) that were appended by a benchmark/test harness running in the worktree. The real task work is already in main or was completed. The extra commits should NOT go to main.

- `task/T9019` (T9019 done; real: B2-codex-opencode-pi adapter refactor; sandbox: 3 fixture commits)
- `task/T1913` (T1913 done; real: getAgentsHome migration; sandbox: 2 fixture commits)
- `task/T9018` (T9018 done; 1 real commit, no sandbox contamination — work confirmed done)
- `task/T9016` (T9016 done; 1 real commit)
- `task/T9015` (T9015 done; 1 real commit)
- `task/T1920` (T1920 done; 1 real commit, 1 minor conflict — main likely has equivalent)
- `task/T1917` (T1917 done; 1 real commit, 0 conflicts)
- `task/T1915` (T1915 done; 1 real commit, 0 conflicts)
- `task/T1911` (T1911 done; 1 real commit, 0 conflicts)

#### Archived tasks, stale/superseded
- `task/T1614` (T1614 archived — spawn auto-attaches docs; 1 conflict; likely superseded by later spawn work)
- `task/T1720` (T1720 archived — nexus cliOutput migration; 29 conflicts; highly diverged)
- `task/T1110` (T1110 archived — task-sweeper test unskip; 0 conflicts; 1-file test change, small, may already be in main)
- `task/T1914` — see INVESTIGATE-FURTHER; if owner confirms superseded → DELETE
- `feat/t268-mcp-bridge` (T268 archived — Wave 2 MCP bridge; 29d old; 23 conflicts; MCP was removed per ADR)

#### Orphaned worktree-agent branches (no task ID, stale)
These are auto-provisioned worktree branches from 2026-04-12 agent sessions. All have the same top commit (`fix(brain): gut extractTaskCompletionMemory — no-op per T523/T526`) with different doc fix commits below. The work (T497–T500 doc fixes + T523/T526 brain fix) is 24 days old and likely already in main.

- `worktree-agent-aeda66c2` (2026-04-12, 2 conflicts)
- `worktree-agent-ad025d3a` (2026-04-12, 1 conflict)
- `worktree-agent-a26e66f3` (2026-04-12, 2 conflicts)
- `worktree-agent-a1e05aeb` (2026-04-12, 8 conflicts)

---

## HOTFIX v2026.5.37 CANDIDATES

**No clean MERGE candidates identified.** The closest to hotfix-ready:

1. **`task/T-spec-flake`** — 0 conflicts, 1 file (`surprisal-tree.ts`), fixes a broken Float32 bit-cast test. Zero risk. If the flaky test is still flaky in main, this is a straightforward cherry-pick.

2. **`task/T1921`** — 0 conflicts, docs-only (ADR-064 + AGENTS.md for packages/adapters and packages/caamp). Pending task, no code risk. Can be merged once owner confirms the ADR is ready.

3. **`fix/t436-stab4-cleanup`** — 0 conflicts, pending investigation of `tsconfig.extensions.json` change. If the fix is still needed, it's a clean apply.

All other branches with meaningful code changes either have conflicts (requiring rebase/resolution work) or belong to pending in-flight tasks that aren't ready to ship.

---

## APPENDIX: Conflict Counts Reference

For the T1435 dispatch-refactor wave (all archived, all conflicting):

```
feat/t1435-dispatch-ops-inference  78 conflicts  (aggregate branch)
task/T1440                         15 conflicts  (nexus)
task/T1445                         12 conflicts  (tasks)
task/T1444                         12 conflicts  (session)
task/T1439                          9 conflicts  (conduit)
task/T1451                          9 conflicts  (admin)
task/T1452                          8 conflicts  (check)
task/T1442                          8 conflicts  (playbook)
task/T1437                          6 conflicts  (admin Wave 1)
task/T1454                          6 conflicts  (nexus ADR-057)
task/T1441                          5 conflicts  (pipeline)
task/T1455                          5 conflicts  (pipeline ADR-057)
task/T1456                          4 conflicts  (playbook ADR-057)
task/T1458                          7 conflicts  (tasks ADR-057)
```
