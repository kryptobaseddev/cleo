# CLEO Master Backlog — Verified Snapshot 2026-04-28

> Single ranked SSoT. Deduplicated against CLEO task DB + planning docs + in-source markers.
> Replaces the "Outstanding scope" section from the prior NEXT-SESSION-HANDOFF.md (dated 2026-04-25).
> Verified against live git, npm, and CLEO DB at write time (2026-04-28T03:00Z).

---

## Definitive current state (verified)

| Item | Value | How verified |
|------|-------|--------------|
| Latest tag on origin/main | **v2026.4.152** | `git tag --sort=-v:refname \| head -1` |
| HEAD on origin/main | `b4aa64f5f` (fix CI: restore executable bit on cleo.js) | `git log -1 --oneline` |
| Latest `@cleocode/cleo` on npm | **2026.4.152** | `npm view @cleocode/cleo version` |
| Total tasks (pending+active) | **296** (270 pending + 26 active) | `cleo dash` |
| Total done | 87 | `cleo dash` |
| Total cancelled | 10 | `cleo dash` |
| Grand total (incl archived) | 1508 | `cleo dash` |
| Known open epics | T942, T990, T1042, T1056 (pending); E1 (active) | `cleo find` |
| force-bypass.jsonl entries this session (2026-04-27) | **20** | `grep 2026-04-27 .cleo/audit/force-bypass.jsonl \| wc -l` |
| force-bypass.jsonl entries (2026-04-24 to 2026-04-28, 4-day audit window) | **246** (36 unique tasks) | A4 inventory reconciliation |
| force-bypass.jsonl total entries | **665** (no enforcement gate) | A4 inventory reconciliation |
| Pre-existing test failures | 6 (brain-stdp×3, sqlite-warning-suppress×2, pipeline.integration) | `pnpm run test` (verified in v2026.4.152 release) |
| Test suite passing count | 11507 | CHANGELOG.md v2026.4.152 |
| Orphaned tasks (no parentId despite clear epic affiliation) | **~51** | A1 DB inventory (2026-04-28) |
| Shell-task orphan cluster (T029-T068, T105-T106) | **25 tasks** with real planning docs, empty CLEO records | A2 inventory (2026-04-28) |
| Stalled pending epics with 0 children | **8 epics** (T889, T942, T946, T990, T1042, T1232, T631, T939/T940/T941) | A2 inventory (2026-04-28) |
| RCASD workspaces with content for non-archived tasks | **~5 stalled** (out of 79 total; ~45 substantive; ~40 of those archived/done) | A2 inventory (2026-04-28) |

**Note on force-bypass entries**: 20 uses on 2026-04-27 (this session). The majority are `testsPassed` overrides citing "pre-existing failures unrelated to campaign scope" (notably T1473 nexus decomposition, which used a workaround citing 5 pre-existing failures). Two are in T948 (SDK public surface). None filed a regression task first. See P0 item #3.

**A4 audit (2026-04-24 to 2026-04-28, 4-day window)**: 246 total force-bypass entries across 4 days, 36 unique tasks bypassed — nearly double the A3 3-day figure of 106. One "emergency hotfix incident 9999" entry has no task ID attached. Total `force-bypass.jsonl` size: **665 entries** (184 lifecycle_scope_bypass + 481 evidence_override) with no enforcement gate. Top patterns: epic lifecycle advancement (18+ entries), subagents advancing parent epic lifecycle (6+ entries), worktree pre-existing test failure workarounds (many). This session's 20 entries represent ~8% of the 4-day window. The pattern is escalating, not isolated. See P0-3, P0-5, P0-6, and new P0-7 below.

**A1 structural audit (2026-04-28)**: 51 orphaned tasks exist in the DB with no `parentId` despite clear epic affiliation. These tasks are invisible to `cleo list --parent <epicId>`, making epics appear empty when they have substantial planned work. See new P0-7.

**A2 inventory (2026-04-28)**: 25 shell-task stubs (T029-T068, T105-T106) have rich planning docs attached but empty CLEO records (title = "Task XX", no description, no acceptance criteria). Total task-record integrity gap: 51 orphans (A1) + 25 shells (A2) = **~76 task records** lacking coherence. Additionally, 8 pending epics have 0 children and stalled planning (T889, T942, T946, T990, T1042, T1232, T631, T939/T940/T941). See new P0-NEW and P1-NEW-3 below.

---

## P0 — Active blockers (ship-stoppers)

### P0-1: `cleo memory sweep --rollback <runId>` dispatch gap (carried from v2026.4.141)
- **Task**: No task filed yet — needs filing
- **Why blocker**: `mutate:memory.sweep` with rollback verb returns `E_INVALID_OPERATION`. The `case 'sweep'` block in `memory.ts` already handles rollback internally — the only problem is `'sweep'` appears in the `query[]` routing array only, never in `mutate[]`. Fix is literally 1 LOC.
- **Fix**: Add `'sweep'` to the `mutate[]` array in `getOperationConfig()` in `packages/cleo/src/dispatch/domains/memory.ts` (~line 1994). The rollback case block already exists — only the routing dispatch entry is missing.
- **Acceptance**: `cleo memory sweep --rollback <runId>` exits 0 and no longer returns `E_INVALID_OPERATION: Unknown operation: mutate:memory.sweep`; `pnpm run test` green; biome clean.
- **Effort**: small (~1 LOC change, not ~20)
- **Owner required**: No (implementation straightforward)
- **File command**: `cleo add "Fix: add 'sweep' to mutate[] routing in memory dispatch (1 LOC)" --parent T1147 --size small --priority critical`

### P0-2: 68-candidate BRAIN sweep — owner decision (now moot; re-run decision only)
- **Task**: No task ID — owner decision required before action
- **A3 update**: All 4 `brain_backfill_runs` rows have `status=rolled-back`. There is no live staged sweep awaiting approval. The prior handoff's framing of "awaiting owner decision before action" is moot — the rollback already happened. The outstanding decision is only: does the owner want to re-run a fresh sweep in the future?
- **Why still tracked**: If owner wants to re-run, P0-1 (rollback gateway fix) must be confirmed working first. If owner does not want to re-run, this item should be explicitly documented as abandoned in BRAIN.
- **Acceptance**: Owner decision documented in BRAIN (`cleo memory observe ...`) — either "re-run when rollback gateway is fixed" or "permanently abandoned, no action needed".
- **Effort**: owner decision only (then small if re-run)
- **Owner required**: YES — irreversible data operation if re-run

### P0-3: 246 force-bypass entries in 4 days — escalating override pump (this session + prior)
- **Task**: No task filed — needs filing per ADR-051 policy
- **Why blocker**: The prior handoff (v2026.4.141) documented the meta-failure: "NO owner-overrides without (a) a regression task filed first." This session used 20 overrides on 2026-04-27. The broader A4 audit window (2026-04-24 to 2026-04-28) reveals **246 entries across 36 unique tasks** — nearly double the A3 3-day figure of 106. Total `force-bypass.jsonl` entries ever: **665** (184 lifecycle_scope_bypass + 481 evidence_override). Top offending patterns: epic lifecycle advancement (18+ entries), subagents advancing parent epic lifecycle to unblock worktrees (6+ entries). The orchestrator's 20 entries from this session are ~8% of the 4-day total — meaning 226 more came from prior sessions in the same window.
- **Specific violations this session**: T1473 `testsPassed` override citing "pre-existing failures in brain-stdp, pipeline integration, sentient daemon, session-find, e2e-safety"; T948 `testsPassed` override. The claim that "pipeline integration, sentient daemon, session-find" failures are pre-existing (not introduced by nexus decomposition) was NOT independently verified.
- **Notable anomaly (A4)**: One entry dated 2026-04-25T06:01 records "emergency hotfix incident 9999" with **no task ID attached**. If this was a real hotfix, a regression task must be filed retroactively; if it was a process test, document and close.
- **Acceptance**: (1) Audit 2026-04-27 session's 20 overrides — verify each "pre-existing" claim against `git blame` + test output; file regression tasks for any introduced by the campaign. (2) Owner informed of 246-entry, 4-day escalation. (3) "Emergency hotfix incident 9999" entry investigated and task filed or closed.
- **Effort**: small-medium investigation
- **Owner required**: Owner should be informed (policy violation, escalating pattern)

