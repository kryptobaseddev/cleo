# INVENTORY-A1: CLEO Task DB State — Epics & Tasks

> Generated: 2026-04-28 | Source: live `cleo` CLI against `.cleo/tasks.db`
> Verified against: git HEAD `b4aa64f5f` (v2026.4.152), npm `2026.4.152`
> Read-only snapshot — no tasks modified.

---

## Summary Counts

| Status | Count |
|--------|-------|
| Pending | 270 |
| Active | 26 |
| Blocked | 0 |
| Done | 87 |
| Cancelled | 10 |
| **Total live** | **393** |
| Archived | 1115 |
| **Grand total** | **1508** |

Active session: `ses_20260427151947_d01102` ("T-THIN-WRAPPER campaign"), started 2026-04-27.
Dashboard `currentTask`: T1445 (done — session focus not updated post-campaign).

---

## Active Epics (status: active)

These 8 epics are in `active` state.

| ID | Title | Priority | Children | Notes |
|----|-------|----------|----------|-------|
| T603 | Epic (untitled) | high | 1 pending | No description, no timestamp. Test/scaffolding artifact. |
| E1 | Test Epic | medium | 0 | Test artifact; no real children. |
| T932EP | T932 standalone epic with no files | high | 0 | Test/integration epic; no children. |
| T1337 | Epic: Auth (imported) | medium | 2 pending | Imported test data. |
| T1349 | Epic: Auth (imported-2) | medium | 0 | Imported test artifact. |
| T1354 | Epic: Auth (imported-3) | medium | 2 pending | Imported test artifact. |
| T1374 | Epic: Auth (imported-4) | medium | 0 | Imported test artifact. |
| T1376 | Epic: Auth (imported-5) | medium | 2 pending | Imported test artifact. |

**Finding**: All 8 active epics are either test artifacts (T603, E1, T932EP) or imported data artifacts (T1337, T1349, T1354, T1374, T1376). None are real project epics in flight. The active epics list is effectively noise — real in-progress work is tracked via pending epics with pending children.

---

## Pending Epics (status: pending) — Prioritized

### TIER 1 — Critical + High Priority, Actionable Now

#### T1407 — Self-enforcing release-completion invariant
- **Priority**: high | **Size**: large | **Updated**: 2026-04-25
- **Title**: Epic: Self-enforcing release-completion invariant — typed archive enum + post-release reconciliation hook
- **Description**: Promotes `archiveReason` from free-form TEXT to a typed enum (6 values: verified, reconciled, superseded, shadowed, cancelled, completed-unverified). Adds post-release git hook that parses T\d+ IDs from commit/tag messages and auto-stamps status=done with verified provenance.
- **Children**: 6 pending
  - T1408 | pending | high — T-INV-1: Migrate archiveReason TEXT → enum (drizzle migration + CHECK constraint)
  - T1409 | pending | high — T-INV-2: Promote archiveReason literal to typed enum in contracts
  - T1410 | pending | high — T-INV-3: Commit-message lint rule mandating T\d+ IDs in release commits
  - T1411 | pending | high — T-INV-4: Post-release reconciliation hook (parser + DB updater + audit log)
  - T1412 | pending | medium — T-INV-5: ADR documenting the release-completion invariant
  - T1413 | pending | high — T-INV-6: Test suite — hook integration, migration round-trip, lint fallthrough
- **Blocked by**: Nothing
- **AC summary**: archiveReason migrated; 6 enum values; commit-msg lint rule; reconciliation hook; ADR filed; CI gate on last 10 tags
- **Status**: Fully decomposed. Wave is ready to spawn.

#### T1461 — Disk-space hygiene
- **Priority**: high | **Size**: medium | **Updated**: 2026-04-26
- **Title**: Disk-space hygiene: orchestrate worktree leak, getProjectRoot trap, pnpm node-modules bloat
- **Children**: 3 pending
  - T1462 | pending | high — fix(orchestrate): worktree leak — auto-cleanup on cleo complete
  - T1463 | pending | high — fix(paths): getProjectRoot trap — refuse parent .cleo dirs lacking sibling .git
  - T1464 | pending | medium — perf(spawn): per-worktree node_modules bloat investigation
