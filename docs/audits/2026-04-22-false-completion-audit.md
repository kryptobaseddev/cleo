# 2026-04-22 False-Completion Forensic Audit

**Report Date**: 2026-04-24  
**Epic**: T1216 — False-Completion Forensic Audit  
**Report Author**: T1223 (Synthesis subagent)  
**Status**: FINAL  

---

## 1. Executive Summary

This report synthesizes 12 per-epic forensic audits conducted under the T1216 epic. Audits were triggered by a systemic finding: 176 tasks marked `done` before ADR-051 took effect have `modified_by=NULL`, `session_id=NULL`, and 12 of those additionally have `verification_json=NULL` with no audit log, no lifecycle history, and no child-task rollup in the database.

### Verdict Tally

| Verdict | Count | Targets |
|---|---|---|
| `verified-complete` | 8 | T569, T870, T876, T882, T910, T949, T962, T1000 |
| `verified-incomplete` | 3 | T820, T988, T1013 |
| `schema-artifact-not-work-defect` | 1 | T991 |
| `inconclusive` | 0 | — |

### Root-Cause Statement

All 12 suspect tasks had `verification_json=NULL` because the CLEO engine (`task-engine.ts` pre-fix state at line 831) did not enforce a NOT NULL check on `verification_json` when calling `tasks.complete`. The engine re-validated `verification.evidence` only when already populated; no code path rejected NULL. This allowed agents to call `cleo complete` without first running `cleo verify --gate ... --evidence ...`, silently producing completions indistinguishable from genuine verified completions.

### Fix Summary

T1222 closed the engine gap. Two commits — `6ce9cf267` (failing tests, RED) and `d04d5fe2b` (implementation, GREEN) — introduced:

- **`taskCompleteStrict`**: rejects with `E_EVIDENCE_MISSING` when `verification_json IS NULL` (CLEO-VALID-26), with an explicit fix hint. Epics are exempted (auto-completed, no verify step).
- **`taskComplete`**: stamps `modified_by` from `CLEO_AGENT_ID` (default `"cleo"`) and `session_id` from `getActiveSession()` (fallback `CLEO_SESSION_ID`) on every successful completion (CLEO-VALID-27).
- 7/7 new tests pass.

---

## 2. Council Verdict Reference

The T1216 audit campaign was preceded by a formal Council session on 2026-04-24. The full deliberation is at:

`.cleo/agent-outputs/T-COUNCIL-T1216-AUDIT-2026-04-24/council-verdict.md`

The Council issued a **REFACTOR** verdict, mandating three structural changes before the audit wave ran:

1. T1222 promoted from peer acceptance item to **blocking predecessor** (merged first, tests green).
2. Verdict taxonomy expanded to **four outcomes**: `verified-complete`, `verified-incomplete`, `schema-artifact-not-work-defect`, `inconclusive` — with `git log` and release tags declared first-class evidence channels co-equal with `tasks.verification_json`.
3. The 176-row backfill extracted to a **sibling epic** (T1321), distinct from the 12-suspect forensic audit.

The Council's sharpest finding: "An audit of completion-gate integrity performed by a system that still accepts NULL completion-gate evidence cannot produce trustworthy verdicts." All four conditions were met before the 12 audit subagents were spawned.

---

## 3. Per-Epic Verdict Table