### P0-4: `pipeline.integration.test.ts` — 7 failing tests (passGate crash on undefined gateName)
- **Task**: No task filed — needs filing. Previously miscategorized as "backup-pack.test.ts failure."
- **A3 correction**: A3 confirmed all 29 backup-pack.test.ts tests PASS in isolation. The test-runner failure seen during investigation was from `pipeline.integration.test.ts` running alongside it, not from backup-pack itself. The backup-pack staging-dir cleanup failure from handoff item 3 no longer exists.
- **Actual failure**: `packages/core/src/lifecycle/__tests__/pipeline.integration.test.ts` has 7 failing tests. Root cause: `passGate(epicId, gateName)` called with `gateName=undefined` — `gateName.split` crashes. Test authoring issue (tests don't assert gateName is defined before calling), but production code (`lifecycle/index.ts:passGate`) also lacks defensive guard. Pre-existing before v2026.4.141. Routinely bypassed via owner-override with "pre-existing failures unrelated to campaign scope."
- **Why blocker**: These 7 failures are the main source of perpetual `testsPassed` overrides. No task filed = no track = masked indefinitely.
- **Acceptance**: `passGate` gracefully handles undefined `gateName` (returns error, does not crash) OR test file updated so caller always passes named gate; all 7 tests in `pipeline.integration.test.ts` pass; `pnpm run test` net-gain of 7 fewer failures.
- **Effort**: small
- **Owner required**: No
- **File command**: `cleo add "Fix pipeline.integration.test.ts — 7 failing passGate tests (gateName undefined crash)" --size small --priority high`

### P0-5: `CLEO_OWNER_OVERRIDE` per-session cap — promoted from P3 (was P3-1)
- **Task**: No task filed (proposed in v2026.4.141 handoff as "T-PUMP-OVERRIDE-CAP")
- **Promotion rationale**: A4 audit found **246 force-bypass entries in 4 days** across 36 unique tasks (A3 had found 106 in 3 days — A4 expanded the window and nearly doubled the count). The handoff warned about 15 batch overrides; the pattern repeated within 72 hours and has now escalated further. This is not a process hygiene concern — it is an active governance failure. P3 severity was wrong; this is P0.
- **Why blocker**: Zero limits on owner-override invocations per session. A cap with ADR-style waiver requirement would enforce the policy programmatically and make the escalation self-limiting. Without it, the 246-entry / 4-day rate (665 total) will continue unchecked.
- **Effort**: medium
- **Owner required**: No (design is clear from A3/A4 recommendations)
- **File command**: `cleo add "Pump: cap CLEO_OWNER_OVERRIDE invocations per session to N — require waiver doc above N" --size medium --priority critical`

### P0-6: `--shared-evidence` flag for batch closes — promoted from P3 (was P3-2)
- **Task**: No task filed (proposed in v2026.4.141 handoff as "T-PUMP-BATCH-EVIDENCE")
- **Promotion rationale**: Promoted alongside P0-5. A single shared `tool:pnpm-test` atom across N>3 child tasks enables the batch-override pattern that produced the 246-entry escalation in 4 days. Without requiring explicit `--shared-evidence`, agents can silently batch-close many tasks on a single unverified test run.
- **Why blocker**: Enables silent mass-override. The 36-task bypass pattern in 4 days is only possible because batch evidence sharing is unchecked.
- **Effort**: medium
- **Owner required**: No
- **File command**: `cleo add "Pump: require --shared-evidence flag when same evidence atom closes >3 tasks" --size medium --priority critical`

### P0-7: 51 orphaned tasks invisible to `cleo list --parent` — DB structural integrity gap (new, from A1)
- **Task**: No task filed — needs filing
- **Why blocker**: A1 inventory (2026-04-28) found 51 pending tasks with clear epic affiliation but no `parentId` set in the DB. These tasks are invisible when running `cleo list --parent <epicId>`, making epics appear empty when they have substantial planned work already filed. Work is effectively lost from the orchestrator's view.
  - **EP1/EP2/EP3 Nexus tasks** (T1057–T1073, 17 tasks) → belong under T1054/T1055/T1056
  - **CLOSE-ALL tasks** (T1104/T1105/T1108/T1109/T1111/T1112/T1115/T1116/T1117/T1130/T1131/T1132, 12 tasks) → belong under T1106
  - **Agents-arch tasks** (T897–T909, 13 tasks) → belong under T1232 or T942
  - **Sandbox/Tier3 tasks** (T923/T925/T1009–T1012/T1029/T1030/T1032, 9 tasks) → belong under T911 or T942
- **Acceptance**: Every task with a clear epic affiliation has its `parentId` set; `cleo list --parent <epicId>` returns the full child set for all affected epics; orphan count = 0 for these task groups. Note: T1104/T1105 reference v2026.4.102 (50 versions stale) — verify relevance before re-parenting; may need cancellation instead.
- **Effort**: medium (scriptable via `cleo task update` calls — ~51 calls plus staleness verification for v2026.4.102-era tasks)
- **Owner required**: No for mechanical re-parenting; YES for T1106 decision (see P1-NEW-2 below)
- **File command**: `cleo add "Fix: re-parent 51 orphaned tasks to correct epics — T1057-T1073→T1054/T1055/T1056, T897-T909→T1232/T942, T923/T925/T1009-T1012/T1029-T1032→T911/T942" --size medium --priority high`

### P0-NEW: 25 shell-task stubs with real planning docs but empty CLEO records (from A2)
- **Tasks**: T029–T068, T105–T106 (25 tasks with generic titles "Task 29", "Task 30", etc.; T105 = "Target 5", T106 = "Target 6")
- **Why blocker**: These were filed circa 2026-03-21 by an agent that produced research outputs and registered stub task records with auto-generated IDs but never populated titles, descriptions, or acceptance criteria. The planning content is real and valuable (T030 = 40KB FK audit, T031 = 25KB index analysis, T106 = 16KB session audit, T105 = 10KB enforcement audit, T062 = 5KB epic enforcement, T045 = 8KB nexus assessment). As stubs they are invisible to meaningful orchestration — `cleo show T030` returns a record with zero useful content. Combined with the 51 orphans from A1, **~76 task records lack integrity**.
- **Root cause**: Planning session (circa 2026-03-21) auto-filed stubs; follow-on session never renamed/populated them.
- **Acceptance**: Each of the 25 shell tasks either (a) receives a proper title + description summarizing the attached planning doc + concrete acceptance criteria for follow-through, OR (b) is cancelled with a rationale citing the doc as historical research. Owner review of the 4 largest first (T030/T031/T106/T105) is recommended.
- **Effort**: Medium — ~25 tasks × ~5 min each ≈ 2 hours. Owner can triage the 4 largest; an agent can batch-update the remaining 21 simpler shells.
- **Owner required**: For cancel/accept decisions; the bulk rename+describe pass can be agent-executed after owner triage of the 4 large ones.
- **Suggested update commands (sample — confirm titles before running)**:
  ```bash
  cleo update T030 --title "FK Audit: 18 soft foreign keys in CLEO schema — remediation recommendations" --description "Complete audit of 18 soft FKs across tasks.db schema. Identifies missing ON DELETE cascades and index gaps. See .cleo/agent-outputs/T030-soft-fk-audit.md (40KB) for full findings." --acceptance "FK recommendations triaged — each accepted, deferred, or cancelled with rationale"
  cleo update T031 --title "Index Analysis: missing index recommendations for tasks.db query paths" --description "Complete index analysis for tasks.db. Covers missing composite indexes, query plan gaps, and recommendations. See .cleo/agent-outputs/T031-index-analysis.md (25KB) for full findings." --acceptance "Index recommendations triaged — each accepted, deferred, or cancelled"
  cleo update T106 --title "Session Audit: CLEO session lifecycle completeness review" --description "16KB session audit covering session start/end lifecycle completeness, edge cases, and gaps. See .cleo/agent-outputs/T106-session-audit.md." --acceptance "Session gaps triaged — each accepted, deferred, or cancelled"
  cleo update T105 --title "Enforcement Audit: CLEO gate + evidence enforcement completeness" --description "10KB enforcement audit covering gate-enforcement gaps (pre-ADR-051). See .cleo/agent-outputs/T105-enforcement-audit.md." --acceptance "Enforcement gaps triaged — each accepted, deferred, or cancelled"
  # Remaining 21 shells (T032-T045, T060-T068): agent can batch-update after owner triage of the 4 above
  ```

---

## P1 — Real planned work (from PLAN.md / handoff that's still valid)

### P1-1: T1492 — Thin remaining fat dispatch handlers (memory, sticky, orchestrate, release)
- **Task**: T1492 (`status:pending`)
- **Why**: Audit #4 found `memory.ts:91-115`, `sticky.ts:43-80`, `orchestrate.ts:127-151`, `release.ts:69-85`, `pipeline.ts:861-900`, `nexus.ts:569-623` still >5 lines per op — not yet thinned to ADR-058 standard.
- **Acceptance**: All remaining handlers ≤5 LOC body; logic in Core; build+tsc+tests green.
- **Effort**: medium
- **Owner required**: No

### P1-2: T1429 — brain-stdp deflake (T682-3 + perf-safety asserts)
- **Task**: T1429 (`status:pending`)
- **Why**: 3 brain-stdp tests have flakiness class T695-1 (already handled for one test). The other 3 need the same `restore-skip + documentation` pattern. Needed to get test suite to 0 pre-existing failures.
- **Acceptance**: `pnpm run test` exits 0 with no skip-override; all brain-stdp tests either pass deterministically or have documented skip rationale.
- **Effort**: small
- **Owner required**: No

### P1-3: T1403 — Post-deploy execution gap in CI (Pump #1) — filed, NOT implemented
- **Task**: T1403 (`status:pending, pipelineStage:research, zero children, zero evidence`)
- **A3 status**: Task is filed but not implemented. `status=pending` + `pipelineStage=research` + no children + no evidence atoms. CI still has no `execute-payload` post-tag stage. Filing the task is not the acceptance bar — implementation is.
- **Why**: CI ships code but no stage runs post-deploy migrations/sweeps/registry-publishes. Filed during v2026.4.141 session as a process pump to prevent meta-failure recurrence.
- **Acceptance**: CI pipeline has an `execute-payload` stage that RUNS post-deploy steps (not just exists as a task in CLEO); release workflow runs declared post-deploy steps; evidence atoms required to close.
- **Effort**: medium
- **Owner required**: No

### P1-4: T1404 — Parent-closure-without-atom enforcement (Pump #2) — filed, NOT implemented
- **Task**: T1404 (`status:pending, pipelineStage:research, zero children, zero evidence`)
- **A3 status**: Task is filed but not implemented. `status=pending` + `pipelineStage=research` + no children + no evidence atoms. `cleo complete <epicId>` still accepts `verification=null`. The 106-entry override escalation (P0-3/P0-5) demonstrates the urgency. Filing the task is not the acceptance bar — implementation is.
- **Why**: `cleo complete <epicId>` for epics doesn't require evidence atoms or merkle inheritance from children. Filed during v2026.4.141 session.
- **Acceptance**: `cleo complete <epicId>` REJECTS in production (not just planned) if no direct evidence AND no verified children; `E_EVIDENCE_MISSING` raised with clear message; test demonstrates rejection.
- **Effort**: medium
- **Owner required**: No

### P1-5: T1405 — Fix claude-sdk adapter smoke and CleoOS doctor root handling
- **Task**: T1405 (`status:pending`)
- **Why**: CleoOS `doctor` command has root-handling issues; claude-sdk adapter smoke failing.
- **Acceptance**: `cleoos doctor` exits 0 in all path scenarios; claude-sdk adapter smoke passes.
- **Effort**: small-medium
- **Owner required**: No

### P1-6: T1462 — Worktree leak auto-cleanup on `cleo complete`
- **Task**: T1462 (`status:pending`)
- **Why**: Worktree branches accumulate and are not cleaned up when task completes. Long-running projects will accumulate stale worktrees.
- **Acceptance**: `cleo complete <taskId>` auto-prunes the associated worktree branch if present; `cleo backup list` shows no stale entries; tests green.
- **Effort**: small
- **Owner required**: No

### P1-7: T1463 — `getProjectRoot` trap (refuse parent .cleo dirs lacking sibling)
- **Task**: T1463 (`status:pending`)
- **Why**: `getProjectRoot` can traverse up and find a parent `.cleo` dir that doesn't correspond to the project root, causing unexpected operations on the wrong project.
- **Acceptance**: `getProjectRoot` refuses any `.cleo` dir that lacks the expected sibling markers; exits with clear error.
- **Effort**: small
- **Owner required**: No

### P1-8: PLAN.md §7.3 `reconcile-scheduler.ts` — periodic reconciler absent
- **Task**: No task filed — needs filing
- **Why**: The periodic reconciler scheduler from PLAN.md §7.3 was never built. Reconciliation runs only on-demand or via Sentient v1 dispatch reflex. Identified in v2026.4.141 handoff.
- **Acceptance**: `packages/core/src/sentient/reconcile-scheduler.ts` exists; scheduled reconcile runs on interval (configurable); tests cover schedule + cancel.
- **Effort**: medium
- **Owner required**: No
- **File command**: `cleo add "Implement reconcile-scheduler.ts — periodic BRAIN reconciler per PLAN.md §7.3" --parent T1139 --size medium --priority medium`

### P1-9: T1113 / T1114 — exports-map and verb-alias fixes in `@cleocode/nexus`
- **Task**: T1113 (`status:pending`), T1114 (`status:pending`)
- **Why**: `./dist/src/code/unfold.js` missing from `@cleocode/nexus` exports map (T1113); `cleo nexus group sync` verb alias not wired to contracts (T1114). These were tagged "RH/RI" in the PLAN.md backlog indicating they're known but blocked by other work.
- **Acceptance**: `@cleocode/nexus` exports map complete; `cleo nexus group sync` works as alias; build green.
- **Effort**: small ×2
- **Owner required**: No

### P1-NEW-1: Cancel / merge duplicate epics + stalled-epic triage (from A1 + A2)
- **Task**: No tasks filed for the cancellations — owner decisions needed before action
- **Why (A1 duplicates)**: A1 found three direct overlaps that waste orchestrator attention:
  - **T1466** (T-CLEANUP-WORKTREE, 0 children) duplicates T1461 (disk-space hygiene, 3 children). T1461 handles auto-trigger; T1466 was intended for explicit CLI verbs but has no children. Recommend: cancel T1466 or explicitly scope its CLI verbs and file children so it no longer overlaps.
  - **T1136** (CLEO-PROVENANCE, 0 children) overlaps T1407 T-INV-3 (commit-msg lint rule, fully decomposed and ready to execute). Both mandate `T\d+` in commit messages. Recommend: cancel T1136 or confirm T1407 T-INV-3 satisfies its scope.
  - **T889** (Orchestration Coherence v3, 0 children) was superseded by T1323 (Orchestration Coherence v1, done 2026-04-24). Recommend: archive T889 as superseded.
- **Why (A2 stalled epics)**: A2 found **8 additional pending epics with 0 active children** stalled since at least 2026-04-17. These require explicit owner decomposition-or-cancel decisions:
  - **T889** — Orchestration Coherence v3 (stalled 2026-04-17, also in A1 above; RCASD research stage is an empty stub). T910 v4 supersedes.
  - **T942** — Sentient CLEO Architecture Redesign (RCASD has 4 stage files, all empty stubs; requires owner RCASD session; no agent work without scoping).
  - **T946** — Autonomous Self-Improving Loop AGI capstone (worker crashed prompt-too-long; 0 children; needs narrow decomposition or cancel).
  - **T990** — Studio UI/UX Design System (0 children; requires owner design direction).
  - **T1042** — Cleo Nexus vs GitNexus Far-Exceed Analysis (RCASD stub only; many Nexus children exist separately but aren't linked in rollup).
  - **T1232** — PRE-WAVE: CLEO Agents Architecture Remediation (RCASD fully populated through validation; 3 children all pending; implementation stalled).
  - **T631** — EPIC: Cleo Prime Orchestrator Persona (low priority, no children, no RCASD; should be cancelled or given R-task decomposition).
  - **T939/T940/T941** — Test-artifact epics for T929 lifecycle bug (RCASD has 5 stage files each, all empty stubs; per prior sessions: "cancel via owner override" — blocked by T877 invariant).
- **Acceptance**: Each overlap resolved — either cancellation confirmed in CLEO DB or new scope documented. No duplicate epics targeting the same deliverable. Each of the 8 stalled epics has an explicit decision: decompose-with-children OR cancel.
- **Effort**: small per epic (owner decisions + `cleo task cancel` or `cleo task update` calls; T939/T940/T941 require owner override due to T877 invariant)
- **Owner required**: YES — owner must decide fate of T1466/T1136/T889 (duplicates) + T942/T946/T990/T1042/T1232/T631/T939/T940/T941 (stalled)

### P1-NEW-2: T1106 CLOSE-ALL stale epic decision — v2026.4.102 era (from A1)
- **Task**: T1106 (`status:pending`, `priority:critical`) — owner decision required
- **Why**: T1106 was filed as the CLOSE-ALL + sandbox proof blocker for v2026.4.102. Current version is v2026.4.152 — 50 patches later. T1106 still has 1 live child (T1139, pending) and ~12 tasks orphaned from it (T1104/T1105/T1108/T1109/T1111/T1112/T1115/T1116/T1117/T1130/T1131/T1132). T1104 and T1105 explicitly reference "v2026.4.102" — they are version-locked and almost certainly stale.
- **Owner choices**:
  1. **Close as superseded**: Mark T1106 done/archived; cancel the stale v2026.4.102 tasks (T1104, T1105); re-parent the still-relevant tasks (T1108, T1111, T1112, T1115, T1116, T1117, T1130, T1131, T1132) under T1232 or T942 as appropriate. T1139 remains under a live parent.
  2. **Rebuild as v2026.4.152 audit**: Reframe T1106 as the current real-world sandbox proof blocker, update scope, file new children targeting current version.
- **Acceptance**: Owner decision documented in BRAIN; T1106 either archived or reframed with updated children; T1104/T1105 cancelled if approach 1 is chosen.
- **Effort**: small (decision + `cleo task cancel`/`cleo task update` calls)
- **Owner required**: YES

### P1-NEW-3: Stalled-epic decomposition decisions — file children or cancel (from A2)
- **Task**: No tasks filed — owner decisions required for each of the 8 stalled epics
- **Why**: A2 confirmed all 8 epics listed in P1-NEW-1 (A2 section) have 0 active children and stalled or empty RCASD planning. Without an explicit decompose-or-cancel decision per epic, these waste orchestrator attention every session and prevent child tasks from being visible.
- **Decision table (owner must fill in each)**:

| Epic | Title | Stalled Since | Recommended Action | Owner Decision |
|------|-------|--------------|-------------------|---------------|
| T889 | Orchestration Coherence v3 | 2026-04-17 | Cancel — T910 v4 supersedes | _pending_ |
| T942 | Sentient CLEO Architecture Redesign | 2026-04-20 | Owner RCASD session first; DO NOT delegate to agent without scoping | _pending_ |
| T946 | AGI Capstone: Autonomous Self-Improving Loop | 2026-04-20 | Narrow decomposition or cancel — worker crashed prompt-too-long | _pending_ |
| T990 | Studio UI/UX Design System | 2026-04-20 | Needs owner design direction + frontend-design skill; defer or scope | _pending_ |
| T1042 | Cleo Nexus vs GitNexus Far-Exceed Analysis | 2026-04-20 | Decompose children (many Nexus children exist unlinked) or cancel | _pending_ |
| T1232 | PRE-WAVE: CLEO Agents Architecture Remediation | 2026-04-23 | RCASD complete; 3 children pending; need owner green-light to start implementation | _pending_ |
| T631 | EPIC: Cleo Prime Orchestrator Persona | ~2026-04-16 | Cancel or file R-task; low priority, no children | _pending_ |
| T939/T940/T941 | Test epics for T929 lifecycle bug | 2026-04-20 | Cancel via owner override (blocked by T877 invariant) | _pending_ |

- **Suggested cancel commands (for owner override cases)**:
  ```bash
  # T889 — cancel as superseded by T910
  cleo task cancel T889 --reason "Superseded by T910 Orchestration Coherence v4 (done 2026-04-24)"
  # T631 — cancel as low-priority dead end
  cleo task cancel T631 --reason "No children filed after ~12 days; low priority; no RCASD workspace; superseded by cleo-prime persona in BRAIN memory"
  # T939/T940/T941 — require CLEO_OWNER_OVERRIDE due to T877 invariant
  CLEO_OWNER_OVERRIDE=1 CLEO_OWNER_OVERRIDE_REASON="test-artifact epic cleanup — T877 blocks normal cancel" \
    cleo task cancel T939 --reason "Test artifact for T929 lifecycle bug — never intended as real work; all RCASD stage files are empty stubs"
  CLEO_OWNER_OVERRIDE=1 CLEO_OWNER_OVERRIDE_REASON="test-artifact epic cleanup — T877 blocks normal cancel" \
    cleo task cancel T940 --reason "Test artifact for T929 lifecycle bug — never intended as real work"
  CLEO_OWNER_OVERRIDE=1 CLEO_OWNER_OVERRIDE_REASON="test-artifact epic cleanup — T877 blocks normal cancel" \
    cleo task cancel T941 --reason "Test artifact for T929 lifecycle bug — never intended as real work"
  ```
- **Acceptance**: Every stalled epic either has (a) ≥1 filed child task (decomposed) OR (b) a cancellation record with rationale in the DB. Zero pending epics with 0 children remain in the undecided state.
- **Effort**: small per epic (owner decisions + commands above); T942/T990 require larger planning sessions before child filing
- **Owner required**: YES for all 8

---

## P2 — Cleanup + ship-state hygiene

### P2-1: nexus CLI still at 4084 LOC (not ≤500 target)
- **Task**: T1488 closed the "route bypass paths" part. T1492 (P1-1) covers remaining handlers.
- **Note**: The 500-LOC acceptance criterion for `nexus.ts` was NOT met by T1473 (went 5366→4084, not to ≤500). T1492 should include nexus in its scope.

### P2-2: T1151 4-pillar subtasks — never filed (T1152–T1159 in DB are UNRELATED T-MSR tasks)
- **Task**: No child tasks filed under T1151. T1151 itself is `status:archived`.
- **A3 correction**: T1152–T1159 exist in the DB but are **unrelated T-MSR (migration state reconciliation) tasks** — they got those IDs incidentally. They are NOT the 4-pillar self-healing subtasks. The four-pillar subtasks (step-level retry, reflection agent, session tree, soft-trim pruning, context budget, TUI adapter, pluggable filesystem/sandbox) were NEVER filed as concrete tasks. T1151 was absorbed into T1148 per Council 2026-04-24 with an owner-override `testsPassed`. The 4-pillar work is now aspirational with no task representation and no live parent.
- **If filing**: New tasks would need to be filed under T942 (Sentient CLEO Architecture Redesign) or a new planning epic — there is no live T1151 parent.
- **Effort**: owner decision only; filing each is small
- **Owner required**: Owner should scope these before agents file them (under T942 or new epic)

### P2-3: `observation_embeddings` / `turn_embeddings` tables — implementation needed (not just verification)
- **Task**: No task filed
- **A3 update**: `grep -rn "observation_embeddings\|turn_embeddings" packages/core/src/` returns zero results. These tables are confirmed ABSENT from the codebase. PORT-AND-RENAME §2 table-level schema items were silently dropped from scope. Column-level additions (provenance_class, times_derived, level, tree_id) land via lazy `ensureColumns` ALTER TABLE (confirmed present). The table-level items are not a verification concern — they are an implementation gap.
- **Why**: PORT-AND-RENAME §2 spec items. The spec called for dedicated embedding tables; only column-level ALTER TABLEs were implemented.
- **Effort**: small (schema + migration, not verification)
- **File command**: `cleo add "Implement observation_embeddings and turn_embeddings tables per PORT-AND-RENAME §2 (confirmed absent by A3 grep)" --size small --priority low`

### P2-4: ~~`conduit-schema.ts` extraction~~ — RESOLVED (see OBSOLETE section)

### P2-5: ~~`tasks-sqlite.ts` naming inconsistency~~ — RESOLVED (see OBSOLETE section)

### P2-6: biome symlink warning in CI (pre-existing)
- **Task**: No task filed
- **Why**: `pnpm biome ci .` emits 1 warning about a broken symlink. Has been present for multiple releases. Doesn't fail CI but is noise.
- **Effort**: tiny (identify + remove or fix symlink)

### P2-NEW-1: Stale SSoT-EXEMPT annotations — T1488 Phase 2 + T1451 incomplete (from A4)
- **Task**: No task filed — needs filing
- **Why**: A4 found 20 SSoT-EXEMPT annotations referencing tasks that are now `done`:
  - **14 annotations** in `packages/cleo/src/cli/commands/nexus.ts` say `pending T1488 Phase 2` — T1488 is `done`. Phase 2 dispatch ops (clusters, flows, context, hot-paths, hot-nodes, cold-symbols, diff, query-cte) were either descoped or never filed. Either remove the annotations and file a new "T1488-Phase-2" epic with the missing dispatch ops, or update annotations to reference the correct task ID.
  - **6 annotations** in `packages/core/src/metrics/token-service.ts` say `T1451 incomplete` — T1451 is `done`. If ADR-057 D1 normalization was fully implemented, remove annotations. If work was deferred, file a follow-up task.
- **Acceptance**: Zero SSoT-EXEMPT annotations referencing completed/archived tasks; if dispatch ops were genuinely descoped, a new epic captures them; if token-service normalization is complete, annotations removed.
- **Effort**: small (audit + annotation cleanup + optional new epic filing)
- **Owner required**: No (for cleanup); small decision needed on Phase 2 dispatch op scope
- **File command**: `cleo add "Clean up 20 stale SSoT-EXEMPT annotations: 14x pending T1488 Phase 2 in nexus.ts + 6x T1451 incomplete in token-service.ts — both tasks done" --size small --priority medium`

### P2-NEW-2: Stale deprecation cleanup — T310 shims + ADR-027 flat-file functions (from A4)
- **Task**: No task filed — needs filing
- **Why**: A4 found deprecated code retained for completed migrations:
  - **4 shims** in `packages/core/src/store/signaldock-sqlite.ts` retained "during T310 migration" — T310 is `archived/done`. The shims (`GLOBAL_SIGNALDOCK_SCHEMA_VERSION`, `getGlobalSignaldockDbPath()`, `ensureGlobalSignaldockDb()`, `checkGlobalSignaldockDbHealth()`) are dead code.
  - **5 flat-file functions** in `packages/core/src/memory/index.ts` deprecated per ADR-027 — T1093 (MANIFEST/RCASD Architecture Unification) is `done`. Callers should have been migrated; if migration is confirmed complete, remove the deprecated functions.
  - (Lower priority) **7 SkillLibrary\* type aliases** in `packages/caamp/src/types.ts` — if no external callers remain, remove.
- **Acceptance**: 4 T310-era shims removed from `signaldock-sqlite.ts`; 5 ADR-027 flat-file deprecated functions removed or confirmed still needed (if callers exist); build + tests green.
- **Effort**: small (removal + verification)
- **Owner required**: No
- **File command**: `cleo add "Remove stale deprecated shims: 4x T310-era in signaldock-sqlite.ts + 5x ADR-027 flat-file in memory/index.ts — both migrations done" --size small --priority medium`

### P2-NEW-3: TODO(T1082.followup) markers — unfiled embedding + telemetry work (from A4)
- **Task**: No task filed — needs filing
- **Why**: A4 found 6 `TODO(T1082.followup)` markers in BRAIN source files:
  - `packages/core/src/memory/session-narrative.ts` (lines 61, 256): embedding cosine similarity dedup deferred
  - `packages/core/src/memory/dialectic-evaluator.ts` (lines 117, 183, 213): confidence threshold tuning, telemetry when no LLM backend available, telemetry error surfacing
  - T1082 (parent epic) is `archived`. These follow-up items were never formally filed as tasks. Either file them as concrete tasks or remove the markers and accept current behavior.
- **Acceptance**: All `TODO(T1082.followup)` markers resolved — either replaced with real task ID references (for newly filed tasks) or removed (if work is explicitly deferred/abandoned).
- **Effort**: small (file 2–3 new tasks + update markers)
- **Owner required**: No
- **File command**: `cleo add "File T1082 follow-up tasks: (a) embedding cosine similarity dedup in session-narrative.ts (b) confidence threshold tuning + few-shot in dialectic-evaluator.ts (c) telemetry gaps when LLM backend unavailable" --size small --priority low`

### P2-NEW-4: T1XXX placeholder in `nexus/route-analysis.ts` — AST shape inference epic never filed (from A4)
- **Task**: No task filed — needs decision
- **Why**: `packages/core/src/nexus/route-analysis.ts:162` has a `T1XXX` placeholder referencing "future AST-based shape inference epic" — no task was ever filed. This is an orphan reference with no task linkage.
- **Acceptance**: Either (a) a concrete task is filed and `T1XXX` is replaced with the real task ID, or (b) the comment is rewritten to remove the placeholder without implying pending work.
- **Effort**: tiny (file one task + 1-line comment update)
- **Owner required**: No
- **File command**: `cleo add "File AST-based shape inference epic for nexus/route-analysis.ts T1XXX placeholder — replace placeholder with real task ID" --size small --priority low`

### P2-NEW-5: Pre-existing test failure regression tasks — sqlite-warning-suppress, backup-pack race, T1093-followup skips (from A4)
- **Task**: No tasks filed — needs filing (T1429 covers brain-stdp and performance-safety)
- **Why**: A4 identified 3 pre-existing test failures with no dedicated task tracking:
  - **`sqlite-warning-suppress.test.ts`** — 2 tests fail in worktree/git logic context (ENV sensitivity). No task filed.
  - **`backup-pack.test.ts`** — ENOTEMPTY race condition when sibling tests' staging dirs appear in `os.tmpdir()` (parallel test runner issue). No dedicated task filed (T1107 bypass mentions it but no ownership).
  - **2 skipped tests with `TODO(T1093-followup)` comments** — `brain-stdp-wave3.test.ts:364` (T695-1 session-bucket O(n²) guard) and `task-sweeper-wired.test.ts:157` (runGitLogTaskLinker). T1093 is done; follow-up tasks never filed.
  - (Additionally: `cant-napi` bridge tests skipped in `agent-fixtures.test.ts` — no task filed, but lower priority P4)
- **Acceptance**: A dedicated task exists for each of the 3 failures; acceptance criteria define either a fix (preferred) or a permanent skip with documentation justification.
- **Effort**: small (file 3 tasks)
- **Owner required**: No
- **File commands**:
  ```bash
  cleo add "Fix sqlite-warning-suppress.test.ts worktree-context flakiness — add skipIf guard for non-worktree environments" --size small --priority medium
  cleo add "Fix backup-pack.test.ts ENOTEMPTY race — isolate staging dir per-test via unique mkdtemp prefix" --size small --priority medium
  cleo add "Resolve T1093-followup skipped tests: re-enable or permanently close brain-stdp-wave3:T695-1 + task-sweeper-wired:runGitLogTaskLinker" --size small --priority low
  ```

### P2-NEW-6: T659 orphan test files — coverage-final-push + core-coverage-gaps (from A4)
- **Task**: No task filed
- **Why**: `packages/caamp/tests/unit/coverage-final-push.test.ts` and `packages/caamp/tests/unit/core-coverage-gaps.test.ts` both contain `TODO(T659): this file slated for deletion as coverage-debt`. T659 (`Phase 2: Test suite rationalization`) is `archived`. The files were supposed to be deleted but remain.
- **Acceptance**: Both files deleted; `pnpm run test` still green after deletion.
- **Effort**: tiny
- **Owner required**: No
- **File command**: `cleo add "Delete T659 orphan test files: caamp/tests/unit/coverage-final-push.test.ts + core-coverage-gaps.test.ts — T659 archived, files should have been removed" --size small --priority low`

### P2-NEW-7: Stalled RCASD workspaces — ~5 with content for non-archived tasks (from A2)
- **Task**: No task filed — owner decision per workspace
- **Why**: A2 audited 79 RCASD workspace directories under `.cleo/rcasd/`. Summary:
  - ~34 are empty stubs (only auto-generated YAML frontmatter, no notes)
  - ~45 have substantive content; ~40 of those map to archived/done tasks (historical records, no action needed)
  - **~5 have substantive content for tasks that are NOT archived** — these represent stalled mid-RCASD planning:
    - `rcasd/T1232/` (T1232 pending, RCASD through validation, 3 children all pending — implementation stalled)
    - `rcasd/T1106/` (T1106 pending, RCASD through implementation, 1 child T1139, CI investigation doc exists — partly complete)
    - `rcasd/T889/` (T889 pending, research stage only, empty stub — stalled)
    - `rcasd/T942/` (T942 pending, 4 stage files all empty stubs — stalled)
    - `rcasd/T919/` (T919 pending "Fix GH issue #94 — task auto-complete inconsistency", consensus stage only, empty stub — research never started)
- **Acceptance**: Each stalled RCASD workspace is either (a) advanced (its task gets children filed and implementation begins) OR (b) marked stalled/abandoned with a note in the RCASD research file explaining why planning was not followed through. No RCASD workspace with substantive content points at a pending task with zero implementation evidence.
- **Effort**: small audit + update per workspace
- **Owner required**: YES for T1232 (implementation go/no-go), T1106 (fate decision per P1-NEW-2), T942 (RCASD council session per P3-4)
- **File command**: `cleo add "Audit ~5 stalled RCASD workspaces with content for non-archived tasks: T1232, T1106, T889, T942, T919 — advance or mark stalled" --size small --priority medium`

---

## P3 — Process pumps + tooling

### P3-1: ~~New pump — `CLEO_OWNER_OVERRIDE` per-session cap~~ — PROMOTED TO P0-5

### P3-2: ~~New pump — `--shared-evidence` flag for batch closes~~ — PROMOTED TO P0-6

### P3-3: T1108 — Build hot-paths and cold-symbols (SDK + CLI + tests + dispatch registry)
- **Task**: T1108 (`status:pending`)
- **Why**: Comprehensive build hot-path documentation and cold-symbol identification. Prerequisite context for larger SDK/dispatch refactoring.
- **Effort**: medium
- **Owner required**: No

### P3-4: T942 — Sentient CLEO Architecture Redesign (major epic)
- **Task**: T942 (`status:pending`, `type:epic`)
- **Why**: Meta-epic covering: state SSoT unification across tasks+pipeline+SDK; ontology refactor with CANT-alignment; brain_page_nodes as universal semantic graph; Tier1/2/3 autonomy loop with Ed25519 signed receipts; llmtxt v2026.4.8 BlobOps+AgentSession adoption. Owner-scoped, requires RCASD planning session before agent work begins.
- **Effort**: large
- **Owner required**: YES — RCASD planning session required

### P3-5: T990 — Studio UI/UX Design System (major epic)
- **Task**: T990 (`status:pending`, `type:epic`)
- **Why**: Full UI/UX redesign across all Studio pages. Requires frontend-design skill engagement + design team. Not agent-executable without design direction.
- **Effort**: large
- **Owner required**: YES — design direction required

### P3-6: T1042 / T1056 — Nexus vs GitNexus far-exceed analysis + Living Brain Completion
- **Task**: T1042 (`status:pending`, `type:epic`), T1056 (`status:pending`, `type:epic`)
- **Why**: T1042 needs full feature-matrix + far-exceed decomposition. T1056 is the Living Brain Completion epic (5-substrate graph with BRAIN+NEXUS+TASKS+CONDUIT+SIGNALDOCK). T1048 is a revised synthesis task that supersedes T1047.
- **Effort**: large
- **Owner required**: T1042 direction OK for agents; T1056 requires owner prioritization

---

## OBSOLETE — items from prior handoff now resolved

| Prior Handoff Item | Resolved by | Version / Verification |
|--------------------|------------|---------|
| "T1402 stuck pending despite shipping" | T1402 closed in v2026.4.141 session (prior handoff) | v2026.4.141 |
| "T1414 CLEO-INJECTION.md size regression" | T1414 shipped in v2026.4.141 session | v2026.4.141 |
| "T1449 Core-Contracts SSoT alignment" | T1449 + all 11 children done, ADR-057 authored | v2026.4.150/151 |
| "T1435 dispatch type inference via OpsFromCore" | T1435 + T1436-T1445 all done, ADR-058 authored | v2026.4.146–150 |
| "T-THIN-WRAPPER (T1467) campaign" | T1467 + T1469-T1490 all done | v2026.4.152 |
| "T-SDK-PUBLIC (T948) — Core as embeddable SDK" | T948 done — @cleocode/core has public surface, README, doctests | v2026.4.152 |
| "biome inline-type regression rule absent" | T1448 added biome rule + regression test | v2026.4.152 |
| "MCP adapter using CLI subprocess" | T1485 migrated MCP adapter to @cleocode/core SDK | v2026.4.152 |
| "cleo-os coupled to @cleocode/cleo binary" | T1486 decoupled cleo-os | v2026.4.152 |
| "lint script L4 wildcard false-clean" | T1469 fixed hasWildcard fast-path | v2026.4.152 |
| "build.mjs sharedExternals regression (v2026.4.148)" | Fixed in v2026.4.152 validation phase | v2026.4.152 |
| "conduit/ops.ts declare const crash" | Fixed in v2026.4.152 validation phase | v2026.4.152 |
| "brain sleep-consolidation SQL e.observation_id" | Fixed in v2026.4.152 validation phase | v2026.4.152 |
| "TasksAPI.add() missing acceptance field" | Fixed in v2026.4.152 validation phase | v2026.4.152 |
| "T1414 CHANGELOG entry" | Commit `f82fd7c93` in v2026.4.142 CHANGELOG line 326; A3 verified | v2026.4.142 |
| "`tasks-sqlite.ts` naming inconsistency" | Commit `926f002c7` (2026-04-24): rename task-store.ts → tasks-sqlite.ts; A3 verified | post-v2026.4.141 |
| "`conduit-schema.ts` extraction — split hybrid file" | Commit `7300e3eed` (2026-04-24): split conduit-sqlite.ts → conduit-schema.ts (16 Drizzle tables); A3 verified | post-v2026.4.141 |
| "68-candidate BRAIN sweep awaiting owner approval" | All 4 `brain_backfill_runs` have `status=rolled-back`; no live staged sweep; A3 verified | Moot — rolled back prior to A3 |
| "`backup-pack.test.ts` staging-dir cleanup failure" | All 29 backup-pack tests PASS in isolation (`vitest run backup-pack`); A3 confirmed. REAL failure is `pipeline.integration.test.ts` (see P0-4) | A3 verified in v2026.4.152 |

---

## DUPLICATES — items consolidated

| Winning Task | Cancelled/Superseded | Reason |
|-------------|---------------------|--------|
| T1435 (W1 dispatch wave) | T1474–T1479 (T-TW-6 through T-TW-11) | Cancelled with `cancellationReason: "Duplicate of T1435 Wave C scope"` |
| T1048 (revised synthesis no-MCP) | T1047 (original synthesis) | T1048 supersedes per owner pushback on MCP overhead framing |
| T1431 (sqlite-warning-suppress fix) | — | Done in v2026.4.142; sqlite-warning-suppress failure referenced in T1429 scope |

---

## Dependency graph (text)

```
P0-2 (BRAIN sweep decision) → P0-1 (sweep --rollback 1-LOC fix must exist first if re-run)
P0-3 (audit 246 override entries) → [no hard dependency, but MUST be done before new batch work]
P0-5 (override cap) → P0-6 (shared-evidence flag) → [together close the governance gap]
P0-4 (pipeline.integration.test.ts fix) → P1-2 (T1429 brain-stdp deflake) → [clean test suite, 0 overrides]
P0-7 (re-parent 51 orphaned tasks) → [unlocks cleo list --parent for all affected epics]
P0-NEW (shell-task triage — 25 stubs) → [owner reviews T030/T031/T106/T105 first; agent batch-updates rest]
P1-1 (T1492 thin handlers) → P2-1 (nexus CLI LOC — T1492 covers nexus.ts too)
P1-3 (T1403 post-deploy CI, MUST IMPLEMENT not just file) → P1-4 (T1404 parent-closure atom, MUST IMPLEMENT) → [meta-failure pumps]
P1-8 (reconcile-scheduler) → T1139 (BRAIN auto-reconcile) → P3-4 (T1056 Living Brain)
P1-NEW-1 (A2 stalled epics) → P1-NEW-3 (decomposition decisions per epic) → [clears 8 stalled epics from backlog]
P1-NEW-2 (T1106 owner decision) → P0-7 (re-parent or cancel CLOSE-ALL orphans) → T1139 (BRAIN auto-reconcile)
P1-NEW-3 (stalled-epic decomposition) → [T939/T940/T941 cancel requires CLEO_OWNER_OVERRIDE; T942 requires RCASD session]
P2-NEW-1 (stale SSoT-EXEMPT cleanup) → [may reveal untracked nexus dispatch ops — file Phase 2 epic if so]
P2-NEW-5 (regression task filing) → P1-2 (T1429 scope extended to cover sqlite-warning-suppress)
P2-NEW-7 (stalled RCASD workspaces) → P1-NEW-3 (advance or stall depends on same owner decisions)
T942 (Sentient Redesign) → requires RCASD council session first
T990 (Studio Design) → requires owner design direction first
T1042 (Nexus far-exceed) → T1056 (Living Brain) → depends on nexus parity first
T1054/T1055/T1056 (Nexus P0/P1/P2) → P0-7 (must re-parent T1057-T1073 first for epics to show children)
```

---

## Recommended execution order for next session

1. **Audit the 246 force-bypass entries** (P0-3): A4 found 246 entries in 4 days across 36 unique tasks (up from A3's 106 in 3 days). Audit the 2026-04-27 session's 20 specifically — verify each "pre-existing" claim vs `git blame` + test output. Investigate "emergency hotfix incident 9999" entry (no task ID). File regression tasks for any failure introduced by the campaign. Inform owner of the 4-day escalation. This MUST happen before new code work. (~45 min)

2. **File and implement P0-5 + P0-6** (override cap + shared-evidence flag): With 246 entries in 4 days (665 total) and no enforcement gate, these pumps are genuinely P0. File tasks, implement the session cap and shared-evidence flag. Without these, the escalation will continue. (~4 hours total)

3. **Re-parent 51 orphaned tasks** (P0-7): Script `cleo task update` calls to wire T1057–T1073 → T1054/T1055/T1056, T897–T909 → T1232/T942, T923/T925/T1009–T1012/T1029–T1032 → T911/T942. Verify T1104/T1105 staleness before re-parenting (may need cancellation). Owner must first decide T1106 fate (P1-NEW-2) before CLOSE-ALL orphans are re-parented. (~1 hour after owner decision on T1106)

4. **Owner decision on BRAIN sweep** (P0-2): All 4 `brain_backfill_runs` rows have `status=rolled-back` — no active staged sweep. Owner decides: "re-run when P0-1 is fixed" or "permanently abandon." Document in BRAIN. (~5 min)

5. **Wire `cleo memory sweep --rollback` dispatch** (P0-1): 1 LOC fix — add `'sweep'` to the `mutate[]` array in `getOperationConfig()` in `packages/cleo/src/dispatch/domains/memory.ts` (~line 1994). File task first, implement with evidence gates. (~30 min)

6. **Fix `pipeline.integration.test.ts`** (P0-4): 7 failing `passGate` tests. Defensive guard in `passGate` for undefined `gateName`, or test file fix. This is the root of most `testsPassed` overrides. (~45 min)

7. **T1492: Thin remaining fat handlers** (P1-1): `memory.ts`, `sticky.ts`, `orchestrate.ts`, `release.ts`, `pipeline.ts`, `nexus.ts` handlers >5 LOC. NO override allowed — all tests must pass. (~2 hours)

8. **T1429: brain-stdp deflake** (P1-2): Apply skip pattern to 3 remaining flaky tests. Cleans test suite toward 0 forced overrides. (~30 min)

9. **T1403 + T1404: Implement (not just file) process pumps** (P1-3, P1-4): Both are `status:pending, pipelineStage:research, zero children`. Actual implementation needed, not task filing. (~3 hours each)

10. **T1462 + T1463: Worktree leak + getProjectRoot trap** (P1-6, P1-7): Small bug fixes that improve operational safety. (~1 hour each)

11. **T1405: CleoOS doctor + claude-sdk smoke** (P1-5): Restore CleoOS harness functionality. (~1 hour)

12. **Stale SSoT-EXEMPT cleanup** (P2-NEW-1): Audit 14 `pending T1488 Phase 2` + 6 `T1451 incomplete` annotations. Remove or update to reference correct tasks. (~30 min)

13. **Stale deprecation cleanup** (P2-NEW-2): Remove 4 T310 shims from `signaldock-sqlite.ts` and verify 5 ADR-027 flat-file functions in `memory/index.ts` can be removed. (~30 min)

14. **Owner scoping of T1151 subtasks + T942 RCASD session** (P2-2, P3-4): T1152–T1159 in DB are unrelated T-MSR tasks — the 4-pillar subtasks were never filed. Owner must decide: file under T942 or explicitly defer. Document in BRAIN.

15. **Owner: 25 shell-task triage** (P0-NEW, A2): Owner reviews T030/T031/T106/T105 (4 largest planning docs) and decides accept-with-criteria or cancel-with-rationale for each. Then an agent runs the batch `cleo update` commands for the remaining 21 shells. This unblocks ~76 total task-record integrity gaps (51 orphans + 25 shells). (~30 min owner time + ~1 hour agent time)

16. **Stalled-epic decomposition decisions** (P1-NEW-3, A2): Owner works through the 8-epic decision table. Cancel T889, T631, T939/T940/T941 immediately. Scope decompositions for T942/T946/T990/T1042. File implementation go/no-go for T1232. (~1 hour owner time across epics)

17. **RCASD workspace advancement or stall** (P2-NEW-7, A2): For each of the 5 stalled RCASD workspaces (T1232, T1106, T889, T942, T919), either file children and start implementation, or add a rationale note in the RCASD research file. (~30 min after P1-NEW-3 decisions)

---

## File-as-new-CLEO-task list

```bash
# P0-1: memory sweep rollback (1 LOC fix — NOT ~20 LOC)
cleo add "Fix: add 'sweep' to mutate[] routing in memory dispatch — getOperationConfig() in memory.ts ~line 1994 (1 LOC)" \
  --parent T1147 --size small --priority critical \
  --acceptance "cleo memory sweep --rollback <runId> exits 0 and no longer returns E_INVALID_OPERATION: Unknown operation: mutate:memory.sweep|pnpm run test green|biome clean"

# P0-3: audit overrides (246 entries in 4 days, including 20 this session)
cleo add "Audit force-bypass escalation: 246 entries 2026-04-24 to 2026-04-28 across 36 tasks — verify pre-existing failure claims, investigate incident 9999, inform owner" \
  --size small --priority critical \
  --acceptance "2026-04-27 session's 20 overrides each verified against git blame|regression tasks filed for any failure introduced by campaign|emergency hotfix incident 9999 investigated and task filed or documented|BRAIN observation written with 4-day escalation stats (246 entries, 665 total)"

# P0-4: pipeline.integration.test.ts — 7 failing tests (NOT backup-pack)
cleo add "Fix pipeline.integration.test.ts — 7 failing passGate tests crash on undefined gateName" \
  --size small --priority high \
  --acceptance "passGate gracefully handles undefined gateName (returns error, does not crash) OR test caller always passes named gate|all 7 tests in pipeline.integration.test.ts pass|net reduction of 7 pre-existing failures"

# P0-5: override cap pump (PROMOTED FROM P3, updated A4 stats)
cleo add "Pump: cap CLEO_OWNER_OVERRIDE invocations per session — require ADR-style waiver doc above N (246 entries in 4 days, 665 total, escalating)" \
  --size medium --priority critical \
  --acceptance "cleo verify rejects override at N+1 per session without waiver file path argument|waiver format documented in ADR|force-bypass.jsonl includes per-session count|cleo session status surfaces override count"

# P0-6: shared-evidence flag (PROMOTED FROM P3)
cleo add "Pump: require --shared-evidence flag when same evidence atom closes >3 child tasks (enables 36-task bypass pattern, 246 entries in 4 days)" \
  --size medium --priority critical \
  --acceptance "cleo verify warns when single atom covers >3 tasks without --shared-evidence flag|flag explanation logged to force-bypass.jsonl with sharedAtomWarning:true|flag documented"

# P0-7: re-parent 51 orphaned tasks
cleo add "Fix: re-parent 51 orphaned tasks to correct epics — T1057-T1073→T1054/T1055/T1056, T897-T909→T1232/T942, T923/T925/T1009-T1012/T1029-T1032→T911/T942; verify staleness of T1104/T1105 (v2026.4.102 era)" \
  --size medium --priority high \
  --acceptance "cleo list --parent T1054 returns EP1 tasks T1057-T1061|cleo list --parent T1055 returns EP2 tasks T1062-T1065|cleo list --parent T1056 returns EP3 tasks T1066-T1073|T897-T909 parented to T1232 or T942|T1104/T1105 either re-parented or cancelled as stale|orphan count for these groups = 0"

# P1-8: reconcile-scheduler
cleo add "Implement reconcile-scheduler.ts — periodic BRAIN reconciler per PLAN.md §7.3" \
  --parent T1139 --size medium --priority medium \
  --acceptance "packages/core/src/sentient/reconcile-scheduler.ts exists|configurable interval|tests cover schedule+cancel|biome+tsc green"

# P2-3: observation_embeddings IMPLEMENT (not verify — confirmed absent by A3)
cleo add "Implement observation_embeddings and turn_embeddings tables per PORT-AND-RENAME §2 (confirmed absent — grep returns zero results)" \
  --size small --priority low \
  --acceptance "observation_embeddings and turn_embeddings table DDL exists in memory-schema.ts|migration applied|biome+tsc green"

# P2-NEW-1: stale SSoT-EXEMPT cleanup (A4)
cleo add "Clean up 20 stale SSoT-EXEMPT annotations: 14x pending T1488 Phase 2 in nexus.ts + 6x T1451 incomplete in token-service.ts — both tasks done" \
  --size small --priority medium \
  --acceptance "zero SSoT-EXEMPT annotations referencing T1488 or T1451 remain|if Phase 2 nexus dispatch ops were descoped, new epic filed with correct ID|biome+build green"

# P2-NEW-2: stale deprecation cleanup (A4)
cleo add "Remove stale deprecated shims: 4x T310-era in signaldock-sqlite.ts + 5x ADR-027 flat-file in memory/index.ts — both migrations done" \
  --size small --priority medium \
  --acceptance "4 deprecated T310 shims removed from signaldock-sqlite.ts|5 deprecated ADR-027 flat-file functions removed from memory/index.ts (or callers confirmed missing)|pnpm run test green|biome+tsc green"

# P2-NEW-3: T1082 followup tasks (A4)
cleo add "File T1082 follow-up tasks: embedding cosine similarity dedup in session-narrative.ts + confidence threshold tuning + telemetry gaps when LLM backend unavailable" \
  --size small --priority low \
  --acceptance "all 6 TODO(T1082.followup) markers replaced with real task IDs or explicitly removed|new tasks filed with acceptance criteria for (a) cosine dedup (b) confidence tuning (c) telemetry"

# P2-NEW-4: T1XXX placeholder (A4)
cleo add "Replace T1XXX placeholder in nexus/route-analysis.ts:162 — file AST-based shape inference epic and update comment" \
  --size small --priority low \
  --acceptance "T1XXX placeholder replaced with real task ID in route-analysis.ts:162|new epic filed describing AST-based shape inference scope"

# P2-NEW-5 regression tasks (A4) — file as 3 separate tasks:
cleo add "Fix sqlite-warning-suppress.test.ts worktree-context flakiness — add skipIf guard for non-worktree environments" \
  --size small --priority medium \
  --acceptance "sqlite-warning-suppress tests pass in both worktree and clean-checkout environments OR skipIf guard prevents failure in incompatible contexts|pnpm run test green"

cleo add "Fix backup-pack.test.ts ENOTEMPTY race — isolate staging dir per-test via unique mkdtemp prefix" \
  --size small --priority medium \
  --acceptance "backup-pack.test.ts passes 100% in parallel runs with other tests|ENOTEMPTY error does not appear in test output|pnpm run test green"

cleo add "Resolve T1093-followup skipped tests: re-enable or permanently close brain-stdp-wave3:T695-1 + task-sweeper-wired:runGitLogTaskLinker" \
  --size small --priority low \
  --acceptance "T695-1 either re-enabled and passing or marked it.skip with documented justification|runGitLogTaskLinker test either re-enabled or marked it.skip with documented justification|no TODO(T1093-followup) markers remain without task linkage"

# P2-NEW-6: T659 orphan files (A4)
cleo add "Delete T659 orphan test files: caamp/tests/unit/coverage-final-push.test.ts + core-coverage-gaps.test.ts — T659 archived, files should have been removed" \
  --size small --priority low \
  --acceptance "both files deleted|pnpm run test green|no TODO(T659) markers remain"

# P0-NEW: shell-task reconciliation — rename/describe 25 empty stub tasks or cancel them (A2)
# Run after owner triage of T030/T031/T106/T105 (4 largest — see P0-NEW cleo update commands above)
# Sample for smaller shells after owner triage:
cleo update T032 --title "Nexus Validation Analysis: output and recommendations" --description "Complete nexus validation output. See .cleo/agent-outputs/T032-nexus-validation.md (7KB)."
cleo update T034 --title "Agent Dimension Analysis" --description "Agent dimension analysis. See .cleo/agent-outputs/T034-agent-dimension.md (4KB)."
cleo update T035 --title "Intelligence Dimension Analysis" --description "Intelligence dimension analysis. See .cleo/agent-outputs/T035-intelligence-dimension.md (5KB)."
cleo update T036 --title "ERD Diagram Plan for CLEO schema" --description "ERD diagram plan. See .cleo/agent-outputs/T036-erd-diagrams.md (4KB)."
cleo update T037 --title "Schema Documentation Plan" --description "Schema documentation plan. See .cleo/agent-outputs/T037-schema-docs.md (4KB)."
cleo update T039 --title "Health Monitoring Plan for CLEO services" --description "Health monitoring plan. See .cleo/agent-outputs/T039-health-monitoring.md (4KB)."
cleo update T040 --title "Retry Logic Design for CLEO operations" --description "Retry logic design. See .cleo/agent-outputs/T040-retry-logic.md (2KB)."
cleo update T041 --title "Agent Registry Plan" --description "Agent registry plan. See .cleo/agent-outputs/T041-agent-registry.md (3KB)."
cleo update T043 --title "Impact Prediction Plan for Nexus" --description "Impact prediction plan. See .cleo/agent-outputs/T043-impact-prediction.md (3KB)."
cleo update T044 --title "Reasoning CLI Plan" --description "Reasoning CLI plan. See .cleo/agent-outputs/T044-reasoning-cli.md (3KB)."
cleo update T045 --title "Nexus Assessment: TODO and follow-up items" --description "8KB nexus assessment with TODO/follow-up items. See .cleo/agent-outputs/T045-nexus-assessment.md."
cleo update T060 --title "Pipeline Binding Plan" --description "Pipeline binding plan. See .cleo/agent-outputs/T060-pipeline-binding.md (3KB)."
cleo update T061 --title "Verification Init Plan" --description "Verification init plan. See .cleo/agent-outputs/T061-verification-init.md (3KB)."
cleo update T062 --title "Epic Enforcement Plan: lifecycle gate hardening" --description "5KB epic enforcement plan. See .cleo/agent-outputs/T062-epic-enforcement.md."
cleo update T063 --title "Skills Update Plan" --description "Skills update plan. See .cleo/agent-outputs/T063-skills-update.md (5KB)."
cleo update T064 --title "Validator Skill Plan" --description "Validator skill plan. See .cleo/agent-outputs/T064-validator-skill.md (3KB)."
cleo update T065 --title "Telemetry Plan" --description "Telemetry plan. See .cleo/agent-outputs/T065-telemetry.md (4KB)."
cleo update T066 --title "Backfill Plan" --description "Backfill plan. See .cleo/agent-outputs/T066-backfill.md (3KB)."
cleo update T067 --title "Strictness Presets Plan" --description "Strictness presets plan. See .cleo/agent-outputs/T067-strictness-presets.md (4KB)."
cleo update T068 --title "Documentation Plan" --description "Documentation plan. See .cleo/agent-outputs/T068-documentation.md (2KB)."
# T029 (parent stub — update after children are decided):
cleo update T029 --title "Task Stub Cluster Parent: schema audit + enforcement planning (2026-03-21 session)" --description "Parent stub for T030-T037 schema audit cluster. Planning docs exist for all children. See individual child docs in .cleo/agent-outputs/."

# P1-NEW-3: stalled epic cancel commands (owner must run these — see P1-NEW-3 table)
# T889 (duplicate + stalled):
# cleo task cancel T889 --reason "Superseded by T910 Orchestration Coherence v4 (done 2026-04-24)"
# T631 (low priority, no children):
# cleo task cancel T631 --reason "No children filed after ~12 days; low priority; superseded by cleo-prime persona in BRAIN"
# T939/T940/T941 (test artifacts — REQUIRES owner override):
# CLEO_OWNER_OVERRIDE=1 CLEO_OWNER_OVERRIDE_REASON="test-artifact epic cleanup — T877 blocks normal cancel" cleo task cancel T939 --reason "Test artifact for T929 lifecycle bug — never intended as real work"
# CLEO_OWNER_OVERRIDE=1 CLEO_OWNER_OVERRIDE_REASON="test-artifact epic cleanup — T877 blocks normal cancel" cleo task cancel T940 --reason "Test artifact for T929 lifecycle bug"
# CLEO_OWNER_OVERRIDE=1 CLEO_OWNER_OVERRIDE_REASON="test-artifact epic cleanup — T877 blocks normal cancel" cleo task cancel T941 --reason "Test artifact for T929 lifecycle bug"

# P2-NEW-7: stalled RCASD workspaces audit task
cleo add "Audit ~5 stalled RCASD workspaces with content for non-archived tasks: T1232, T1106, T889, T942, T919 — advance (file children) or mark stalled with rationale note in RCASD research file" \
  --size small --priority medium \
  --acceptance "each of the 5 RCASD workspaces has either ≥1 child task filed and implementation started OR a rationale note added to the RCASD research file explaining abandonment|no RCASD workspace with substantive content points at a pending task with zero implementation evidence"
```

### Tasks already in DB (no new add needed)

- T1403 — Post-deploy CI execution gap (filed, needs IMPLEMENTATION not just filing)
- T1404 — Parent-closure-without-atom enforcement (filed, needs IMPLEMENTATION not just filing)
- T1429 — brain-stdp deflake (filed, pending — covers brain-stdp-functional + performance-safety)
- T1492 — Thin remaining fat dispatch handlers (filed, pending)
- T1462 — Worktree leak auto-cleanup (filed, pending)
- T1463 — getProjectRoot trap (filed, pending)
- T1405 — CleoOS doctor + claude-sdk smoke (filed, pending)
- T1113 — nexus exports map (filed, pending)
- T1114 — nexus verb alias (filed, pending)
- T1139 — BRAIN auto-reconcile (filed, pending — P1-8 reconcile-scheduler files as child)

### Owner decisions needed before filing / acting

- T1106 fate (P1-NEW-2): Close as superseded OR rebuild as v2026.4.152 audit — decision gates P0-7 re-parenting of CLOSE-ALL orphans
- T1466 / T1136 / T889 duplicate epics (P1-NEW-1 A1 section): Cancel or explicitly scope
- T1151 4-pillar subtasks (P2-2): File under T942 or defer
- **P0-NEW shell-task triage (A2)**: Owner review of T030/T031/T106/T105 (4 largest planning docs) — accept with concrete acceptance criteria OR cancel with rationale. Then agent can batch-update remaining 21 shells.
- **P1-NEW-3 stalled epics (A2)**: Owner decision on T889/T942/T946/T990/T1042/T1232/T631/T939/T940/T941 — decompose (file children) or cancel each.
- **P2-NEW-7 RCASD workspaces (A2)**: Owner review of T1232/T1106/T942 RCASD stages — advance to implementation or mark stalled.

### No longer needed (resolved — do NOT file)

- ~~conduit-schema.ts extraction~~ — done in commit `7300e3eed`
- ~~tasks-sqlite.ts rename~~ — done in commit `926f002c7`
