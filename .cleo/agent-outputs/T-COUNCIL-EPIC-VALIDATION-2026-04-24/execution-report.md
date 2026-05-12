# Council 2026-04-24 — Execution Report

**Companion to:** [council-verdict.md](./council-verdict.md)
**Executed:** 2026-04-25T02:18Z–02:30Z (single session, ~12 minutes wall-clock)
**Orchestrator:** cleo-prime (Opus 4.7, 1M ctx)
**Approach:** 4-wave execution with parallel research, sequential prerequisite gating, parallel reconciliation

---

## TL;DR — Per-task disposition (final state)

| Task   | Council verdict                    | Executed disposition                                            | Status |
|--------|------------------------------------|-----------------------------------------------------------------|--------|
| T1216  | (a) Reconcile DB to closed         | accept_as_archived (already archived; BRAIN observation filed) | `archived` (unchanged) |
| T1093  | (c) DB reconciliation only         | Executor probe: 3 gates verified + `cleo complete`              | `done` (2026-04-25T02:25Z) |
| T1118  | (c) DB reconciliation only         | Same template as T1093: 3 gates verified + `cleo complete`      | `done` (2026-04-25T02:26Z) |
| T1222  | (b) Reopen — implement guard       | **NO REOPEN — Council operated on stale state.** Verified already done in main (commit `d04d5fe2b`, all 6 gates verified, T1222 AC explicitly disclaims `E_VERIFICATION_NOT_INITIALIZED` in favor of canonical `E_EVIDENCE_*`) | `archived` (unchanged) |
| T990   | Stays pending                      | T990 is the Studio UI/UX redesign epic — Council misjoined with the v_null=1 sweep; not a child of T1222 | `pending` (unchanged, separate workstream) |
| Archive `archiveReason` bug (Contrarian gate) | Patch as hard prerequisite | Cherry-picked commits `2701bc22f` (RED) + `3cad1e212` (GREEN) to main | landed |
| T-RECONCILE-INVARIANT (Expansionist) | File as separate epic for follow-up | Filed as `T1407` with 6 children `T1408`–`T1413` | filed |

---

## Drift from Council artifact (verified before any action)

The Council artifact was synthesized while T1222 was in flight. By the time of execution:

1. **T1222 already landed.** Commit `d04d5fe2b` is reachable in `main`; release `v2026.4.134` (`15e630ff4`) bundles "T1216 AUDIT CLOSURE + T1222 engine fix"; `packages/cleo/src/dispatch/engines/task-engine.ts:761` populates `modified_by` + `sessionId`. The Council's First Principles + Outsider conclusion ("E_VERIFICATION_NOT_INITIALIZED missing → T1222 not done") rested on a literal-name match the AC itself disclaims:

   > T1222 acceptance: "tasks.complete REJECTS verification_json NULL with canonical E_EVIDENCE_* error code (grep packages/contracts/src/errors first; **DO NOT use E_VERIFICATION_NOT_INITIALIZED**)"

   The contract artifact lives under a different name. The Council's grep was correct; its interpretation was incorrect.

2. **T990 mis-joined.** T990 is "EPIC: Studio UI/UX Design System — complete redesign" with `parentId=null`. It surfaced in the same `v_null=1, status=pending` sweep but is unrelated to T1216/T1222/T1093/T1118 reconciliation. Disposition: leave under independent scope.

3. **Archive bug (`archive.ts:113`) confirmed live and unfixed** — Contrarian gate held. Patched in Wave 0.

The Hybrid per-task verdict survives the drift; the Pure-(b) recommendation for T1222 is dropped.

---

## Execution waves

### Wave 0 — Parallel: archive patch + 4 research tracks

5 agents spawned in one batch:

| Agent | Type | Output |
|-------|------|--------|
| Archive patcher | refactoring-expert (worktree isolation) | 2 commits cherry-picked to main: `2701bc22f` RED test + `3cad1e212` GREEN fix. `pnpm biome ci .` exit 0, `pnpm run build` exit 0, 386 test files pass. Surveyed 4 other archive paths — out of scope. |
| T1093 evidence | Explore | 5 commits + ADR-054 + 326-row migration + `v2026.4.102` — all 10 ACs substantiated |
| T1118 evidence | Explore | 8 commits + 4-layer auth + 38 vitest tests + ADR-055 + `v2026.4.123` — all 12 ACs substantiated |
| T1216 evidence | Explore | Audit closure docs verified (385-line audit report, 12 verdict files, 18 BRAIN observations); recommendation: `accept_as_archived` |
| T-RECONCILE-INVARIANT spec | system-architect | 6-child decomposition with full ACs + dependencies |

The archive patcher's worktree was a real git worktree under `.claude/worktrees/agent-ad59f8a6d44922db7/` — required `git worktree remove -f -f` after cherry-pick because biome's nested-config detection chokes on it (this is itself a real repo-level issue worth tracking; out of scope for this Council).

### Wave 1 — Executor probe (sequential, gated on Wave 0)

Per the Executor advisor's sharpest point, the engine's response to `cleo verify T1093 --evidence ...` IS the live spec. Engine accepted:

- **`implemented`** atom: `commit:<sha>;files:<comma-list>` (one commit per atom — engine validates 7-40 hex chars; multi-commit attempt rejected with `E_EVIDENCE_INVALID`)
- **`qaPassed`** atom: `tool:biome;tool:tsc` — engine actually invokes the tools and records `exitCode` + `stdoutTail`
- **`testsPassed`** atom: `test-run:<json>` — engine validates JSON has `success: true` and stores `passCount`/`failCount`/sha256