- **Blocked by**: Nothing
- **AC summary**: cleo complete auto-removes worktree+branch; getProjectRoot walk-up refuses bad .cleo dirs; node_modules dedup or shared hoisting
- **Overlap**: T1466 overlaps (worktree cleanup verbs). T1461 owns the auto-trigger; T1466 owns the explicit CLI verbs.
- **Status**: Fully decomposed. Wave is ready to spawn.

#### T1466 — T-CLEANUP-WORKTREE: Wire automated worktree cleanup
- **Priority**: high | **Size**: medium | **Updated**: 2026-04-26
- **Title**: T-CLEANUP-WORKTREE: Wire automated worktree cleanup + node_modules dedup
- **Children**: 0 (no children filed yet — epic needs decomposition)
- **Blocked by**: Nothing
- **AC summary**: `cleo orchestrate worktree-complete <taskId>` verb; `cleo orchestrate worktree-cleanup [--epic|--all|--backfill]` verb; post-complete hook
- **Overlap**: Overlaps T1461 (T1461 handles auto-trigger; this handles explicit CLI verbs). Should be decomposed into child tasks mirroring T1462-T1464 scope, or merged with T1461.
- **Status**: Needs decomposition OR merge with T1461 to avoid duplicate work.

#### T1465 — Dynamic provider/model architecture
- **Priority**: high | **Size**: large | **Updated**: 2026-04-26
- **Title**: Dynamic provider/model architecture — eliminate hardcoded model strings, build provider/model taxonomy
- **Children**: 0 (no children filed)
- **Blocked by**: Nothing
- **AC summary**: Design note + role-taxonomy spec; phased migration plan; zero hardcoded model strings in spawn instructions
- **Status**: Epic-level only. Needs RCASD planning and decomposition before agent work.

#### T1434 — Eliminate 104 TS errors
- **Priority**: high | **Size**: large | **Updated**: 2026-04-25
- **Title**: Eliminate 104 TS errors blocking Release Type Check — ship v2026.4.145 fully green
- **Children**: 0 (no children filed)
- **Blocked by**: Nothing
- **AC summary**: `pnpm exec tsc -b` exits 0; zero inline types in dispatch files; repo-wide tests green
- **Status**: Superseded? The T-THIN-WRAPPER campaign (T1467, done) and T-DISPATCH-INFER (T1435, done) may have already resolved many/all of these 104 TS errors. **Verify** before filing children: run `pnpm exec tsc -b` to confirm actual remaining count.

#### T1428 — T988 cleanup epic (cast reduction)
- **Priority**: medium | **Size**: small | **Updated**: 2026-04-25
- **Title**: T988 cleanup epic — final cast reduction across 7 dispatch domains
- **Children**: 0 (no children filed)
- **Status**: Small scope. Possibly obsolete given T1435+T1467 campaigns are done. Verify if casts still exist.

#### T1429 — Brain-stdp deflake
- **Priority**: medium | **Size**: small | **Updated**: 2026-04-25
- **Title**: Brain-stdp deflake — T682-3 + perf-safety asserts (T1113 collateral cleanup)
- **Children**: 0 (no children filed)
- **Status**: P1 priority per MASTER-BACKLOG. Apply skip pattern to 3 remaining flaky brain-stdp tests. ~30 min effort.

#### T1212 — T-MIG-LINT-CLEAN
- **Priority**: medium | **Size**: medium | **Updated**: 2026-04-22
- **Title**: T-MIG-LINT-CLEAN: Clean up 33 RULE-3 migration linter WARNs (pre-baseline snapshot)
- **Children**: 3 pending
  - T1213 | pending | medium — MIG-LINT-01: Audit all 33 RULE-3 warnings + categorize by fix type
  - T1214 | pending | medium — MIG-LINT-02: Pick approach (grandfather allowlist vs regex)
  - T1215 | pending | medium — MIG-LINT-03: Implement chosen approach in lint-migrations
- **Blocked by**: Nothing
- **Status**: Fully decomposed. Sequential dependency (T1213→T1214→T1215).

#### T1403 — Pump #1: Post-deploy execution gap
- **Priority**: high | **Size**: medium | **Updated**: 2026-04-24
- **Title**: Pump #1: Close post-deploy execution gap (CI ships code but no stage runs it)
- **Children**: 0 (no children filed)
- **AC summary**: Release workflow adds post-tag `execute-payload` stage; verifies npm view exit 0 for all packages
- **Status**: Needs decomposition. P1 priority per MASTER-BACKLOG.