| Target ID | Verdict | Confidence | Direct Commits | Child Commits | Release Tag | Key Finding |
|---|---|---|---|---|---|---|
| T569 | `verified-complete` | HIGH | 5 | — | v2026.4.76 | Explicit closure: "T569 Dogfood Attestation CLOSED — all 6 systems attested." All 5 ACs met. |
| T820 | `verified-incomplete` | HIGH | — | — | v2026.4.79 | 5/7 ACs met. RELEASE-03 (IVTR gate check) and RELEASE-07 (IVTR→release auto-suggest) not implemented. |
| T870 | `verified-complete` | HIGH | 1 monolithic | — | v2026.4.81 | All 7 ACs met. 53 new tests. Single commit bundles T871-T874 + T863 regression fix. |
| T876 | `verified-complete` | HIGH | 2 | 5 (T877-T881) | v2026.4.83 | All 6 ACs met. Schema-level trigger migration replaces TS backfills. 31 new tests. |
| T882 | `verified-complete` | HIGH | 3 | — | v2026.4.85 | All 7 ACs met. Canonical `buildSpawnPrompt()` (846 lines), 3-tier system, 52 new tests. |
| T910 | `verified-complete` | HIGH | 15 | 8 (T930-T937) | v2026.4.94 | All 10 ACs met. Playbook runtime, thin-agent enforcer, SDK consolidation, HITL gates. 9024 tests pass. |
| T949 | `verified-complete` | HIGH | 14 | 11 (T950-T960) | v2026.4.97 | All 12 ACs met. 688 tests (655 unit + 33 E2E). T990 is a design follow-up, not a rejection. |
| T962 | `verified-complete` | HIGH | 11 | — | v2026.4.97 | 15/16 ACs met (1 deferred to v2026.4.98 per operator A+C). CONDUIT promoted, @cleocode/brain extracted. |
| T988 | `verified-incomplete` | HIGH | 0 | 1 (T975 only) | never shipped | 1/13 ACs met. T976-T983 never implemented. ~450 of 579 param casts remain. |
| T991 | `schema-artifact-not-work-defect` | HIGH | 1 (release chore) | 9 (T992-T999) | v2026.4.98 | All work shipped. DB parent-child link broken/missing. `cleo list --parent T991` returns 0 but git shows 16 child-task commits. |
| T1000 | `verified-complete` | HIGH | 2 | 18 (T1001-T1006) | v2026.4.98 | All 7 ACs met. DB parent-child link broken (same schema-artifact pattern as T991). Work shipped. |
| T1013 | `verified-incomplete` | HIGH | 4 | — | v2026.4.98 | 2/5 ACs met. Documentation criteria (RELEASE-04, ADR-051 override patterns) never addressed. Svelte fix committed 2h38m after task marked done. |

---

## 4. Detailed Findings Per Audit

### T569 — CLEO Dogfood Attestation Epic

**Audit task**: T1230  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T569-verdict.md`  
**Verdict**: `verified-complete` (HIGH confidence)

T569 is a multi-release epic spanning v2026.4.43 through v2026.4.76. The v2026.4.76 release notes contain explicit closure language: "T569 Dogfood Attestation epic CLOSED (all 6 systems attested)." All five acceptance criteria are evidenced: the v2026.4.43 publish (23-agent parallel pipeline), all 6 systems proven with measurable metrics (BRAIN tier promotion, CANT 131→0 errors, NEXUS +790 barrel-export resolutions), SDK providers in v2026.4.48, and the 15-task closure wave in v2026.4.76. Quality gates were verified at release time (8327 tests pass, biome clean). No follow-up action required.

---

### T820 — Project-Agnostic Release Pipeline

**Audit task**: T1231  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T820-verdict.md`  
**Verdict**: `verified-incomplete` (HIGH confidence)

T820 shipped 5 of 7 acceptance criteria in v2026.4.79. The two missing criteria both involve IVTR integration:

- **RELEASE-03**: `cleo release ship` should reject when any task has `ivtr_state.currentPhase != 'released'`. No such check exists in `release-manifest.ts`, `release-engine.ts`, or `release.ts`. The `--force` flag exists in the CLI but the actual gate check is absent.
- **RELEASE-07**: `cleo release ship` should be auto-suggested by the IVTR orchestration layer after the Test phase completes. No orchestration wiring exists.

What shipped: project-agnostic `release-config.json` loading (RELEASE-01), CHANGELOG auto-generation (RELEASE-02), PR-first mode with draft PR + auto-body (RELEASE-04), rollback support (RELEASE-05), and downstream fixture integration test (RELEASE-06).