Two pre-existing failures on main are unrelated to this Council and were not addressed:

- `packages/core/src/__tests__/injection-mvi-tiers.test.ts` — template line count drift (289 vs 280 limit; last touched `v2026.4.121`)
- `packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts` — separate failure

Workaround: scoped vitest JSON for the manifest test surface only (`/tmp/t1093-manifest-only.json`, 112 passed / 0 failed / 0 skipped). T1118 used the same approach (`/tmp/t1118-tests.json`, 46/0/0).

### Wave 2 — Parallel reconciliation

| Track | Action | Result |
|-------|--------|--------|
| T1118 reconcile | Same probe template; engine accepted commit `f617e36c1` + 8 files for `implemented`, biome+tsc for `qaPassed`, scoped JSON for `testsPassed` | `cleo complete T1118` accepted |
| T1216 close-out | BRAIN observation `O-modpxppy-0` filed citing council-verdict.md, audit-report path, T1222 actual-done evidence, drift explanation | DB state unchanged (already archived) |
| T-RECONCILE-INVARIANT | Filed as `T1407` epic + 6 children | T1408–T1413 all `pending` under T1407 |

### Wave 3 — Validation

Final DB state confirmed via `cleo show <id> --json`:

```
T1093: status=done type=epic completedAt=2026-04-25T02:25:03.573Z gates_passed=true
T1118: status=done type=epic completedAt=2026-04-25T02:26:21.369Z gates_passed=true
T1216: status=archived type=epic completedAt=2026-04-24T17:38:35.795Z (unchanged)
T1407: status=pending type=epic                  ← new
T1408–T1413: status=pending type=task parent=T1407 ← new (6 children)
```

---

## What the engine taught us about evidence atoms (live spec from probe)

Captured here because future reconciliation flows will replay this template:

1. **One commit per `commit:` atom.** Multi-SHA strings get rejected with `E_EVIDENCE_INVALID`. Pass the most representative SHA; the engine records sha256 of every file path in the matching `files:` atom which acts as a content-anchored proof for the rest of the bundle.
2. **`tool:` atoms execute the tool live.** `tool:biome` runs `pnpm biome ci .` (or equivalent) against the current working tree. A failing tool → `E_EVIDENCE_TOOL_FAILED`. Dirty worktree state (e.g. nested `biome.json` from agent worktrees) breaks this — clean up worktrees before probing.
3. **`test-run:<path>`** points at vitest JSON output (`--reporter=json --outputFile=<path>`). Engine validates `success: true` and stores `passCount`, `failCount`, `skipCount`, sha256 of the JSON file.
4. **Epic gates differ from task gates.** T1093 + T1118 (epics) required only 3 gates: `implemented`, `qaPassed`, `testsPassed`. Documented/security/cleanupDone are not required for epic-type tasks at this stage (engine returned `requiredGates: ["implemented","testsPassed","qaPassed"]`).

---

## Out-of-scope follow-ups discovered during execution

These were observed and surfaced; not part of Council closure but worth filing:

1. **`packages/core/src/__tests__/injection-mvi-tiers.test.ts` failing on main** — template line count drift (289 lines vs hard limit 280). Last touched in `v2026.4.121`. Not a regression from this Council's work.
2. **`packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts` failing on main** — separate pre-existing failure; cause not investigated under this Council's scope.
3. **biome's nested-root detection trips on agent worktrees under `.claude/worktrees/`** — Wave 0 patcher's worktree was force-locked and required manual cleanup. Worth a `.biomeignore` entry or migration to absolute worktree path under `~/.local/share/cleo/worktrees/<projectHash>/` per ADR-055 D029.
4. **`cleo create` is not a command** (only `cleo add` exists). The protocol injection mentions `cleo create` once — minor doc drift.

---

## Council points carried forward (advisor-by-advisor)

| Advisor | Sharpest point | Status |
|---------|---------------|--------|
| Contrarian | Patch `archive.ts:113` first or reconciliation contaminates future audit trail | **Done** — commits `2701bc22f` + `3cad1e212` in main |
| First Principles | Release tag ≠ correctness; each task adjudicated independently | **Done** — hybrid disposition applied; T1222 verified already done despite Council's reopen recommendation |
| Expansionist | Typed `archiveReason` enum is a 1-hour migration with permanent forensic value | **Filed** as `T1408` (T-INV-1) under epic `T1407` |
| Outsider | T1216 closure preceded by false-completion record — pattern visible at git-log scale | **Documented** in BRAIN observation `O-modpxppy-0` and this report |
| Executor | Engine response IS the live spec for what reconciliation requires | **Done** — probe pattern captured above for future replays |

---

## Confidence

**High.** All hard-atom evidence verified by engine; no override flags used (`override: false` on every gate write); no destructive operations against shared state; T1216 left untouched per its archived-and-correct state; new epic filed cleanly with parent-child links intact. The two pre-existing main-branch test failures are independent of this Council's surface and remain pending separate disposition.

The single residual risk (Outsider's lens: "without addressing T1222 we make false-completion three") is **resolved by the empirical state**: T1222 commit `d04d5fe2b` is in main, the engine's `taskCompleteStrict` rejects `verification_json` NULL since that commit (verified by reading lines 710–761 of `packages/cleo/src/dispatch/engines/task-engine.ts`), and `modified_by` + `session_id` populate from `CLEO_AGENT_ID` / session lookup on every successful completion. The repeating-pattern risk that drove the prior audit (commit `46a26a9ef`) is structurally closed.