#### T1404 — Pump #2: Parent-closure-without-atom
- **Priority**: high | **Size**: medium | **Updated**: 2026-04-24
- **Title**: Pump #2: Close parent-closure-without-atom (epics complete with verification=null)
- **Children**: 0 (no children filed)
- **AC summary**: `cleo complete <epicId>` for type=epic requires evidence OR auto-emits merkle(children.evidence); archival of epic with verification=null blocked
- **Status**: Needs decomposition. P1 priority per MASTER-BACKLOG. Prerequisite: T1403.

---

### TIER 2 — Critical Priority, Owner/Planning Required

#### T1232 — PRE-WAVE: CLEO Agents Architecture Remediation
- **Priority**: critical | **Size**: large | **Updated**: 2026-04-23
- **Title**: PRE-WAVE: CLEO Agents Architecture Remediation for v2026.4.110
- **Description**: Owner-mandated fix of agents architecture. 4-tier precedence already shipped. Key gaps: cleanup seed-agents to generic templates only; move cleo-specific personas to .cleo/cant/agents/; reconcile registry vs filesystem.
- **Children**: 3 pending
  - T1242 | pending | critical — GAP: cleo init must force-reinstall agents at project tier
  - T1243 | pending | high — GAP: cleo upgrade must include agent registry reconciliation
  - T1244 | pending | medium — GAP: worktree provisioning needs initial commit on fresh git repo
- **Blocked by**: Nothing explicitly
- **Status**: Partially decomposed. 3 gaps filed. Needs full wave execution.

#### T1106 — CLOSE-ALL + real-world sandbox proof
- **Priority**: critical | **Size**: large | **Updated**: 2026-04-21
- **Title**: CLOSE-ALL + real-world sandbox proof — v2026.4.102 blocker
- **Description**: v2026.4.101 shipped with silent scope reductions. Owner demands zero-deferral proof of living brain working end-to-end in REAL sandbox, not synthetic tests.
- **Children**: 1 pending (T1139 — BRAIN auto-reconcile)
- **Blocked by**: Nothing
- **Note**: The majority of child tasks (T1104/T1105/T1108-T1117/T1130-T1132) appear to be orphaned from this epic — they have no parentId despite being RB/RC/RE/RF/RA/Phase3/Phase4 tasks clearly scoped to this epic's CLOSE-ALL campaign. This is a **parentId linkage gap**.
- **Status**: Effectively stalled at v2026.4.101 era. May need owner to determine if still relevant or superseded by more recent campaigns.

#### T942 — Sentient CLEO Architecture Redesign
- **Priority**: critical | **Size**: large | **Updated**: 2026-04-18
- **Description**: Meta-epic covering: state SSoT unification; ontology refactor with CANT-alignment; brain_page_nodes as universal semantic graph; Tier1/2/3 autonomy loop with Ed25519 signed receipts; llmtxt adoption.
- **Children**: 0
- **Blocked by**: Requires RCASD planning session before agent work
- **Status**: P3. Major owner-required scoping before any agent action.

#### T1135 — CLEO-OBSERVABILITY
- **Priority**: critical | **Size**: large | **Updated**: 2026-04-21
- **Title**: CLEO-OBSERVABILITY: vendor-agnostic agent event bus + orchestrator tail
- **Description**: Orchestrator cannot see streaming output of spawned workers; 4 parallel orchestrators raced on main with no cross-visibility. Needs: `cleo event append` SDK op; `cleo event tail --agent <id>` streaming; structured JSONL log.
- **Children**: 0
- **Blocked by**: Nothing explicitly
- **Status**: No decomposition. Needs RCASD/planning before agent work.

#### T1136 — CLEO-PROVENANCE
- **Priority**: critical | **Size**: large | **Updated**: 2026-04-21
- **Title**: CLEO-PROVENANCE: every commit traces to a Task ID
- **Description**: Workers created commits without leading Task IDs. Pre-commit hook enforcing `type(T####):` pattern needed. `cleo orchestrate spawn` must inject mandatory Task ID.
- **Children**: 0
- **Blocked by**: Nothing explicitly
- **Status**: No decomposition. Related to T1407 T-INV-3 (commit-msg lint). **Possible overlap with T1407 T-INV-3** — check before decomposing independently.