**Remediation**: Reopen T820 and create follow-up tasks for RELEASE-03 and RELEASE-07. See Section 7.

---

### T870 — Schema Integrity Epic

**Audit task**: T1221  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T870-verdict.md`  
**Verdict**: `verified-complete` (HIGH confidence)

T870 shipped as a single monolithic commit (`670c428eb`) in v2026.4.81 containing all four fixes (T871/T872/T873/T874) plus a co-discovered T863 regression fix. All 7 acceptance criteria are met: `cleo complete` auto-advances `pipelineStage` to terminal (`contribution`), `cleo cancel` sets `cancelled`, the backfill migration is idempotent, Studio pipeline DONE/CANCELLED columns route correctly, epic progress uses consistent direct-children basis, and 53 new tests pass (8601/8643 total). The RCASD artifact chain is complete across all 10 lifecycle stages.

---

### T876 — Tasks System Coherence Epic

**Audit task**: T1229  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T876-verdict.md`  
**Verdict**: `verified-complete` (HIGH confidence)

T876 shipped in v2026.4.83 across 5 child tasks (T877-T881). All 6 acceptance criteria are met. The headline delivery is a Drizzle migration (`20260417000000_t877-pipeline-stage-invariants/migration.sql`) that replaces two TS backfill files with permanent SQL triggers enforcing the `status/pipeline_stage` invariant at the DB level (RAISE ABORT on violation). Additionally: Studio dashboard toggle filters for deferred/cancelled epics, a new `/tasks/graph` route with force-directed SVG visualization (d3-force, 3 edge kinds), canonical pipeline stage taxonomy documentation, and CLI/Studio parity for all 10 pipeline stages. 31 new tests across 4 suites. Build, biome, and test gates all green (8620/8620).

---

### T882 — Orchestrate Spawn Prompt Rebuild

**Audit task**: T1228  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T882-verdict.md`  
**Verdict**: `verified-complete` (HIGH confidence)

T882 shipped in v2026.4.85 (`51971cd4a`). The core delivery is `packages/core/src/orchestration/spawn-prompt.ts` (846 lines), a canonical `buildSpawnPrompt()` function replacing the prior 20-line skeleton. All 7 acceptance criteria are met: single canonical builder (AC1), 8-section fully self-contained prompt in documented order (AC2), tier system 0/1/2 with `DEFAULT_SPAWN_TIER = 1` (AC3), `cleo-subagent/AGENT.md` updated to v2.0.0 with explicit spawn prompt contract (AC4), 52 shape-based tests covering 10 RCASD-IVTR+C protocols × 3 tiers (AC5), 8664 tests pass with 0 failures (AC6), and v2026.4.85 shipped with CHANGELOG (AC7). The integration path is `orchestrate-engine.ts` → `composeSpawnForTask()` → `buildSpawnPrompt()`.

---

### T910 — Orchestration Coherence v4

**Audit task**: T1220  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T910-verdict.md`  
**Verdict**: `verified-complete` (HIGH confidence)

T910 shipped in v2026.4.94 (`4d44dcda3`) across 8 child tasks (T930-T937) and 15 commits. Note: v2026.4.93 was abandoned locally (incomplete, never pushed); v2026.4.94 is the canonical ship. All 10 acceptance criteria are met: playbook runtime state machine (`packages/playbooks/src/runtime.ts`) with HMAC-SHA256 HITL gates and crash-resume (AC1), 3 starter `.cantbook` playbooks (AC2), `cleo playbook run/status/resume/list` CLI (AC3), thin-agent two-layer enforcer (dispatch-time + parse-time) (AC4), `orchestrate approve/reject/pending` wired to `playbook_approvals` table (AC5), `composeSpawnPayload` integration test (AC6), `orchestration-flow.md` + ADR-053 shipped (AC7), Vercel AI SDK consolidation (AC8), harness interop tests with 3 provider backends (AC9), all 8 children documented in CHANGELOG (AC10). Quality gates: biome strict (1499 files), 9024 tests pass.

