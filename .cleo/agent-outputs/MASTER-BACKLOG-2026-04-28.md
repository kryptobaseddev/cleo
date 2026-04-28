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
| force-bypass.jsonl entries (2026-04-25 to 2026-04-28, 3-day audit window) | **106** (36 unique tasks) | A3 inventory reconciliation |
| Pre-existing test failures | 5 (brain-stdp×3, sqlite-warning-suppress×2) | `pnpm run test` (verified in v2026.4.152 release) |
| Test suite passing count | 11507 | CHANGELOG.md v2026.4.152 |

**Note on force-bypass entries**: 20 uses on 2026-04-27 (this session). The majority are `testsPassed` overrides citing "pre-existing failures unrelated to campaign scope" (notably T1473 nexus decomposition, which used a workaround citing 5 pre-existing failures). Two are in T948 (SDK public surface). None filed a regression task first. See P0 item #3.

**A3 audit (2026-04-25 to 2026-04-28)**: 106 total force-bypass entries across 3 days, 36 unique tasks bypassed. Top patterns: epic lifecycle advancement (18+ entries), subagents advancing parent epic lifecycle (6+ entries), worktree pre-existing test failure workarounds (many). This session's 20 entries represent only ~19% of the 3-day window. The pattern is escalating, not isolated. Total `force-bypass.jsonl` size: 665 entries with no enforcement gate. See P0-NEW and promoted P0-5/P0-6.

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

### P0-3: 106 force-bypass entries in 3 days — escalating override pump (this session + prior)
- **Task**: No task filed — needs filing per ADR-051 policy
- **Why blocker**: The prior handoff (v2026.4.141) documented the meta-failure: "NO owner-overrides without (a) a regression task filed first." This session used 20 overrides on 2026-04-27. The broader A3 audit window (2026-04-25 to 2026-04-28) reveals 106 entries across 36 unique tasks — the pattern is escalating, not isolated to this session. Top offending patterns: epic lifecycle advancement (18+ entries), subagents advancing parent epic lifecycle to unblock worktrees (6+ entries). The orchestrator's 20 entries from this session are ~19% of the 3-day total — meaning 86 more came from prior sessions in the same window.
- **Specific violations this session**: T1473 `testsPassed` override citing "pre-existing failures in brain-stdp, pipeline integration, sentient daemon, session-find, e2e-safety"; T948 `testsPassed` override. The claim that "pipeline integration, sentient daemon, session-find" failures are pre-existing (not introduced by nexus decomposition) was NOT independently verified.
- **Acceptance**: (1) Audit 2026-04-27 session's 20 overrides — verify each "pre-existing" claim against `git blame` + test output; file regression tasks for any introduced by the campaign. (2) Owner informed of 106-entry, 3-day escalation.
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
- **Promotion rationale**: A3 audit found 106 force-bypass entries in 3 days across 36 unique tasks. The handoff warned about 15 batch overrides; the pattern repeated within 72 hours. This is not a process hygiene concern — it is an active governance failure. P3 severity was wrong; this is P0.
- **Why blocker**: Zero limits on owner-override invocations per session. A cap with ADR-style waiver requirement would enforce the policy programmatically and make the escalation self-limiting. Without it, the 106-entry / 3-day rate will continue.
- **Effort**: medium
- **Owner required**: No (design is clear from A3 recommendations)
- **File command**: `cleo add "Pump: cap CLEO_OWNER_OVERRIDE invocations per session to N — require waiver doc above N" --size medium --priority critical`