#### T1250 — META: CLEO agent-ergonomics
- **Priority**: high | **Size**: large | **Updated**: 2026-04-23
- **Title**: META: CLEO agent-ergonomics — compress 312-op surface for deterministic LLM use
- **Description**: 312 operations across 15 domains is too large for LLMs to use deterministically. Design high-level workflow wrappers; promote skills/playbooks as primary entry; instrument BRAIN-first auto-lookup; Wave 9 Conduit.
- **Children**: 0
- **Blocked by**: Nothing
- **Status**: No decomposition. Owner-scoped meta-epic.

---

### TIER 3 — Lower Priority or Deferred

#### T1054 — Nexus P0: Core Query Power
- **Priority**: critical | **Size**: large | **Updated**: 2026-04-20
- **Description**: Epic 1 of cleo nexus far-exceed decomposition. No children filed.
- **Children**: 0
- **Note**: EP1-T1 through EP1-T5 tasks (T1057-T1061) are **orphaned** — they belong to this epic but have no `parentId`. Same pattern for EP2 (T1062-T1065 → T1055) and EP3 (T1066-T1074 → T1056).

#### T1055 — Nexus P1: Competitive Closure
- **Priority**: high | **Size**: large | **Updated**: 2026-04-20
- **Children**: 0 (EP2-T1 through EP2-T4 orphaned)

#### T1056 — Nexus P2: Living Brain Completion
- **Priority**: critical | **Size**: large | **Updated**: 2026-04-20
- **Children**: 0 (EP3-T1 through EP3-T8 orphaned, plus T1130-T1132)
- **Status**: P3 per MASTER-BACKLOG. Requires owner prioritization.

#### T1137 — CLEO-AGENT-LIFECYCLE
- **Priority**: high | **Size**: medium | **Updated**: 2026-04-21
- **Title**: CLEO-AGENT-LIFECYCLE: worker runaway prevention + scope boundary enforcement
- **Children**: 0
- **Status**: No decomposition.

#### T1042 — Cleo Nexus vs GitNexus: Far-Exceed Analysis
- **Priority**: critical | **Size**: large | **Updated**: 2026-04-20
- **Children**: 0
- **Note**: T1047 (synthesis) and T1048 (revised synthesis) are orphaned tasks belonging to this epic.

#### T1007 — Sentient Loop Completion — Tier 2 Proposals + Tier 3
- **Priority**: high | **Size**: large | **Updated**: 2026-04-19
- **Children**: 0
- **Status**: Superseded partially by T1008 (shipped in master-sentient-v2).

#### T990 — EPIC: Studio UI/UX Design System
- **Priority**: critical | **Size**: large | **Updated**: 2026-04-21
- **Children**: 0
- **Status**: P3. Requires owner design direction; not agent-executable without it.

#### T911 — EPIC: Install Canonical Layout + Sandbox Harness Coverage
- **Priority**: high | **Size**: large | **Updated**: 2026-04-18
- **Children**: 1 pending (T1405 — Fix claude-sdk adapter smoke + CleoOS doctor root handling)
- **Status**: T1405 is actionable now. P1 per MASTER-BACKLOG.

#### T889 — EPIC: Orchestration Coherence v3
- **Priority**: high | **Size**: large | **Updated**: 2026-04-17
- **Children**: 0
- **Status**: v3 likely superseded by the Orchestration Coherence v1 epic (T1323, done 2026-04-24). Needs audit.

#### T631 — EPIC: Cleo Prime Orchestrator Persona (Bulldog AGI)
- **Priority**: low | **Size**: large | **Updated**: 2026-04-16
- **Children**: 0
- **Status**: Low priority; deferred.

---

### Test/Import Artifacts (Pending Epics — Noise)

These are test/scaffolding epics that should be reviewed for cleanup:

| ID | Title | Note |
|----|-------|------|
| T800 | Task T800 | Generic test epic |
| T810 | Task T810 | Generic test epic |
| T939 | Test epic for T929 lifecycle bug | Test artifact |
| T940 | Test epic for T929 bug v2 | Test artifact |
| T941 | Test epic T929 alias fix | Test artifact |
| T1346 | My epic | Test artifact |
| T1347 | Epic | Test artifact |
| T1348 | Epic | Test artifact |
| T1351 | Epic | Test artifact |
| T1352 | Epic | Test artifact |
| T1353 | Epic | Test artifact |
| T1358 | Test Epic | Test artifact |
| T1379 | My epic | Test artifact |
| T1380 | Epic | Test artifact |
| T1382 | Test Epic | Test artifact |

---

## Done Epics (last 30 days — recent completions)