---

### T949 — Studio /tasks Explorer Hybrid Dashboard

**Audit task**: T1219  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T949-verdict.md`  
**Verdict**: `verified-complete` (HIGH confidence)

T949 shipped in v2026.4.97 across 14 commits and 11 child tasks (T950-T960). All 12 acceptance criteria are met. The delivery is organized in three waves: Wave 0 (shared components, URL-state store, SSR data loader), Wave 1 (Hierarchy/Graph/Kanban tabs), and Wave 2 (hybrid dashboard merge, 301 redirects, deferred→cancelled rename). 688 total tests (655 unit + 33 E2E Playwright) exceed the "30+ tests" criterion. T990, filed the same day T949 shipped, is a design follow-up ("This UI/UX looks like SHIT") that explicitly carves out T949's Wave 0 primitives as stable infra. T990 does not falsify T949's completion.

---

### T962 — Clean Code SSoT Reconciliation

**Audit task**: T1217  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T962-verdict.md`  
**Verdict**: `verified-complete` (HIGH confidence)

T962 shipped in v2026.4.97 across 11 substantive commits. 15 of 16 acceptance criteria are met; criterion 11 (579 dispatch param-casts eliminated) was explicitly deferred to v2026.4.98 per operator A+C decision, with the foundation (TypedDomainHandler adapter, T974) shipped. Key deliveries: CONDUIT promoted to dispatch domain #15 superseding ADR-042 (T964), `operations/brain.ts` → `operations/memory.ts` (T965), `core/store/brain-*` → `memory-*` (T966), CLI command renamed (T967), new `operations/brain.ts` for unified-graph ops (T968), `@cleocode/brain` package extracted (T969), HTTP routes renamed `/api/living-brain→/api/brain→/api/memory` (T970-T972), `LB*` types → `Brain*` (T973), TypedDomainHandler<O> + typedDispatch adapter (T974), and documentation updates (T984-T986). Quality gates: biome clean, 9190 tests pass.

**Note**: `tasks.verification_json` was NULL for T962 in the DB — this is a schema artifact from the pre-ADR-051 era, not a work gap. Git-log + release-tag evidence per Council mandate is first-class.

---

### T988 — Dispatch Typed Narrowing

**Audit task**: T1218  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T988-verdict.md`  
**Verdict**: `verified-incomplete` (HIGH confidence)

T988 is the clearest false-completion in the cohort. Marked `done` at `2026-04-20T15:22:45.694Z`, only 1 of 9 required domain migrations (T975, session domain, commit `630bed186`) was implemented. T976-T983 have zero commits. Current cast counts: nexus.ts (82 casts), tasks.ts (115), memory.ts (136), admin.ts (116), plus pipeline/check/conduit/sticky/docs/intelligence domains untouched. Approximately 450 of the original 579 casts remain.

The probable root cause is auto-completion cascade: T975 child task completion triggered the epic's done state without verifying the remaining 8 children. The CLEO-DISPATCH-ADAPTER-SPEC.md migration status section was never populated.

**Remediation**: Reopen T988. T976-T983 tasks must be created at `status=proposed`. See Section 7.

---

### T991 — BRAIN Integrity: Write-Path Guardrails + Noise-Pump Fix

**Audit task**: T1227  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T991-verdict.md`  
**Verdict**: `schema-artifact-not-work-defect` (HIGH confidence)

T991 is the Council's flagship case. `cleo list --parent T991` returns 0 children and `cleo show T991` shows `childRollup: {total: 0, done: 0}`. The DB view suggests no work was done. The git view is definitive: release commit `18128e3cec6b61f7486c136fb9a2cd956c51b37c` (`chore(release): v2026.4.98 — T991 + T1000 + T1007 Tier 2 + T1013 hygiene`) documents all 8 child tasks (T992-T999) with 9 substantive commits. All 10 acceptance criteria are implemented.

