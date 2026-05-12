# Inventory A2 — Orphan Docs, Stalled Planning, Unfiled Work

**Generated**: 2026-04-28  
**Auditor**: Inventory A2 agent (research-only, no tasks created/modified)  
**Scope**: `.cleo/agent-outputs/` (156 items) + `.cleo/rcasd/` (79 dirs)  
**Method**: Cross-referenced all doc task IDs against live `cleo show` — verified status, checked planning docs for unfiled follow-on work, inspected RCASD workspace stages.

---

## Section 1 — Active Planning Docs (in-flight tasks with corresponding docs)

These docs map to tasks that are genuinely pending/active. The planning work landed on disk; the implementation work has not completed.

| Doc File | Task | Status | Stage | Notes |
|----------|------|--------|-------|-------|
| `T1407-*.md` (agent-outputs + rcasd/T1407/) | T1407 | pending | research→decomposition | 6 children (T1408-T1413), all pending. Self-enforcing release invariant epic. Active backlog item. |
| `T1232-*.md` (rcasd/T1232/) | T1232 | pending | release stage (RCASD) | 3 children, none done. "PRE-WAVE: CLEO Agents Architecture Remediation." RCASD has 9 stage artifacts including validation — stalled at `pipelineStage:release` in DB but children all pending. |
| `T1058`, `T1059`, `T1061-T1064`, `T1066`, `T1069`, `T1073` docs | T1042 children | pending | various | Agent-outputs for Nexus Overhaul children. T1042 (parent epic) is pending with 0 children in child rollup — suggests children are tracked separately. RCASD for T1042 has only `research` stage. |
| `T1403` | T1403 | pending | research | Post-deploy execution gap pump. Filed but zero implementation — per A3 audit. |
| `T1404` | T1404 | pending | research | Parent-closure-without-atom enforcement pump. Filed but zero implementation. |
| `T1113`, `T1114` docs | T1113, T1114 | pending | — | Nexus exports-map fix + verb-alias fix. Both pending, both planned. |
| `T1321-audit-columns-backfill.md` | T1321 | done | — | Historical only. |
| `T1252-a2a-implementation.md` | T1252 | archived | — | Historical only. |
| `T1259-explorer-map.md`, `T1260-explorer-map.md`, etc. | T1259, T1260 | archived | — | Historical campaign artifacts. |

---

## Section 2 — Orphaned Plans (docs reference tasks that are NOT FOUND or are stale/generic)

### 2A — Generic "Task XX" placeholder tasks with real planning docs attached

The following agent-output planning docs have a task ID in the filename, but the corresponding CLEO task has a generic title ("Task 30", "Task 31", etc.), no description, no parent, and has been `pending` since 2026-03-21 with no progress:

| Doc | Task ID | Task Title | Assessment |
|-----|---------|------------|------------|
| `T030-soft-fk-audit.md` (40 KB) | T030 | "Task 30" | Doc is a complete FK audit (18 soft FKs identified, actionable recommendations). Task is an empty stub with generic title. Doc predates proper filing. |
| `T031-index-analysis.md` (25 KB) | T031 | "Task 31" | Complete index analysis, missing-index recommendations. Empty task stub. |
| `T032-nexus-validation.md` (7 KB) | T032 | "Task 32" | Complete nexus validation output. Empty task stub. |
| `T034-agent-dimension.md` (4 KB) | T034 | "Task 34" | Agent dimension analysis. Empty task stub. |
| `T035-intelligence-dimension.md` (5 KB) | T035 | "Task 35" | Intelligence dimension analysis. Empty task stub. |
| `T036-erd-diagrams.md` (4 KB) | T036 | "Task 36" | ERD diagram plan. Empty task stub. |
| `T037-schema-docs.md` (4 KB) | T037 | "Task 37" | Schema documentation plan. Empty task stub. |
| `T039-health-monitoring.md` (4 KB) | T039 | "Task 39" | Health monitoring plan. Empty task stub. |
| `T040-retry-logic.md` (2 KB) | T040 | "Task 40" | Retry logic design. Empty task stub. |
| `T041-agent-registry.md` (3 KB) | T041 | "Task 41" | Agent registry plan. Empty task stub. |
| `T043-impact-prediction.md` (3 KB) | T043 | "Task 43" | Impact prediction plan. Empty task stub. |
| `T044-reasoning-cli.md` (3 KB) | T044 | "Task 44" | Reasoning CLI plan. Empty task stub. |
| `T045-nexus-assessment.md` (8 KB) | T045 | "Task 45" | Nexus assessment with TODO/follow-up items. Empty task stub. |
| `T060-pipeline-binding.md` (3 KB) | T060 | "Task 60" | Pipeline binding plan. Empty task stub. |
| `T061-verification-init.md` (3 KB) | T061 | "Task 61" | Verification init plan. Empty task stub. |
| `T062-epic-enforcement.md` (5 KB) | T062 | "Task 62" | Epic enforcement plan. Empty task stub. |
| `T063-skills-update.md` (5 KB) | T063 | "Task 63" | Skills update plan. Empty task stub. |
| `T064-validator-skill.md` (3 KB) | T064 | "Task 64" | Validator skill plan. Empty task stub. |
| `T065-telemetry.md` (4 KB) | T065 | "Task 65" | Telemetry plan. Empty task stub. |
| `T066-backfill.md` (3 KB) | T066 | "Task 66" | Backfill plan. Empty task stub. |
| `T067-strictness-presets.md` (4 KB) | T067 | "Task 67" | Strictness presets plan. Empty task stub. |
| `T068-documentation.md` (2 KB) | T068 | "Task 68" | Documentation plan. Empty task stub. |
| `T105-enforcement-audit.md` (10 KB) | T105 | "Target 5" | Enforcement audit (22 KB). Empty task stub. |
| `T106-session-audit.md` (16 KB) | T106 | "Target 6" | Session audit (16 KB). Empty task stub. |
| `T200` (rcasd/T200 empty) | T200 | "Research task" | Created 2026-04-24, generic title. |
| `T201` (rcasd/T200 empty) | T201 | "Work task" | Created 2026-04-24, generic title. |
| `T029` (parent of T030-T037) | T029 | "Task 29" | Parent stub, pending. |

**Root cause**: These planning docs appear to be from a session (circa 2026-03-21) where an agent produced research outputs and filed task stubs with auto-generated IDs, but the tasks were never renamed/populated with real titles or descriptions. The planning data is real and complete; the CLEO task records are hollow shells.

**Verdict**: ORPHAN CLUSTER — real planning docs, shell task records. The planning work in these docs (particularly T030 FK audit, T031 index analysis, T045 nexus assessment, T062 epic enforcement, T105 enforcement audit) contains substantive actionable findings that were never converted into properly-titled CLEO tasks.

### 2B — Planning docs for tasks that are now done/archived (historical)

These docs are fine — they map to completed work. Listed for completeness, no action needed:

Docs for archived/done tasks: `T090`, `T097`, `T107-T110`, `T137`, `T140-T146`, `T157`, `T160`, `T166`, `T168`, `T180`, `T192-T199`, `T216`, `T268`, `T310`, `T311`, `T325`, `T352`, `T378`, `T427`, `T447`, `T448`, `T469`, `T473-T492`, `T505`, `T507-T553`, `T564-T636`, `T643-T735`, `T750-T760`, `T784`, `T790`, `T792`, `T818`, `T820-T821`, `T828`, `T832`, `T837`, `T861-T882`, `T891-T895`, `T900`, `T910`, `T926`, `T943`, `T947`, `T979`, `T988-T999`, `T1001`, `T1003`, `T1006`, `T1015-T1026`, `T1058-T1114`, `T1140`, `T1145-T1149`, `T1151`, `T1158-T1169`, `T1173`, `T1177`, `T1179`, `T1184`, `T1187-T1193`, `T1205`, `T1208`, `T1216`, `T1252-T1254`, `T1258-T1263`, `T1321-T1326`, `T1331`, `T1386`, `T1416-T1419`, `T1424`, `T1427`, `T1437-T1446`, `T1449-T1451`, `T1459`, `T1473`, `T1484-T1488`, `T1490`.

### 2C — Active/pending tasks in RCASD with empty or stub-only workspace content

These RCASD directories exist but contain only empty shell YAML frontmatter with no substantive notes in any stage file:

| RCASD Dir | Task | Status | Stage Files | Substantive Content? |
|-----------|------|--------|-------------|---------------------|
| `rcasd/T889/` | T889 | pending | `research/` only | Empty stub — RCASD has 1 file, `research/T889-research.md` with only YAML frontmatter. Epic has 0 children. Stalled at research stage since 2026-04-17. |
| `rcasd/T942/` | T942 | pending | `research`, `decomposition`, `implementation`, `specification` | All files are empty stubs (YAML frontmatter only, empty Notes section). Epic has 0 children. Stalled. |
| `rcasd/T1042/` | T1042 | pending | `research/` only | Empty stub. Epic has 0 children in rollup. |
| `rcasd/T091/`, `rcasd/T100/`, `rcasd/T200/`, `rcasd/T1000/` (all empty) | T091 (archived), T100 (pending "Bug task"), T200 (pending "Research task"), T1000 (archived) | archived/pending | empty dirs | Empty workspace directories. T100 and T200 are generic stub tasks. |
| `rcasd/T919/` | T919 | pending | `consensus/` only | Single stage file, empty stub. "Fix GH issue #94 — task auto-complete inconsistency." Research stage never started. |
| `rcasd/T939/`, `rcasd/T940/`, `rcasd/T941/` | T939/T940/T941 | pending | `research`, `architecture`, `consensus`, `decomposition`, `specification` | All stage files are empty stubs. These are "test epic for T929 lifecycle bug" artifacts — should be cancelled per MASTER-2026-04-20 recommendation. |
| `rcasd/T1096/` | T1096 | archived | `research/` only | Archived, stub only. Historical. |

---

## Section 3 — Stalled RCASD Workspaces (research without follow-through)

These RCASD workspaces have substantive stage files but the task is either stalled pending or the planning was never followed through to implementation:

| RCASD Dir | Task | Status | Highest Stage With Content | Assessment |
|-----------|------|--------|---------------------------|------------|
| `rcasd/T1232/` | T1232 | pending | `validation/` (9 stages present) | T1232 "PRE-WAVE: CLEO Agents Architecture Remediation for v2026.4.121." RCASD advanced to validation stage but task itself is `pending` with 3 children, all pending, no evidence. The planning is complete; the implementation hasn't started. Stalled at planning-complete / implementation-blocked. |
| `rcasd/T1407/` | T1407 | pending | `decomposition/` (5 stages) | T1407 planning complete through decomposition (6 children filed). Awaiting implementation. Not stalled — legitimately queued work. |
| `rcasd/T889/` | T889 | pending | `research/` (1 stage, empty) | T889 Orchestration Coherence v3. Research stage filed but empty (no content). 0 children. Has been stalled since 2026-04-17 (~10 days). Planning never actually happened — stub only. |
| `rcasd/T942/` | T942 | pending | `decomposition/` (4 stages, all empty) | T942 Sentient Architecture Redesign. RCASD has 4 stage files, all empty stubs. 0 children. Has MASTER-BACKLOG.md note: "requires RCASD planning session before agent work begins." Correctly stalled — owner must scope first. |
| `rcasd/T1106/` | T1106 | pending | `implementation/` (6 stages) | T1106 "CLOSE-ALL + sandbox proof." Has T1106-CI-INVESTIGATION.md (13 KB) in agent-outputs. RCASD advanced to implementation. T1106-close-all dir in agent-outputs also exists. 1 child (T1139). Status: partly complete but not closed. |
| `rcasd/T612/` | T612 | archived | `release/` (9 stages) | Archived "ATTEST: LOOM lifecycle test epic." RCASD fully populated but task archived. Historical. No action. |
| `rcasd/T487/`, `rcasd/T861/`, `rcasd/T870/`, `rcasd/T876/`, `rcasd/T882/` | archived | archived | `release/` (9 stages each) | All archived epics with full RCASD histories. Historical, no action. |
| `rcasd/T1232/`, `rcasd/T1251/`, `rcasd/T1258/`, `rcasd/T1260/`, `rcasd/T1261/`, `rcasd/T1263/` | archived (except T1232) | archived | `release/` (9 stages each) | PSYCHE E1-E6 planning workspaces. All archived (campaign shipped). Historical. |

---

## Section 4 — Handoff/Master Docs Cross-Reference

### `NEXT-SESSION-HANDOFF.md` (current SSoT, 2026-04-25, updated to v2026.4.141)

**Status**: Partially superseded. A3 (INVENTORY-A3-handoff-reconciliation.md) has already reconciled this against v2026.4.152. Key findings from A3:
- **3 items resolved**: tasks-sqlite rename (commit `926f002c7`), conduit-schema extraction (commit `7300e3eed`), T1414 CHANGELOG (v2026.4.142).
- **2 items moot**: 68-candidate sweep (all rolled-back, no live action needed), backup-pack test failure (now confirmed as pipeline.integration.test.ts).
- **Correction holds**: `reconcile-scheduler.ts` still absent.
- **Corrections to prior corrections**: PLAN.md Part 10 T1151 subtasks were NEVER filed (T1152-T1159 IDs belong to unrelated T-MSR tasks).