All completed between 2026-04-22 and 2026-04-27:

| ID | Title | Completed | Priority | Children Verified |
|----|-------|-----------|----------|-------------------|
| T1467 | T-THIN-WRAPPER complete CLI thin-wrapper migration | 2026-04-27 | critical | 5/5 done |
| T1449 | Epic: T-CORE-CONTRACTS-SSOT align Core API with Contracts | 2026-04-27 | high | 10/10 done |
| T1435 | Epic: T-DISPATCH-INFER eliminate dispatch-contracts type drift | 2026-04-27 | high | 10/10 done |
| T1415 | T1216 Remediation Queue — v2026.4.142 reopen | 2026-04-25 | critical | children done |
| T1093 | Epic: MANIFEST/RCASD Architecture Unification | 2026-04-25 | critical | children done |
| T1118 | Epic: T-BRANCH-LOCK — harness-agnostic agent branch protection | 2026-04-25 | critical | children done |
| T1417 | T988 follow-on — Dispatch Typed Narrowing 8 remaining domains | 2026-04-25 | high | children done |
| T1323 | Orchestration Coherence v1 — classifier↔registry↔--json contract fix | 2026-04-24 | critical | children done |
| T1386 | PSYCHE LLM Layer Port — IMPLEMENTATION (port Honcho src/llm 3851 LOC) | 2026-04-24 | critical | children done |
| T1187 | Tree, Dependency & Blocker Visualization Overhaul | 2026-04-22 | medium | children done |

---

## Orphan Pending Tasks (no parent, not epic)

**Total orphan pending tasks**: ~177 (estimated across 270 pending minus ~93 with parents)

### High/Critical Priority Orphans — Real Work

These orphans are real project work, not test artifacts:

#### Release & Infrastructure Artifacts (orphaned from T1106)
Likely belong under T1106 (CLOSE-ALL epic) but have no parentId:

| ID | Priority | Title |
|----|----------|-------|
| T1104 | critical | Validate: biome + build + test gates green across monorepo |
| T1105 | critical | Release: v2026.4.102 — changelog + tag + npm publish |
| T1108 | critical | RB: Build hot-paths and cold-symbols |
| T1109 | critical | RC: T1060 wiki FULL acceptance |
| T1111 | critical | RE: Real-world sandbox scenario proving 5-substrate Living Brain |
| T1112 | critical | RF: Sentient Tier-2 real-world proof |
| T1115 | critical | RA1: Dispatch registry — Living Brain traversal + reasoning |
| T1116 | critical | RA2: Dispatch registry — Code intelligence CLI surface |
| T1117 | critical | RA3: Dispatch registry — Contracts + ingestion bridges |
| T1130 | critical | Wire Living Brain verbs through dispatch registry (Phase 3) |
| T1131 | high | Verify conduit messaging end-to-end (Phase 4) |
| T1132 | critical | Run real-world sandbox scenario (Phase 4) |

**Note**: T1104 and T1105 reference v2026.4.102, which is now far behind the current v2026.4.152. These may be **stale/obsolete** — verify before attempting to complete.

#### Nexus EP1/EP2/EP3 Child Tasks (orphaned from T1054/T1055/T1056)

| ID | Priority | Intended Parent | Title |
|----|----------|-----------------|-------|
| T1057 | high | T1054 (EP1) | EP1-T1: SQLite Recursive CTE Query DSL |
| T1058 | high | T1054 (EP1) | EP1-T2: Semantic Code Symbol Search |
| T1059 | high | T1054 (EP1) | EP1-T3: Source Content Retrieval |
| T1060 | high | T1054 (EP1) | EP1-T4: Wiki Generator |
| T1061 | high | T1054 (EP1) | EP1-T5: Hook Augmenter (PreToolUse) |
| T1062 | high | T1055 (EP2) | EP2-T1: External Module Nodes (IMPORTS persistence) |
| T1063 | high | T1055 (EP2) | EP2-T2: Leiden Community Detection + member_of edges |
| T1064 | high | T1055 (EP2) | EP2-T3: Route-Map and Shape-Check Commands |
| T1065 | high | T1055 (EP2) | EP2-T4: Contract Registry |
| T1066 | high | T1056 (EP3) | EP3-T1: Complete BRAIN→NEXUS Edge Writers |
| T1067 | high | T1056 (EP3) | EP3-T2: TASKS→NEXUS Bridge (task_touches_symbol) |
| T1068 | high | T1056 (EP3) | EP3-T3: Living Brain SDK Traversal Primitives |
| T1069 | high | T1056 (EP3) | EP3-T4: Extended Code Reasoning (why + impact-full) |
| T1070 | high | T1056 (EP3) | EP3-T5: Sentient Nexus Ingester Extensions |
| T1071 | high | T1056 (EP3) | EP3-T6: Conduit→Symbol Ingestion Pipeline |
| T1072 | high | T1056 (EP3) | EP3-T7: Hebbian BUG-2 Fix + STDP Wire-Up |
| T1073 | high | T1056 (EP3) | EP3-T8: IVTR Breaking-Change Gate |