Child task commit map:
- T992 (`5e2f1a073`): verifyAndStore routing — 4 call sites
- T993 (`738d4bd1a`): Check A0 title-prefix blocklist — 8 test cases
- T994 (`fb59ba1fa`): correlateOutcomes Step 9a.5 + trackMemoryUsage — 7 tests
- T995 (`8493fc351`): Step 9f hard-sweeper DELETE predicate
- T996 (`0de82f872`): Dream cycle → sentient tick loop — setTimeout drift removed
- T997 (`71c2f2ff` + `0c417d0ce`): `cleo memory promote-explain` CLI + bridge registration
- T998 (`9abc54d2e`): NEXUS plasticity columns + Step 6b
- T999 (`fe6dcd26a`): memory-bridge mode flag (cli default)

**Remediation**: DB parent-child link repair only (no code rework). See Section 7.

---

### T1000 — BRAIN Advanced

**Audit task**: T1226  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T1000-verdict.md`  
**Verdict**: `verified-complete` (HIGH confidence)

T1000 exhibits the same `schema-artifact-not-work-defect` pattern as T991: `childRollup: {total: 0, done: 0}` in the DB, but 18 commits across 6 child tasks (T1001-T1006) in git history. All 7 acceptance criteria are implemented and tested (78+ new assertions). Key deliveries: typed promotion with 6-signal composite scorer and `brain_promotion_log` audit table (T1001), transcript ingestion with `brain_transcript_events` table, idempotent ingestor, redaction, and `tool_use`/`tool_result`/`thinking` block unblocking (T1002), staged backfill runner with approve/rollback CLI (T1003), pre-compact flush with WAL checkpoint (T1004), 'diary' observation type (T1005), and 7 missing CLI operations with 29 new tests (T1006). Released in v2026.4.98.

The audit notes this as `verified-complete` rather than `schema-artifact-not-work-defect` because all work is confirmed shipped — the DB link corruption is the same mechanical defect as T991 but the work quality assessment is unambiguous.

---

### T1013 — System Improvements Hygiene

**Audit task**: T1225  
**Verdict file**: `.cleo/agent-outputs/T1216-audits/T1013-verdict.md`  
**Verdict**: `verified-incomplete` (HIGH confidence)

T1013 shipped 2 of 5 acceptance criteria. The satisfied criteria (`cleo update --files` wiring with 33 test lines, and orchestrate spawn epic role auto-promotion with 38-line integration test) are confirmed in commit `e345dc303`. A third criterion (Svelte 5 `.svelte.ts` rune files) is satisfied in the current codebase but was committed 2 hours 38 minutes **after** T1013 was marked done at `2026-04-20 04:48:22` (Svelte fix commit: `2a756b939` at `07:26:35`). At completion time, the v2026.4.98 CHANGELOG explicitly listed this as a known issue.

Two documentation criteria remain unaddressed with zero commits:
- AC4: Release-task dep pruning pattern documented in CLEO-INJECTION.md
- AC5: ADR-051 override-pattern for docs-only + release-formality documented

**Remediation**: Create two follow-up documentation tasks. See Section 7.

---

## 5. Root-Cause Analysis

### Why 12 Tasks Had `verification_json=NULL`

The CLEO task completion engine (`packages/cleo/src/dispatch/engines/task-engine.ts`) at line 831 (pre-fix state) contained a conditional that re-validated `verification.evidence` atoms only when `task.verification` was already populated. The critical path:

```
taskCompleteStrict() [pre-fix]
  → step 1-4: parent lifecycle gate, basic validation
  → step 5: IF task.verification EXISTS → re-validate atoms
  → step 6: mark complete
  (NO BRANCH: if task.verification IS NULL → reject)
```

This meant an agent could call `cleo complete T###` without ever calling `cleo verify --gate implemented --evidence "..."`. The engine would accept the completion silently, setting `status=done` while leaving `verification_json=NULL`.

The 12 suspect tasks in this audit cohort completed before ADR-051 enforcement was wired at the engine layer. These tasks form a subset of a broader 176-row cohort (all pre-ADR-051 completions with `modified_by=NULL`). The full 176-row backfill is handled separately in T1321.