**Superseded by**: `MASTER-BACKLOG-2026-04-28.md` for outstanding scope. The NEXT-SESSION-HANDOFF.md should be updated at next session start to reflect v2026.4.152 state.

### `MASTER-BACKLOG-2026-04-28.md` (current ground truth)

**Status**: Current SSoT for outstanding work as of v2026.4.152. Contains:
- 6 items marked "no task filed — needs filing": P0-1, P0-3, P0-4, P0-5, P0-6, P1-8
- Additional unfiled items surfaced by INVENTORY-A4: LAFSPage regression, T1082.followup ×2, stale SSoT-EXEMPTs, orphan test files, deprecated dead code
- Concrete `cleo add` commands ready to file for each

**No orphan issue**: This document is actively maintained and current.

### `CAMPAIGN-2026-04-24-agent-tracker.md` + `CAMPAIGN-2026-04-24-overnight-execution-plan.md` + `CAMPAIGN-2026-04-24-slot-prompts.md`

**Status**: Historical campaign artifacts from v2026.4.126-.133 execution. All 8 campaign slots shipped (T1258 → T1148). No unfiled work — campaign is complete. These docs are read-only historical records. The slot prompts doc (10 KB) may be useful as a spawn-prompt template reference but references no unfiled work.

### `COUNCIL-2026-04-23-infrastructure-roadmap.md` (37 KB)

**Status**: Council ratification of the E1→E2→E3→E4 infrastructure roadmap that fed the April 24 campaign. All 5 binding modifications (M1-M5) were applied during the campaign. All 4 epics (T1258-T1261) are now archived/done. **No outstanding unfiled work from this doc.** Council open questions answered by the campaign: T1255 closed in E1, T1249 became sub-task in E2, T1250 sequenced after E1.

Exception: The Council's "Open question for owner" about hierarchy.ts disposition was not explicitly resolved in any doc. `hierarchy.ts` still exists in the codebase as of A4 audit scope.

### `HANDOFF-2026-04-20-master-sentient-v2.md` (7 KB)

**Status**: Historical handoff from v2026.4.100 session. Key unfiled items it identified:
- "Add package-boundary rule to AGENTS.md" — **RESOLVED** (added to AGENTS.md per T1015 lessons).
- "T-STUDIO-VITEST-FIX" (Svelte 5 runes in vitest, `.svelte.ts:351`) — **NOT CONFIRMED filed**. `cleo find` for svelte vitest runes returns no match. Potential orphan.
- "Build.mjs entry-point auto-sync" (auto-generate `coreBuildOptions.entryPoints`) — **NOT CONFIRMED filed**. No task found.
- "T1013 meta-epic close-out" — T1013 is `archived`. Resolved.

### `MASTER-2026-04-20-REMAINING-WORK.md` (9 KB)

**Status**: Historical session doc from v2026.4.100. Most items resolved. Outliers with no confirmed filing:
- `cleo docs export` subcommand never registered (T947 "theater call") — T947 is `archived`; the export function exists but whether it was ever wired is not confirmed from this audit.
- T946 AGI capstone — still `pending` with 0 children. Worker crashed during attempt. No sub-decomposition filed.
- T990 Studio design epic — still `pending` with 0 children.

### `CANT-V2-PERSONA-SCHEMA-PLAN.md` (8 KB, dated 2026-03-31)

**Status**: Implementation plan for CANT v2 agent persona schema, "gated behind T234." T234 is `archived` (EPIC: Agent Domain Unification). The plan is 10 required sections + 4 recommended sections for `.cant` files. No corresponding task ID exists in the filename; this is an untitled planning doc. **Potentially orphaned** — the gating epic is archived, but whether the persona schema spec was shipped or superseded is not clear from this audit.

### `DOC-SYNC-AUDIT-2026-04-20.md` (15 KB)

**Status**: Audit of 14 package READMEs + forge-ts CI gate. Key unfiled items:
1. `forge-ts CI gate hardening` (remove `continue-on-error: true`) — no filing confirmed.
2. `explicit strictNullChecks + noImplicitAny in root tsconfig.json` — no filing confirmed.
3. `per-package forge-ts.config.ts for core + contracts` — no filing confirmed.
4. Multiple README updates (brain/playbooks/studio packages, adapters README wave table, skills README) — the 6 specific doc updates may or may not have been done in subsequent releases.