#### Agents Architecture Orphans (may belong under T1232 or T942)

| ID | Priority | Title |
|----|----------|-------|
| T897 | high | Seed-agent auto-install — populate ~/.local/share/cleo/cant/agents/ |
| T898 | high | Registry-backed persona resolution |
| T899 | high | Global→project→packaged tier precedence in persona resolution |
| T900 | high | cleo agent install/attach → spawn integration |
| T901 | medium | Agent registry doctor — reconcile .cant files vs registry DB |
| T902 | high | Dynamic skills composition — classify→recommend→compose |
| T903 | high | CANT DSL v3 — formal types + requires/ensures contracts |
| T904 | high | Playbook DSL (.cantbook) — state-machine runbooks |
| T905 | high | Refactor: unify seed-agents source (kill 3 duplicate dirs) |
| T906 | high | agent_skills table → spawn integration |
| T907 | high | Thin-agent runtime enforcement (ORC rule: workers cannot spawn) |
| T908 | high | Resume tokens + HITL gates (OpenProse standard) |
| T909 | medium | Conduit.db topology audit — project vs global |

#### Sandbox/Tier3 Orphans (belong under T911 or T942)

| ID | Priority | Title |
|----|----------|-------|
| T923 | high | E1c: cleo-sandbox harness — codex cli |
| T925 | high | E1e: cleo-sandbox harness — cursor |
| T945 | high | Universal Semantic Graph — promote brain_page_nodes to sentience layer |
| T946 | high | Autonomous Self-Improving Loop — Tier1/2/3 with Ed25519 + sandbox |
| T1009 | high | Tier 3 infra — agent-in-container sandbox harness + network-none patch |
| T1010 | high | Tier 3 — Externally-anchored baseline + signed llmtxt/events audit |
| T1011 | high | Tier 3 — FF-only merge with abort-on-fail + per-step kill-switch |
| T1012 | high | Tier 3 — cleo revert --from <receiptId> kill-switch + audit chain |
| T1029 | high | abort-to-clean-state protocol (abortExperiment orchestrator) |
| T1030 | high | full merge ritual orchestrator (experiment-runner.ts, 10-step flow) |
| T1032 | high | merge ritual integration test (kill-switch injected at step 6) |

#### Other Real Work Orphans

| ID | Priority | Title |
|----|----------|-------|
| T1047 | critical | Synthesis: gap analysis + far-exceed decomposition plan |
| T1048 | critical | REVISED synthesis: core-native, no-MCP, living-brain cross-substrate |
| T1043 | high | GitNexus CLI deep-dive: feature matrix, data model, storage, query |
| T1044 | high | Cleo Nexus CLI deep-dive: feature matrix, data model, storage, query |
| T1045 | high | Execute gitnexus full pipeline on /mnt/projects/openclaw |
| T1046 | high | Execute cleo nexus full pipeline on /mnt/projects/openclaw |
| T1074 | high | Complete Tier 3 sentient state-pause subsystem (revert lifecycle) |
| T1113 | high | RH: T1059 exports-map fix |
| T1114 | high | RI: T1065 verb-alias fix |
| T927 | high | G3: Fix double-JSON envelope in cleo CLI output |
| T896 | medium | Docs + architecture diagram — docs/architecture/orchestration-flow.md |
| T1139 | pending | BRAIN auto-reconcile: semantic conflict detection + auto-supersession |
| T1119 | medium | Followup: migrate remaining MANIFEST.jsonl entries + rename to .migrated |
| T1492 | medium | T-FU11 thin remaining fat dispatch handlers (memory, sticky, orchestrate, release) |