### The Evidence Asymmetry Problem

Because `tasks.verification_json` was NULL for all 12 suspects, a naive audit reading only the DB would conclude "false completion" for every target. The Council's mandate that git-log and release-tag evidence be treated as first-class evidence channels (co-equal with `tasks.verification_json`) was essential: 8 of the 12 targets show complete, well-tested work in git history despite having NULL in the DB column.

The T991 case is paradigmatic: `cleo list --parent T991` returns 0 children; `git log --all --grep="T99[4-9]"` returns 16 commits across 8 child tasks in release v2026.4.98. The DB parent-child relationship was simply never populated by the orchestration layer.

---

## 6. CLEO Engine Fix Summary (T1222)

T1222 was executed as a **blocking predecessor** to the 12 per-epic audit tasks, per Council mandate.

### Red Commit: `6ce9cf267`

**Message**: `test(T1222): failing tests — taskCompleteStrict must reject verification_json NULL + populate modified_by/session_id`

Three failing tests introduced in `task-engine.test.ts`:
1. `taskCompleteStrict rejects with E_EVIDENCE_MISSING when task.verification is null` (CLEO-VALID-26)
2. `taskComplete populates modified_by from CLEO_AGENT_ID on completion` (CLEO-VALID-27)
3. `taskComplete populates session_id from active session on completion` (CLEO-VALID-27)

### Green Commit: `d04d5fe2b`

**Message**: `feat(T1222): reject tasks.complete when verification_json is NULL + populate modified_by/session_id`

**Changes to `packages/cleo/src/dispatch/engines/task-engine.ts`**:

**CLEO-VALID-26 (`taskCompleteStrict`)**: A NULL check now fires after the parent-epic lifecycle gate (step 4) and before the completion write. If `task.verification` is NULL, the engine returns `E_EVIDENCE_MISSING` with a fix hint pointing to `cleo verify --gate implemented --evidence "..."`. Epics are exempted from this check (they are auto-completed by rollup, not by the verify-then-complete ritual).

**CLEO-VALID-27 (`taskComplete`)**: Every successful completion now stamps two additional fields via `accessor.updateTaskFields`:
- `modified_by`: set from `process.env.CLEO_AGENT_ID`, defaulting to `"cleo"`
- `session_id`: set from `getActiveSession()`, with fallback to `process.env.CLEO_SESSION_ID`

The write is best-effort: a failure does not roll back the completion.

### Test Results

7/7 new tests pass. The engine fix is merged into main and was active for all 12 per-epic audit tasks.

---

## 7. Remediation Queue

### `verified-incomplete` Targets

#### T820 — Project-Agnostic Release Pipeline (5/7 ACs)

| Item | Action |
|---|---|
| RELEASE-03: IVTR gate check missing | Create child task: "Implement `ivtr_state.currentPhase` check in `release-manifest.ts`; add `--force` bypass with audit-trail warning" |
| RELEASE-07: IVTR→release auto-suggest missing | Create child task: "Wire `cleo release ship` as auto-suggested next step after `cleo orchestrate ivtr <epic> --release` succeeds" |
| T820 epic status | **Reopen** T820 (change status from `done` to `active`/`blocked`) and create T820B with the two IVTR child tasks |

**Dependency note**: T820B depends on T810 (IVTR state tracking queryable at task level) and T768 (programmatic gates). Verify IVTR query interface stability before wiring.

---

#### T988 — Dispatch Typed Narrowing (1/13 ACs)

| Item | Action |
|---|---|
| T976-T983 never shipped | Create 8 child tasks at `status=proposed` under a new epic (or reopen T988 and create children) |
| ~450 casts remain | Each child task migrates one domain handler: nexus (82 casts), tasks (115), memory (136), admin (116), plus pipeline/check/conduit/sticky/docs/intelligence |
| CLEO-DISPATCH-ADAPTER-SPEC.md | Update with actual migration status: T975 shipped (session), T976-T983 pending |
| T988 epic status | **Reopen** T988 (change status from `done` to `active`) |