---

## Section 5 — Unfiled Work Recommendations

Items confirmed unfiled as of 2026-04-28 (cross-referenced against `cleo find` and `MASTER-BACKLOG-2026-04-28.md`). Grouped by source.

### FROM MASTER-BACKLOG-2026-04-28.md (already has `cleo add` commands ready)

| Item | Priority | Effort | Notes |
|------|----------|--------|-------|
| Fix `cleo memory sweep --rollback` dispatch routing (add `'sweep'` to `mutate[]` array in `memory.ts` ~line 1994, 1 LOC) | **P0-critical** | small | Filed command in MASTER-BACKLOG P0-1 section |
| Audit 106 force-bypass entries (2026-04-25 to 2026-04-28, 36 tasks) — verify pre-existing claims, file regression tasks | **P0-critical** | small | Filed command in MASTER-BACKLOG P0-3 section |
| Fix `pipeline.integration.test.ts` — 7 failing `passGate` tests crash on undefined `gateName` | **P0-high** | small | Filed command in MASTER-BACKLOG P0-4 section |
| Pump: cap `CLEO_OWNER_OVERRIDE` invocations per session — require ADR-style waiver doc above N | **P0-critical** | medium | Filed command in MASTER-BACKLOG P0-5 section; 665 total entries, no cap |
| Pump: require `--shared-evidence` flag when same evidence atom closes >3 child tasks | **P0-critical** | medium | Filed command in MASTER-BACKLOG P0-6 section |
| Implement `reconcile-scheduler.ts` — periodic BRAIN reconciler per PLAN.md §7.3 | **P1-medium** | medium | Filed command in MASTER-BACKLOG P1-8 section; parent would be T1139 |
| Implement `observation_embeddings` and `turn_embeddings` tables per PORT-AND-RENAME §2 | **P2-low** | small | Filed command in MASTER-BACKLOG P2-3 section; confirmed absent by A3 grep |
| Fix biome broken-symlink warning in CI (pre-existing 1-line noise) | **P2** | tiny | Not filed |

### FROM INVENTORY-A4-codebase-debt.md (unfiled work found in source code)

| Item | Priority | Effort | Source Location |
|------|----------|--------|-----------------|
| Fix `pipeline.integration.test.ts` — LAFSPage pagination regression from T1441 concurrent worker | **P1** | small-medium | A4 section "Pre-existing test failures." T1441 introduced it; no task filed. |
| File task for `TODO(T1082.followup)`: embedding-based cosine dedup in `session-narrative.ts` (lines 61, 256) | **P1** | medium | `packages/core/src/memory/session-narrative.ts`. T1082 archived; followup unregistered. |
| File 2 tasks for `TODO(T1082.followup)`: confidence threshold tuning + few-shot examples, and telemetry when LLM backend unavailable in `dialectic-evaluator.ts` (lines 117, 183, 213) | **P1** | medium | `packages/core/src/memory/dialectic-evaluator.ts` |
| Audit 21 `SSoT-EXEMPT:no-dispatch-op; pending T1488 Phase 2` annotations in `nexus.ts` — T1488 is done; Phase 2 ops may need a new epic | **P1** | small | `packages/cleo/src/cli/commands/nexus.ts` ×21 |
| Audit 6 `SSoT-EXEMPT: T1451 incomplete ADR-057 D1 normalization` annotations in `token-service.ts` — T1451 is done | **P2** | tiny | `packages/core/src/metrics/token-service.ts` |
| Delete `packages/caamp/tests/unit/coverage-final-push.test.ts` + `core-coverage-gaps.test.ts` (T659 accepted these for deletion but they still exist) | **P2** | tiny | T659 archived; files remain |
| File task: replace `T1XXX` placeholder in `packages/core/src/nexus/route-analysis.ts:162` with real epic ID | **P3** | tiny | `route-analysis.ts` line 162: "deferred to T1XXX" |
| File task: fix `sqlite-warning-suppress.test.ts` worktree-context flakiness (2 tests fail in worktree/git context) | **P3** | small | `packages/cleo/src/cli/__tests__/sqlite-warning-suppress.test.ts` |
| File task: fix `backup-pack.test.ts` ENOTEMPTY race (parallel tmpdir with sibling test dirs) | **P3** | small | `packages/core/src/store/__tests__/backup-pack.test.ts:440` |
| File task: re-enable or permanently close `T1093-followup` skip in `brain-stdp-wave3.test.ts:364` + `task-sweeper-wired.test.ts:157` | **P3** | small | T1093 archived; 2 files have unresolved followup skips |
| File task: extend `cant-napi` `parse_document` for agent-fixtures NAPI bridge tests | **P4** | medium | `packages/cant/tests/agent-fixtures.test.ts:42,48` |
| File task: remove deprecated ADR-027 flat-file functions from `memory/index.ts` (T1093 complete) | **P3** | small | T1093 archived; deprecated functions remain |
| File task: remove deprecated shims in `signaldock-sqlite.ts` (T310 complete) | **P2** | small | T310 archived |
| File task: evaluate + remove `SkillLibrary*` deprecated type aliases in `caamp/src/types.ts` | **P4** | tiny | Deprecated since T427 era |

