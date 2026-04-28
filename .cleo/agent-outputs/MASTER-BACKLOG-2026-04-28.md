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
| Pre-existing test failures | 5 (brain-stdp×3, sqlite-warning-suppress×2) | `pnpm run test` (verified in v2026.4.152 release) |
| Test suite passing count | 11507 | CHANGELOG.md v2026.4.152 |

**Note on force-bypass entries**: 20 uses in 2026-04-27. The majority are `testsPassed` overrides citing "pre-existing failures unrelated to campaign scope" (notably T1473 nexus decomposition, which used a workaround citing 5 pre-existing failures). Two are in T948 (SDK public surface). None filed a regression task first. See P0 item #3.

---

## P0 — Active blockers (ship-stoppers)

### P0-1: `cleo memory sweep --rollback <runId>` dispatch gap (carried from v2026.4.141)
- **Task**: No task filed yet — needs filing
- **Why blocker**: `mutate:memory.sweep` with rollback verb returns `E_INVALID_OPERATION`. Operators are stuck with direct-SQL workarounds when they need to undo a sweep. The 68-candidate BRAIN sweep awaiting owner decision cannot be safely actioned until the rollback path is confirmed safe.
- **Fix**: ~20 LOC in `packages/cleo/src/dispatch/domains/memory.ts` — wire `rollback` variant into gateway.
- **Acceptance**: `cleo memory sweep --rollback <runId>` exits 0 and reverts sweep; `pnpm run test` green; biome clean.
- **Effort**: small
- **Owner required**: No (implementation straightforward)
- **File command**: `cleo add "Wire cleo memory sweep --rollback dispatch gateway" --parent T1147 --size small --priority critical`

### P0-2: 68-candidate BRAIN sweep awaiting owner decision
- **Task**: No task ID — owner decision required before action
- **Why blocker**: 2 `brain_backfill_runs` rows with `kind=noise-sweep-2440`, `status=rolled-back`. 50 of 68 candidates are decisions. Re-running the sweep would irreversibly purge observations. Owner must choose: re-run+approve or permanently abandon.
- **Acceptance**: Owner decision documented in BRAIN (`cleo memory observe ...`) before agent action.
- **Effort**: owner decision only (then small if re-run)
- **Owner required**: YES — irreversible data operation