---

#### T1013 — System Improvements Hygiene (2/5 ACs)

| Item | Action |
|---|---|
| AC4 unaddressed | File sibling task: "Document release-task dep pruning pattern in CLEO-INJECTION.md" |
| AC5 unaddressed | File sibling task: "Document ADR-051 override-pattern (docs-only + release-formality) in CLEO-INJECTION.md" |
| T1013 status | Mark `verified-incomplete`; two small follow-up tasks are sufficient to close (estimated small size each) |

---

### `schema-artifact-not-work-defect` Target

#### T991 — BRAIN Integrity (DB link repair only)

| Item | Action |
|---|---|
| `epic_children` table empty | Populate parent-child links: T991→{T992,T993,T994,T995,T996,T997,T998,T999} |
| `childRollup` cache stale | Update cache after link population |
| Verify | `cleo show T991` should return correct child counts post-repair |

No code rework required. This is a schema/data integrity task only.

---

## 8. Sibling Tasks Filed

Two sibling tasks were filed by the Council as direct outcomes of the T1216 findings:

### T1321 — 176-Row Pre-ADR-051 Backfill

Addresses the systemic 176-row cohort: all tasks with `modified_by=NULL` + `session_id=NULL` completed before ADR-051 enforcement. This is distinct from the 12-suspect forensic audit — it is a bulk schema correction, not a per-epic verification. Per Council mandate, split into multiple waves to avoid atomic DB writes of excessive scale.

### T1322 — `cleo audit reconstruct` SDK Primitive

An Expansionist opportunity identified by the Council: the git-log + release-tag lineage reconstruction logic developed internally for T1216's per-epic audits belongs in `packages/core/` as a first-class `audit.reconstructLineage(taskId)` SDK verb per D023 SDK-first + canonical layering. This primitive would make future false-completion audits O(1) instead of requiring per-epic manual archaeology.

---

## 9. BRAIN Observations Cross-Reference

The following memory observations were recorded by audit subagents and are available in the BRAIN (searchable via `cleo memory find "audit verdict"`):

| Target | BRAIN Observation IDs |
|---|---|
| T569 | `O-mod5lzks-0` |
| T820 | `O-mod6l0qf-0`, `O-mod5uof7-0` |
| T870 | `O-mod5o7v5-0` |
| T876 | `O-mod5mexf-0` |
| T882 | `O-mod5ve5g-0` |
| T988 | `O-mod5ko71-0`, `O-f516f6ae`, `O-340c629d`, `O-205b2ed8`, `O-0c8ecedb`, `O-6cb9e22a` |
| T991 | `O-mod5o5p4-0` |
| T1000 | `O-mod6k7tv-0`, `O-mod5s5mh-0` |
| T1013 | `O-1e1e097e`, `O-caf4ac7d`, `O-f8efebc1`, `O-16a3efd5`, `O-1dffcdbf` |

Retrieve any observation with `cleo memory fetch <id>`.

---

## Appendix: Methodology

All 12 audits followed the Council-mandated four-outcome taxonomy with git-log and release-tag as first-class evidence channels. Each audit subagent was instructed to:

1. Read task requirements via `cleo show <targetId>`
2. Trace all commits with `git log --all --grep="<targetId>"` AND `git log --all --grep="<childId>"` for each child task ID
3. Inspect acceptance criteria against code on disk
4. Cross-reference release tags and CHANGELOG entries
5. Apply the four-outcome taxonomy:
   - `verified-complete`: all ACs met with programmatic evidence
   - `verified-incomplete`: work partially shipped, ACs demonstrably unmet
   - `schema-artifact-not-work-defect`: work shipped but DB state corrupted/missing
   - `inconclusive`: insufficient evidence to determine either way

The T1222 engine fix was confirmed merged and active before any audit subagent was spawned.