### FROM HANDOFF-2026-04-20-master-sentient-v2.md (potential orphans from April 20 session)

| Item | Priority | Notes |
|------|----------|-------|
| `T-STUDIO-VITEST-FIX` (Svelte 5 runes `.svelte.ts:351` in vitest) — was noted as "create standalone task" but not confirmed filed | **P2** | `cleo find` found no match. May have been silently dropped. |
| Build.mjs entry-point auto-sync (auto-generate `coreBuildOptions.entryPoints` from `package.json` exports map) | **P2** | Proposed in session, not confirmed filed. Prevents v2026.4.99-style broken tarball. |

### FROM DOC-SYNC-AUDIT-2026-04-20.md (documentation debt, none confirmed filed)

| Item | Priority | Notes |
|------|----------|-------|
| Remove `continue-on-error: true` from forge-ts CI gate | **P2** | `.github/workflows/ci.yml` lines 328-357. Not filed. |
| Add `strictNullChecks + noImplicitAny` explicitly to root `tsconfig.json` | **P2** | forge-ts E009 gate fails without this. Not filed. |
| Add per-package `forge-ts.config.ts` for `core` + `contracts` packages | **P2** | Not filed. |
| README updates: add `packages/brain`, `packages/playbooks`, `packages/studio` to root README table | **P3** | May have been fixed in later releases; unverified from this audit. |

### FROM COUNCIL-2026-04-23-infrastructure-roadmap.md (open owner question)

| Item | Priority | Notes |
|------|----------|-------|
| `hierarchy.ts` disposition — Council open question: "grep to confirm if consumed at runtime; if only legacy/test-fixture, deletion is cleanest during E1" | **P3** | E1 (T1258) shipped but this specific action wasn't confirmed in campaign tracker. |

### FROM agent-outputs CANT-V2-PERSONA-SCHEMA-PLAN.md (potentially orphaned planning)

| Item | Priority | Notes |
|------|----------|-------|
| Determine if CANT v2 persona schema plan (CANT-V2-PERSONA-SCHEMA-PLAN.md) was shipped or superseded. Gating epic T234 is archived. | **P3** | The plan specifies 10 required + 4 recommended `.cant` sections for personas. Whether this was absorbed into the CANT DSL work or abandoned is unclear. |

### STALE PENDING EPICS — Planning done but no children and no progress

These represent documented planned work that has stalled (planning artifacts exist in RCASD or agent-outputs but no children have been filed and no implementation has started):