### P0-6: `--shared-evidence` flag for batch closes — promoted from P3 (was P3-2)
- **Task**: No task filed (proposed in v2026.4.141 handoff as "T-PUMP-BATCH-EVIDENCE")
- **Promotion rationale**: Promoted alongside P0-5. A single shared `tool:pnpm-test` atom across N>3 child tasks enables the batch-override pattern that produced the 106-entry escalation. Without requiring explicit `--shared-evidence`, agents can silently batch-close many tasks on a single unverified test run.
- **Why blocker**: Enables silent mass-override. The 36-task bypass pattern in 3 days is only possible because batch evidence sharing is unchecked.
- **Effort**: medium
- **Owner required**: No
- **File command**: `cleo add "Pump: require --shared-evidence flag when same evidence atom closes >3 tasks" --size medium --priority critical`

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
P0-3 (audit 106 override entries) → [no hard dependency, but MUST be done before new batch work]
P0-5 (override cap) → P0-6 (shared-evidence flag) → [together close the governance gap]
P0-4 (pipeline.integration.test.ts fix) → P1-2 (T1429 brain-stdp deflake) → [clean test suite, 0 overrides]
P1-1 (T1492 thin handlers) → P2-1 (nexus CLI LOC — T1492 covers nexus.ts too)
P1-3 (T1403 post-deploy CI, MUST IMPLEMENT not just file) → P1-4 (T1404 parent-closure atom, MUST IMPLEMENT) → [meta-failure pumps]
P1-8 (reconcile-scheduler) → T1139 (BRAIN auto-reconcile) → P3-4 (T1056 Living Brain)
T942 (Sentient Redesign) → requires RCASD council session first
T990 (Studio Design) → requires owner design direction first
T1042 (Nexus far-exceed) → T1056 (Living Brain) → depends on nexus parity first
```

---

## Recommended execution order for next session

1. **Audit the 106 force-bypass entries** (P0-3): A3 found 106 entries in 3 days across 36 unique tasks. Audit the 2026-04-27 session's 20 specifically — verify each "pre-existing" claim vs `git blame` + test output. File regression tasks for any failure introduced by the campaign. Inform owner of the 3-day escalation. This MUST happen before new code work. (~45 min)

2. **File and implement P0-5 + P0-6** (override cap + shared-evidence flag): With 106 entries in 3 days and no enforcement gate, these pumps are genuinely P0. File tasks, implement the session cap and shared-evidence flag. Without these, the escalation will continue. (~4 hours total)

3. **Owner decision on BRAIN sweep** (P0-2): All 4 runs are already `rolled-back` — no active staged sweep. Owner decides: "re-run when P0-1 is fixed" or "permanently abandon." Document in BRAIN. (~5 min)

4. **Wire `cleo memory sweep --rollback` dispatch** (P0-1): 1 LOC fix — add `'sweep'` to the `mutate[]` array in `getOperationConfig()` in `packages/cleo/src/dispatch/domains/memory.ts` (~line 1994). File task first, implement with evidence gates. (~30 min)

5. **Fix `pipeline.integration.test.ts`** (P0-4): 7 failing `passGate` tests. Defensive guard in `passGate` for undefined `gateName`, or test file fix. This is the root of most `testsPassed` overrides. (~45 min)

6. **T1492: Thin remaining fat handlers** (P1-1): `memory.ts`, `sticky.ts`, `orchestrate.ts`, `release.ts`, `pipeline.ts`, `nexus.ts` handlers >5 LOC. NO override allowed — all tests must pass. (~2 hours)

7. **T1429: brain-stdp deflake** (P1-2): Apply skip pattern to 3 remaining flaky tests. Cleans test suite toward 0 forced overrides. (~30 min)

8. **T1403 + T1404: Implement (not just file) process pumps** (P1-3, P1-4): Both are `status:pending, pipelineStage:research, zero children`. Actual implementation needed, not task filing. (~3 hours each)

9. **T1462 + T1463: Worktree leak + getProjectRoot trap** (P1-6, P1-7): Small bug fixes that improve operational safety. (~1 hour each)

10. **T1405: CleoOS doctor + claude-sdk smoke** (P1-5): Restore CleoOS harness functionality. (~1 hour)

11. **Owner scoping of T1151 subtasks + T942 RCASD session** (P2-2, P3-4): T1152–T1159 in DB are unrelated T-MSR tasks — the 4-pillar subtasks were never filed. Owner must decide: file under T942 or explicitly defer. Document in BRAIN.

---

## File-as-new-CLEO-task list

```bash
# P0-1: memory sweep rollback (1 LOC fix — NOT ~20 LOC)
cleo add "Fix: add 'sweep' to mutate[] routing in memory dispatch — getOperationConfig() in memory.ts ~line 1994 (1 LOC)" \
  --parent T1147 --size small --priority critical \
  --acceptance "cleo memory sweep --rollback <runId> exits 0 and no longer returns E_INVALID_OPERATION: Unknown operation: mutate:memory.sweep|pnpm run test green|biome clean"