#### Noise / Test Tasks (pending, no parent)
~80 tasks named "Task N" (T000–T080), "Target N" (T100–T106), "Task N" (T010–T044), etc. are pure test data.

---

## Cross-cutting Themes

### T-FU (Follow-Up Tasks)
Tasks spawned as follow-ups from prior campaigns, now pending:

| ID | Title | Source Campaign |
|----|-------|-----------------|
| T1492 | T-FU11 thin remaining fat dispatch handlers | T-THIN-WRAPPER (T1467) |
| T1119 | Followup: migrate remaining MANIFEST.jsonl entries | T-MANIFEST-UNIFY (T1093) |
| T1418 | T1013 follow-on — RELEASE-04 dep-pruning doc + ADR-051 override (done) | — |

### T-PUMP (Process Pump Improvements)
Specifically filed as process pump epics:

| ID | Title | Status |
|----|-------|--------|
| T1403 | Pump #1: Close post-deploy execution gap | pending (no children) |
| T1404 | Pump #2: Close parent-closure-without-atom | pending (no children) |

### Tasks Referenced in Handoff But Not Filed
From NEXT-SESSION-HANDOFF.md and MASTER-BACKLOG-2026-04-28.md:

- **P0-1** (cleo memory sweep --rollback): No task filed — proposed to file under T1147
- **P0-2** (68-candidate BRAIN sweep owner decision): Owner decision needed, no task filed
- **P0-3** (audit 20 force-bypass uses 2026-04-27): No task filed
- **P0-4** (backup-pack.test.ts cleanup failure): No task filed

---

## Suspicious Patterns

### 1. Epics Pending with All-Done Children (Auto-Complete Should Have Fired)

| Epic | Children Status | Issue |
|------|----------------|-------|
| T603 | 1 child pending | Not suspicious — child is still pending |
| T911 | 1 child pending (T1405) | Not suspicious — child is still pending |
| T1106 | 1 child pending (T1139) | Not suspicious — child still pending; but ~12 other related tasks are ORPHANED |

No epics found with all-done children but still pending (auto-complete appears to be working).

### 2. Tasks with `verification=null` and `status=done` (Closed Without Evidence)

The force-bypass.jsonl shows 665 total bypass entries. 175 have `passed=false` (gate marked passed despite verification failing). Top bypass patterns by task (recent):

- Tasks T1203, T1204, T1253, T1254, T1222, T1425, T1455 each have 6 bypass entries
- `?` (task ID unparseable) accounts for **185 entries** — these are likely CLEO_OWNER_OVERRIDE uses without task context

**Pattern from recent bypasses** (2026-04-24 through 2026-04-27): The majority cite "pre-existing" test failures (brain-stdp×3, sqlite-warning-suppress×2) or worktree-context constraints ("commit not yet cherry-picked to main"). These appear legitimate per ADR-055 worktree model.

**Suspicious bypass clusters**:
- v2026.4.96 release (T930/T931/T932/T933/T934/T935/T936): All used `--all` override with brief `note:v2026.4.96 shipped` evidence — batch override pattern with minimal atoms.
- T1222: `implemented` and `testsPassed` both overridden citing "worktree branch task/T1222 — commit not yet merged to main." Valid per ADR-055 but cherry-pick confirmation should exist.

### 3. Orphaned Child Tasks (No parentId Despite Clear Epic Affiliation)

This is the most significant structural gap:

| Intended Parent | Orphaned Tasks | Count |
|----------------|----------------|-------|
| T1054 (Nexus P0) | T1057-T1061 | 5 tasks |
| T1055 (Nexus P1) | T1062-T1065 | 4 tasks |
| T1056 (Nexus P2) | T1066-T1073 | 8 tasks |
| T1106 (CLOSE-ALL) | T1104/T1105/T1108/T1109/T1111/T1112/T1115/T1116/T1117/T1130/T1131/T1132 | 12 tasks |
| T942 or T1232 | T897-T909 | 13 tasks |
| T911 | T923, T925, T1009-T1012, T1029, T1030, T1032 | 9 tasks |
| **Total** | | **~51 tasks** |

**Impact**: These orphans are invisible when running `cleo list --parent <epicId>`, making epics appear "empty" when they have substantial planned work.

### 4. Potential Epic Overlaps / Duplicates