### P0-3: 20 force-bypass uses without regression tasks (this session)
- **Task**: No task filed — needs filing per ADR-051 policy
- **Why blocker**: The prior handoff (v2026.4.141) documented the meta-failure: "NO owner-overrides without (a) a regression task filed first." This session used 20 overrides on 2026-04-27 without filing regression tasks. Specific violations: T1473 `testsPassed` override citing "pre-existing failures in brain-stdp, pipeline integration, sentient daemon, session-find, e2e-safety"; T948 `testsPassed` override. The 5 pre-existing failures are known (T1429 brain-stdp, T1431 sqlite-warning-suppress) but the override chain for T1473 also references "pipeline integration, sentient daemon, session-find" failures that may have been newly introduced during nexus decomposition.
- **Acceptance**: Verify each override's claimed "pre-existing" failures are actually pre-existing vs introduced by the campaign; file regression tasks for any found.
- **Effort**: small-medium investigation
- **Owner required**: Owner should be informed (policy violation per prior session's explicit commitment)

### P0-4: `backup-pack.test.ts` staging-dir cleanup failure (surfaced v2026.4.141)
- **Task**: T1429 is brain-stdp (different). No backup-pack task found — needs filing.
- **Why blocker**: Known test failure never filed as a task. Leaves test suite perpetually "5 pre-existing failures" framing which masks real regressions.
- **Acceptance**: `backup-pack.test.ts` passes end-to-end or is explicitly marked as skipped with ADR-style rationale.
- **Effort**: small
- **Owner required**: No
- **File command**: `cleo add "Fix backup-pack.test.ts staging-dir cleanup failure" --size small --priority high`

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

### P1-3: T1403 — Post-deploy execution gap in CI (Pump #1)
- **Task**: T1403 (`status:pending`)
- **Why**: CI ships code but no stage runs post-deploy migrations/sweeps/registry-publishes. Filed during v2026.4.141 session as a process pump to prevent meta-failure recurrence.
- **Acceptance**: CI pipeline has an `execute-payload` stage; release workflow runs declared post-deploy steps; evidence atoms required.
- **Effort**: medium
- **Owner required**: No

### P1-4: T1404 — Parent-closure-without-atom enforcement (Pump #2)
- **Task**: T1404 (`status:pending`)
- **Why**: `cleo complete <epicId>` for epics doesn't require evidence atoms or merkle inheritance from children. Filed during v2026.4.141 session.
- **Acceptance**: `cleo complete <epicId>` rejects if no direct evidence AND no verified children; `E_EVIDENCE_MISSING` raised with clear message.
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

### P2-2: T1151 subtasks (T1152–T1159) never filed — 4-pillar self-healing vision
- **Task**: No child tasks filed under T1151
- **Why**: T1151 was the parent for: step-level retry (T1152), reflection agent (T1153), session tree (T1154), soft-trim pruning (T1155), context budget (T1156), TUI adapter (T1158), pluggable filesystem/sandbox (T1159). All remain aspirational. Owner decision needed: file as concrete tasks OR explicitly archive as deferred scope.
- **Effort**: owner decision only; filing each is small
- **Owner required**: Owner should scope these before agents file them

### P2-3: `observation_embeddings` / `turn_embeddings` tables — still unconfirmed
- **Task**: No task filed
- **Why**: PORT-AND-RENAME §2 spec items. Column-level deltas are in lazy `ensureColumns` (confirmed); table-level ones unconfirmed. Needs a targeted grep audit.
- **Effort**: tiny (verification only)
- **File command**: `cleo add "Verify or add observation_embeddings/turn_embeddings tables per PORT-AND-RENAME §2" --size small --priority low`

### P2-4: `conduit-schema.ts` extraction — split hybrid file
- **Task**: No task filed (documented in v2026.4.141 handoff)
- **Why**: `conduit-sqlite.ts` is a hybrid file with raw SQL DDL + open/init + CRUD. Other domains (`memory`, `nexus`, `signaldock`) use `<domain>-schema.ts` (Drizzle defs) + `<domain>-sqlite.ts` (open/init). Conduit is the outlier.
- **Effort**: small (refactor only, no behavior change)
- **File command**: `cleo add "Split conduit-sqlite.ts into conduit-schema.ts + conduit-sqlite.ts per domain naming convention" --size small --priority low`

### P2-5: `tasks-sqlite.ts` naming inconsistency
- **Task**: No task filed
- **Why**: `tasks-schema.ts` ships Drizzle defs but open/init lives in `task-store.ts` instead of `tasks-sqlite.ts`. Mild inconsistency vs. memory/nexus/signaldock pattern.
- **Effort**: tiny
- **File command**: `cleo add "Rename task-store.ts init to tasks-sqlite.ts for naming consistency" --size small --priority low`

### P2-6: biome symlink warning in CI (pre-existing)
- **Task**: No task filed
- **Why**: `pnpm biome ci .` emits 1 warning about a broken symlink. Has been present for multiple releases. Doesn't fail CI but is noise.
- **Effort**: tiny (identify + remove or fix symlink)

---

## P3 — Process pumps + tooling

### P3-1: New pump — `CLEO_OWNER_OVERRIDE` per-session cap
- **Task**: No task filed (proposed in v2026.4.141 handoff as "T-PUMP-OVERRIDE-CAP")
- **Why**: Zero limits on owner-override invocations per session. The v2026.4.141 session committed to zero overrides; this session used 20. A cap with ADR-style waiver requirement would enforce the policy programmatically.
- **Effort**: medium
- **File command**: `cleo add "Pump: cap CLEO_OWNER_OVERRIDE invocations per session to N — require waiver doc above N" --size medium --priority medium`

### P3-2: New pump — `--shared-evidence` flag for batch closes
- **Task**: No task filed (proposed in v2026.4.141 handoff as "T-PUMP-BATCH-EVIDENCE")
- **Why**: A single shared `tool:pnpm-test` atom across N>3 child tasks should require explicit `--shared-evidence` flag + explanation. Currently permits silent batch-share.
- **Effort**: medium
- **File command**: `cleo add "Pump: require --shared-evidence flag when same evidence atom covers >3 tasks" --size medium --priority low`

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

| Prior Handoff Item | Resolved by | Version |
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
P0-2 (68-candidate sweep) → P0-1 (sweep --rollback gateway must exist first)
P0-3 (audit override legitimacy) → [no hard dependency, but should be done before new batch work]
P1-1 (T1492 thin handlers) → P2-1 (nexus CLI LOC — T1492 covers nexus.ts too)
P1-2 (T1429 brain-stdp deflake) → P0-4 (backup-pack test fix) → [clean test suite]
P1-3 (T1403 post-deploy CI) → P1-4 (T1404 parent-closure atom) → [meta-failure pumps]
P1-8 (reconcile-scheduler) → T1139 (BRAIN auto-reconcile) → P3-6 (T1056 Living Brain)
T942 (Sentient Redesign) → requires RCASD council session first
T990 (Studio Design) → requires owner design direction first
T1042 (Nexus far-exceed) → T1056 (Living Brain) → depends on nexus parity first
```

---

## Recommended execution order for next session

1. **Audit the 20 force-bypass uses** (P0-3): Verify each "pre-existing failure" claim vs `git blame` + test output. File regression tasks for any failure introduced by the campaign. This restores ADR-051 integrity before new work begins. (~30 min)

2. **Owner decision on 68-candidate BRAIN sweep** (P0-2): Present the sweep options to the owner. Document decision in BRAIN. Do not proceed until this is resolved. (owner, ~5 min)

3. **Wire `cleo memory sweep --rollback` dispatch** (P0-1): After decision on P0-2, implement the ~20 LOC fix to enable safe sweep management. File task first, then implement with full evidence gates. (~1 hour)

4. **Fix `backup-pack.test.ts` cleanup failure** (P0-4): File task, implement fix, verify `pnpm run test` shows 4 pre-existing (not 5). (~30 min)

5. **T1492: Thin remaining fat handlers** (P1-1): `memory.ts`, `sticky.ts`, `orchestrate.ts`, `release.ts`, `pipeline.ts`, `nexus.ts` handlers >5 LOC. No override allowed — all tests must pass. (~2 hours)

6. **T1429: brain-stdp deflake** (P1-2): Apply skip pattern to 3 remaining flaky tests. Cleans up test suite to 0 forced overrides. (~30 min)

7. **T1403 + T1404: Process pumps** (P1-3, P1-4): Implement post-deploy CI stage + parent-evidence enforcement. These prevent meta-failure recurrence. (~3 hours each)

8. **T1462 + T1463: Worktree leak + getProjectRoot trap** (P1-6, P1-7): Small bug fixes that improve operational safety. (~1 hour each)

9. **T1405: CleoOS doctor + claude-sdk smoke** (P1-5): Restore CleoOS harness functionality. (~1 hour)

10. **Owner scoping of T1151 subtasks + T942 RCASD session** (P2-2, P3-4): Before agents touch the 4-pillar self-healing vision or Sentient redesign, owner needs to scope or explicitly defer. Document in BRAIN.

---

## File-as-new-CLEO-task list

```bash
# P0-1: memory sweep rollback
cleo add "Wire cleo memory sweep --rollback dispatch gateway in memory.ts (~20 LOC)" \
  --size small --priority critical \
  --acceptance "cleo memory sweep --rollback <runId> exits 0 and reverts sweep|pnpm run test green|biome clean"

# P0-3: audit overrides
cleo add "Audit 20 force-bypass uses from 2026-04-27 session — verify pre-existing failure claims" \
  --size small --priority critical \
  --acceptance "Each bypass reason verified against git blame|regression tasks filed for any new failure found|BRAIN observation written with findings"

# P0-4: backup-pack test
cleo add "Fix backup-pack.test.ts staging-dir cleanup failure (pre-existing since v2026.4.141)" \
  --size small --priority high \
  --acceptance "backup-pack.test.ts passes without override|test suite at 4 pre-existing failures"

# P1-8: reconcile-scheduler
cleo add "Implement reconcile-scheduler.ts — periodic BRAIN reconciler per PLAN.md §7.3" \
  --parent T1139 --size medium --priority medium \
  --acceptance "packages/core/src/sentient/reconcile-scheduler.ts exists|configurable interval|tests cover schedule+cancel|biome+tsc green"

# P2-3: observation_embeddings verify
cleo add "Verify or add observation_embeddings/turn_embeddings tables per PORT-AND-RENAME §2" \
  --size small --priority low \
  --acceptance "grep confirms table DDL exists in memory-schema.ts OR new migration added"

# P2-4: conduit-schema.ts extraction
cleo add "Split conduit-sqlite.ts into conduit-schema.ts (Drizzle defs) + conduit-sqlite.ts (init only) per domain naming convention" \
  --size small --priority low \
  --acceptance "conduit-schema.ts exists with Drizzle table defs|conduit-sqlite.ts is init/open only|no behavior change|tests green"

# P2-5: tasks-sqlite naming
cleo add "Rename task-store.ts open/init section to tasks-sqlite.ts per domain naming convention" \
  --size small --priority low \
  --acceptance "tasks-sqlite.ts consistent with memory-sqlite.ts pattern|task-store.ts retains business logic only"

# P3-1: override cap pump
cleo add "Pump: cap CLEO_OWNER_OVERRIDE invocations per session — require ADR-style waiver doc above threshold" \
  --size medium --priority medium \
  --acceptance "cleo verify rejects N+1 override per session without waiver file|waiver format documented in ADR"

# P3-2: shared-evidence flag
cleo add "Pump: require --shared-evidence flag when same evidence atom closes >3 child tasks" \
  --size medium --priority low \
  --acceptance "cleo verify warns when single atom covers >3 tasks without --shared-evidence|flag documented"
```