| Task | Title | Stalled Since | Planning State | Recommended Action |
|------|-------|--------------|---------------|-------------------|
| T889 | EPIC: Orchestration Coherence v3 | 2026-04-17 | RCASD research stage only (empty stub) | Decompose or cancel. No children, no real research content. T910 (v4) supersedes this scope. |
| T942 | Sentient CLEO Architecture Redesign | 2026-04-20 | RCASD has 4 stage files, all empty stubs | Owner RCASD session required per MASTER-BACKLOG. Do not delegate to agent without scoping. |
| T946 | Autonomous Self-Improving Loop (AGI capstone) | 2026-04-20 | No RCASD workspace; worker crashed prompt-too-long | Major task with 0 children and 0 decomposition. Needs narrow-scope decomposition before agent dispatch. |
| T990 | EPIC: Studio UI/UX Design System | 2026-04-20 | No children, no RCASD | Design direction from owner required before any agent work. |
| T1042 | Cleo Nexus vs GitNexus: Far-Exceed Analysis | 2026-04-20 | RCASD research stage only (empty stub) | T1042 has RCASD stub only. Many Nexus children (T1058-T1073) are actually `pending` separately. T1042 parent is a stub epic; children exist but aren't linked in rollup. |
| T1232 | PRE-WAVE: CLEO Agents Architecture Remediation | 2026-04-23 | RCASD fully populated through validation | 3 children (T1242, T1245, T1246) exist. pipelineStage=release in DB but all children still pending. Implementation stalled. |
| T631 | EPIC: Cleo Prime Orchestrator Persona | ~2026-04-16 | No RCASD workspace, no children | Priority: `low` per MASTER-2026-04-20. Should be explicitly cancelled or given an R-task decomposition. |
| T939/T940/T941 | Test epics for T929 lifecycle bug | 2026-04-20 | RCASD has 5 stage files each, all empty stubs | Per MASTER-2026-04-20: "cancel via owner override" (T877 invariant blocks normal cancel). Should be cleaned up. |

---

## Section 6 — Summary Statistics

| Category | Count |
|----------|-------|
| Total files in `.cleo/agent-outputs/` | ~156 |
| Total directories in `.cleo/rcasd/` | 79 |
| RCASD dirs with substantive content (non-empty stage files) | ~45 |
| RCASD dirs that are empty stubs | ~34 |
| Docs mapping to done/archived tasks (historical, no action) | ~120 |
| Docs with active/pending task mapping (in-flight work) | ~15 |
| Orphan "empty shell task" cluster (T029-T068, T105-T106 group) | 25 tasks |
| Confirmed unfiled P0 items from MASTER-BACKLOG | 5 |
| Confirmed unfiled P1-P2 items from MASTER-BACKLOG | 3 |
| Confirmed unfiled items from INVENTORY-A4 codebase debt | 15 |
| Potential unfiled items from older handoffs (unverified) | 5 |
| Stalled pending epics with no active children | 8 |

---

## Section 7 — Top 10 Priority Actions

Ranked by urgency. Pure audit — no tasks filed by this report.

1. **FILE P0-1** (1 LOC fix): `cleo add "Fix: add 'sweep' to mutate[] routing in memory dispatch" --parent T1147 --size small --priority critical` — `cleo memory sweep --rollback` has been broken since at least v2026.4.141.

2. **FILE P0-4** (7 test failures): `cleo add "Fix pipeline.integration.test.ts — 7 failing passGate tests crash on undefined gateName" --size small --priority high` — Root of most `testsPassed` overrides.

3. **FILE P0-5 + P0-6** (governance pumps): Override cap + shared-evidence enforcement. 106 entries in 3 days. Use the `cleo add` commands from MASTER-BACKLOG P0-5/P0-6 sections verbatim.

4. **FILE P1-8** (PLAN.md gap): `cleo add "Implement reconcile-scheduler.ts — periodic BRAIN reconciler per PLAN.md §7.3" --parent T1139 --size medium --priority medium`.

5. **FILE A4-LAFSPage** (test regression): File task to investigate LAFSPage pagination regression introduced around T1441. Source: `packages/core/src/lifecycle/__tests__/pipeline.integration.test.ts`.

6. **FILE T1082.followup ×3** (orphan TODO markers): 3 separate `TODO(T1082.followup)` markers in `session-narrative.ts` and `dialectic-evaluator.ts` pointing to work that was never filed.

7. **RENAME OR CLOSE the T030-T045, T060-T068, T105-T106 shell task cluster**: 25 tasks with generic "Task XX" titles have real planning docs but empty CLEO records. Either rename them with real titles/descriptions (rescuing the planning work) or cancel them if the plans are superseded.

8. **FILE Studio-Vitest fix**: Svelte 5 runes `.svelte.ts:351` failing in vitest was noted in the April 20 handoff as needing a standalone task — not confirmed filed.

9. **OWNER DECISION on T939/T940/T941**: Cancel these test-artifact epics (blocked by T877 invariant — requires owner override to cancel).

10. **OWNER SCOPING of T942** (Sentient Redesign): Before any agent touches T942, owner must run a RCASD council session to produce a real decomposition. The 4 RCASD stage files are empty stubs. The MASTER-BACKLOG explicitly requires owner scoping first.

---

*End of Inventory A2. Pure audit — no tasks were created, modified, or closed by this report.*