| Epic A | Epic B | Overlap |
|--------|--------|---------|
| T1461 (disk-space hygiene) | T1466 (T-CLEANUP-WORKTREE) | Both target worktree leak + node_modules. T1461 has children; T1466 is empty. Recommend: merge T1466 into T1461, or wire T1466 children as T1462-T1464 duplicates. |
| T1136 (CLEO-PROVENANCE) | T1407 T-INV-3 (commit-msg lint) | Both mandate T\d+ in commit messages. T1407 is fully decomposed and ready to execute. T1136 is an empty epic. T1407 T-INV-3 may partially satisfy T1136. |
| T889 (Orchestration Coherence v3) | T1323 (Orchestration Coherence v1, done) | v3 epic filed 2026-04-17 but v1 was completed 2026-04-24. Likely v3 planning was superseded. |
| T942 (Sentient Redesign) | T1007 (Sentient Loop Completion) | Both target sentient autonomy. T1007 predates T942. T942 is the authoritative meta-epic. T1007 may be absorbed. |
| T1048 (revised synthesis) | T1047 (original synthesis) | T1048 explicitly supersedes T1047. T1047 should be cancelled. |

### 5. Stale Epic References (v2026.4.102 era)
T1104 ("Release v2026.4.102"), T1105 ("Validate v2026.4.102 gates") — current version is v2026.4.152, 50 patches later. These tasks are almost certainly stale and should be cancelled or verified for relevance.

---

## Recommendations

### Immediate (P0 — before next batch work)

1. **Wire `cleo memory sweep --rollback` dispatch gateway** — 20 LOC fix, no task filed. File under T1147 and complete. Unblocks safe BRAIN sweep management.

2. **Owner decision on 68-candidate BRAIN sweep** — irreversible, cannot proceed without owner approval. Document decision in BRAIN.

3. **Audit 20 force-bypass uses from 2026-04-27 session** — verify each "pre-existing failure" claim is accurate. File regression tasks for any new failures. Restores ADR-051 integrity.

4. **File backup-pack.test.ts cleanup failure as a task** — currently unnamed P0 item from v2026.4.141 handoff.

### Structural Cleanup (P1)

5. **Re-parent orphaned tasks**: Wire the ~51 orphaned tasks to their intended epics:
   - T1057-T1061 → T1054
   - T1062-T1065 → T1055
   - T1066-T1073, T1130-T1132 → T1056
   - T1104, T1105, T1108/T1109/T1111/T1112/T1115/T1116/T1117 → T1106 or cancel if stale
   - T897-T909 → T1232 or T942

6. **Merge or cancel T1466** — it duplicates T1461's scope. If different in intent, decompose into children. If truly overlapping, cancel T1466 and ensure T1461 covers all verbs.

7. **Cancel stale tasks** — T1104/T1105 (v2026.4.102 release tasks) are 50 versions stale. T1047 is superseded by T1048. T889 (Orchestration Coherence v3) may be superseded by T1323 (v1, done).

8. **Verify T1434 still applies** — 104 TS errors may have been resolved by T1435/T1467. Run `pnpm exec tsc -b` before decomposing children.

### Execution Queue (P1-P2, agent-executable now)

| Priority | Task | Effort | Notes |
|----------|------|--------|-------|
| P1 | T1407 wave | large | Fully decomposed (6 children). No blockers. |
| P1 | T1461 wave | medium | 3 children ready. |
| P1 | T1429 brain-stdp deflake | small | Well-scoped. |
| P1 | T1405 (under T911) | medium | CleoOS doctor + claude-sdk smoke. |
| P1 | T1212 wave | medium | T1213→T1214→T1215 sequential. |
| P1 | T1232 wave | medium-large | 3 children ready (T1242-T1244). |
| P2 | T1403 (decompose + execute) | medium | Pump #1 CI gap. |
| P2 | T1404 (decompose + execute) | medium | Pump #2 parent-closure atom. |
| P2 | T1492 | medium | Thin remaining fat handlers. |
| P3 | T942, T990 | large | Owner RCASD session required first. |

### Owner-Required Decisions

1. **T942 Sentient Redesign** — RCASD planning session before any agent action
2. **T990 Studio Design System** — design direction required
3. **T1056 Living Brain Completion** — owner prioritization vs other epics
4. **T1465 Dynamic provider/model** — planning session to define role taxonomy
5. **T1136 vs T1407 T-INV-3** — decide if T1136 is fully satisfied by T1407 T-INV-3

---

*End of INVENTORY-A1. Generated 2026-04-28. Read-only — no tasks modified.*