# P0-3: audit overrides (106 entries in 3 days, not just 20)
cleo add "Audit force-bypass escalation: 106 entries 2026-04-25 to 2026-04-28 across 36 tasks — verify pre-existing failure claims and inform owner" \
  --size small --priority critical \
  --acceptance "2026-04-27 session's 20 overrides each verified against git blame|regression tasks filed for any failure introduced by campaign|BRAIN observation written with 3-day escalation stats"

# P0-4: pipeline.integration.test.ts — 7 failing tests (NOT backup-pack)
cleo add "Fix pipeline.integration.test.ts — 7 failing passGate tests crash on undefined gateName" \
  --size small --priority high \
  --acceptance "passGate gracefully handles undefined gateName (returns error, does not crash) OR test caller always passes named gate|all 7 tests in pipeline.integration.test.ts pass|net reduction of 7 pre-existing failures"

# P0-5: override cap pump (PROMOTED FROM P3)
cleo add "Pump: cap CLEO_OWNER_OVERRIDE invocations per session — require ADR-style waiver doc above N (106 entries in 3 days, escalating)" \
  --size medium --priority critical \
  --acceptance "cleo verify rejects override at N+1 per session without waiver file path argument|waiver format documented in ADR|force-bypass.jsonl includes per-session count|cleo session status surfaces override count"

# P0-6: shared-evidence flag (PROMOTED FROM P3)
cleo add "Pump: require --shared-evidence flag when same evidence atom closes >3 child tasks (enables 36-task bypass pattern)" \
  --size medium --priority critical \
  --acceptance "cleo verify warns when single atom covers >3 tasks without --shared-evidence flag|flag explanation logged to force-bypass.jsonl with sharedAtomWarning:true|flag documented"

# P1-8: reconcile-scheduler
cleo add "Implement reconcile-scheduler.ts — periodic BRAIN reconciler per PLAN.md §7.3" \
  --parent T1139 --size medium --priority medium \
  --acceptance "packages/core/src/sentient/reconcile-scheduler.ts exists|configurable interval|tests cover schedule+cancel|biome+tsc green"

# P2-3: observation_embeddings IMPLEMENT (not verify — confirmed absent by A3)
cleo add "Implement observation_embeddings and turn_embeddings tables per PORT-AND-RENAME §2 (confirmed absent — grep returns zero results)" \
  --size small --priority low \
  --acceptance "observation_embeddings and turn_embeddings table DDL exists in memory-schema.ts|migration applied|biome+tsc green"
```

### Tasks already in DB (no new add needed)

- T1403 — Post-deploy CI execution gap (filed, needs IMPLEMENTATION not just filing)
- T1404 — Parent-closure-without-atom enforcement (filed, needs IMPLEMENTATION not just filing)
- T1429 — brain-stdp deflake (filed, pending)
- T1492 — Thin remaining fat dispatch handlers (filed, pending)
- T1462 — Worktree leak auto-cleanup (filed, pending)
- T1463 — getProjectRoot trap (filed, pending)
- T1405 — CleoOS doctor + claude-sdk smoke (filed, pending)
- T1113 — nexus exports map (filed, pending)
- T1114 — nexus verb alias (filed, pending)

### No longer needed (resolved — do NOT file)

- ~~conduit-schema.ts extraction~~ — done in commit `7300e3eed`
- ~~tasks-sqlite.ts rename~~ — done in commit `926f002c7`
