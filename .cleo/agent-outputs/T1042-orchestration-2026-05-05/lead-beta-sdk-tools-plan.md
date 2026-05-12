# Lead Beta — T1768 SDK Tools Wave Plan

**Date**: 2026-05-05  
**Author**: Lead Beta (RCASD planning subagent)  
**Epic**: T1768 — Define Cleo Core SDK 'Tools' surface  
**Status**: T1814 done (1/10); T1815-T1823 pending (9/10)

---

## Current State

- **SDK directory layout**: DOES NOT EXIST. `packages/core/src/tools/` contains ONLY `engine-ops.ts` and `index.ts` (Category C — CAAMP management from ENG-MIG-8). No `sdk/` or `agents/` sub-directories exist yet.
- **Category A vs B taxonomy clarity**: RESOLVED. ADR draft at `.cleo/rcasd/T1768/decomposition/sdk-tools-adr-draft.md` defines both categories with no-ambiguity rules. T1814 audit confirmed 0 Category A files exist yet (T1737 creates those), and 10 Category B symbols identified across 5 source files in `tasks/`, `spawn/`, `worktree/`, and `memory/`.
- **ADR-063 number collision**: CONFIRMED — `docs/adr/ADR-063-release-pipeline.md` is already accepted (T1597, 2026-04-29). T1768's SDK Tools ADR MUST use a different number. Owner note on T1768 (2026-05-04 19:18:30 UTC) explicitly confirms: ADR draft remains at `.cleo/rcasd/T1768/decomposition/sdk-tools-adr-draft.md` with placeholder label `ADR-XXX` until T1824-3 (T1827) ships programmatic numbering. The next available number is **ADR-064**.
- **T1816 formal dep on T1827 is a planning artifact**: T1827 (T1824-3, wire ADR-creation flow) depends on T1826 (not yet started). However, owner note on T1768 explicitly clears this: the ADR can be written with `ADR-XXX` placeholder and published once T1827 is ready. T1816 SHOULD proceed with `ADR-064` as the working number (first sequential slot after ADR-063). The T1827 dep should be treated as a publish-gate, not a write-gate.
- **T1823 partial state**: Two subtasks done (T1851: boundary contract + core enforcement; T1852: git-shim enforcement). T1823 parent has `implemented: true` but `testsPassed: false`, `qaPassed: false`. The parent task must still run tests and wire regression test before completing. T1823 depends on T1817 for the SDK-level fix — the git-shim subtasks are already done but the SDK-level centralization (the root fix) requires T1817 first.
- **ClaudeCodeSpawnProvider isolation gap**: `packages/adapters/src/providers/claude-code/spawn.ts` references T1759's `provisionIsolatedShell` in a code comment (line 114-116) but does NOT formally import or call it. The T1821 task closes this gap.
- **PiHarness is already correct**: `packages/caamp/src/core/harness/pi.ts` already imports `provisionIsolatedShell` from `@cleocode/contracts` directly — confirmed by T1814 audit.
- **No physical file moves required**: All T1817-T1819 promotions are re-export barriers (additive files), preserving all existing import paths. Risk is LOW across the entire promotion wave.

---

## Wave Plan

### Wave 0 — Directory scaffold and interfaces (parallel-safe after T1814)

| Task | Title | Risk | Size | Agent Role |
|------|-------|------|------|------------|
| T1815 | Define `packages/core/src/tools/sdk/` directory — interfaces and barrel index | LOW | small | implementer |

**Prerequisite met**: T1814 done. T1815 depends only on T1814. No blockers.

**What T1815 does**: Creates 6 new files — `packages/core/src/tools/sdk/index.ts` (barrel), and stub files for `isolation.ts`, `tool-resolver.ts`, `tool-cache.ts`, `manifest.ts`, `spawn-primitives.ts` (interfaces/types only, no implementation). Defines `SdkTool` interface in `packages/contracts/src/`. Updates `packages/core/src/tools/index.ts` to re-export from `sdk/`.

**Must complete before Wave 1 begins.**

---

### Wave 1 — ADR write (unblocked with ADR-XXX placeholder)

| Task | Title | Risk | Size | Agent Role |
|------|-------|------|------|------------|
| T1816 | Write ADR-064: Cleo Core SDK Tools taxonomy (Category A Agent Tool vs Category B SDK Tool) | LOW | small | writer |

**Note on T1827 dep**: T1816 is formally marked as depending on T1827 in the DB. However, owner note on T1768 (2026-05-04) explicitly states the ADR can be written with placeholder label and that D1-D4 decisions stand. The orchestrator should either (a) treat T1827 as a publish-gate by overriding the dep for spawn, or (b) spawn T1816 with the caveat that the final ADR filename should use `ADR-064` (next sequential slot after ADR-063) and the draft-to-published transition awaits T1827. **Recommended**: spawn T1816 immediately after T1815. The acceptance criterion says `ADR-063-sdk-tools-surface.md` — this MUST be updated to `ADR-064-sdk-tools-surface.md` before the task completes.

**Wave 1 can run in parallel with Wave 0's tail** — T1816 does not depend on T1815. They are independent; however, T1816's ADR should reference the `tools/sdk/` path that T1815 creates. Spawn T1816 immediately after T1815 completes (or concurrently if the orchestrator accepts minor doc-only risk).

---

### Wave 2 — Promotion wave (parallel-safe, all depend on T1816)

| Task | Title | Risk | Size | Agent Role |
|------|-------|------|------|------------|
| T1817 | Promote WorktreeIsolation to SDK Tool — `packages/core/src/tools/sdk/isolation.ts` | LOW | small | implementer |
| T1818 | Promote ToolResolver+ToolCache to SDK Tool — `packages/core/src/tools/sdk/tool-resolver.ts` | LOW | small | implementer |
| T1819 | Promote pipelineManifestAppend to SDK Tool — `packages/core/src/tools/sdk/manifest.ts` | LOW | small | implementer |

**All three can run in parallel.** Each creates files in `tools/sdk/` that are independent of each other. T1817 touches `worktree/isolation.ts` + `orchestrate/spawn-ops.ts` + `orchestration/spawn-prompt.ts`; T1818 touches `tasks/tool-resolver.ts` + `tasks/tool-cache.ts` + `validation/validate-ops.ts`; T1819 touches `memory/pipeline-manifest-sqlite.ts`. No overlapping file edits.

**Critical note for T1817 worker**: The acceptance criterion references updating `orchestrate/spawn-ops.ts` and `orchestration/spawn-prompt.ts` as callers. Current callers import from `../worktree/isolation.js`. The promotion makes `tools/sdk/isolation.ts` the canonical path. Worker MUST update those two callers. The `packages/caamp/src/core/harness/pi.ts` already imports from `@cleocode/contracts` — leave it alone (T1822 documents this, does not change it).

**Critical note for T1818 worker**: `packages/core/src/validation/validate-ops.ts` should be updated to import from `tools/sdk/tool-resolver.ts`. `packages/core/src/tasks/evidence.ts` can stay (same-package internal coherence is acceptable per audit note).

---

### Wave 3 — Harness wiring and docs (depend on Wave 2)

| Task | Title | Risk | Size | Agent Role |
|------|-------|------|------|------------|
| T1821 | Refactor ClaudeCodeSpawnProvider to consume SDK Tools (WorktreeIsolation) | MEDIUM | small | implementer |
| T1822 | Verify PiHarness SDK Tool consumption is complete and formally documented | LOW | small | verifier |
| T1823 | P0: T1763 worktree isolation breach — complete test gates | MEDIUM | medium | implementer |
| T1820 | Write `docs/architecture/sdk-tools.md` — canonical SDK Tools reference | LOW | small | writer |

**Parallelism notes**:
- T1821 and T1822 both depend on T1817 only — can run in parallel.
- T1823 depends on T1817 (the SDK-level fix for the breach vector). The two subtasks (T1851, T1852) are already done; T1823 parent still needs `testsPassed` and `qaPassed` gates — running `pnpm run test` to prove regression test passes is the remaining work.
- T1820 depends on T1819 (needs all three SDK tools populated to write a complete reference doc). T1820 can spawn alongside T1821/T1822/T1823 but must wait for T1819 to complete — so it belongs in Wave 3 but may lag.

**T1821 risk note**: This is the highest-risk task in the epic. `packages/adapters/` is a separate package from `packages/core/`. The import path for `provisionIsolatedShell` should use `@cleocode/contracts` directly (not `@cleocode/core/tools/sdk/isolation.js`) to avoid the circular-dependency risk that the original T1759 fix deliberately avoided. The T1821 acceptance criterion says "from `packages/core/src/tools/sdk/isolation.ts` (or `@cleocode/contracts` for circ-dep avoidance)" — the worker MUST choose `@cleocode/contracts` to be safe.

**T1823 remaining work**: T1823 has `implemented: true` (via T1851/T1852 commits) but `testsPassed: false`. The remaining work is: run `pnpm run test`, confirm the regression test in `packages/core/src/worktree/__tests__/isolation.test.ts` passes, run biome, then verify+complete. This is LOW-effort but gates the P0 ticket closure.

---

### Wave 4 — Epic close ceremony (after all Wave 3 tasks done)

No explicit task for this — the epic completes when all 9 pending children are done. The `noAutoComplete` flag is not set on T1768, so the epic closes automatically when all children reach `done` status.

---

## IVTR Strategy per Task

### T1815 — Directory scaffold

| Item | Detail |
|------|--------|
| Files created | `packages/core/src/tools/sdk/index.ts`, `packages/contracts/src/sdk-tool.ts` (or inline in `packages/contracts/src/index.ts`), `packages/core/src/tools/index.ts` (update) |
| Acceptance gates | `implemented` (commit + files), `qaPassed` (biome lint), `testsPassed` (pnpm run test — no regressions) |
| Evidence atoms | `commit:<sha>;files:packages/core/src/tools/sdk/index.ts,packages/contracts/src/sdk-tool.ts` |
| Test invocation | `pnpm run test` — no new test file needed (structural, types-only task) |
| IVTR | Single implementer, no parallelism needed. Verify biome passes. |

### T1816 — ADR write

| Item | Detail |
|------|--------|
| Files created | `docs/adr/ADR-064-sdk-tools-surface.md` |
| Key constraint | Filename MUST be `ADR-064` (not `ADR-063` which is taken). Acceptance criterion has stale number — worker must override to `ADR-064`. |
| Acceptance gates | `implemented` (commit + file), `documented` (files:docs/adr/ADR-064-sdk-tools-surface.md), `qaPassed` (biome) |
| Evidence atoms | `commit:<sha>;files:docs/adr/ADR-064-sdk-tools-surface.md` |
| Test invocation | No test run needed (pure doc task). Use `tool:lint` for `qaPassed`. |
| IVTR | Single writer. No regression risk. |

### T1817 — WorktreeIsolation promotion

| Item | Detail |
|------|--------|
| Files created/modified | `packages/core/src/tools/sdk/isolation.ts` (NEW re-export), `packages/core/src/tools/sdk/index.ts` (update), `packages/core/src/worktree/isolation.ts` (update: also re-exports from sdk/), `packages/core/src/orchestrate/spawn-ops.ts` (update import path), `packages/core/src/orchestration/spawn-prompt.ts` (update import path) |
| Acceptance gates | `implemented`, `testsPassed`, `qaPassed` |
| Evidence atoms | `commit:<sha>;files:packages/core/src/tools/sdk/isolation.ts,packages/core/src/orchestrate/spawn-ops.ts,packages/core/src/orchestration/spawn-prompt.ts` |
| Test invocation | `pnpm run test` — existing isolation tests in `packages/core/src/worktree/__tests__/isolation.test.ts` must continue passing |
| IVTR | Single implementer. Verify no circular import introduced (isolation.ts → contracts, not core). |

### T1818 — ToolResolver+ToolCache promotion

| Item | Detail |
|------|--------|
| Files created/modified | `packages/core/src/tools/sdk/tool-resolver.ts` (NEW), `packages/core/src/tools/sdk/tool-cache.ts` (NEW), `packages/core/src/tools/sdk/index.ts` (update), `packages/core/src/validation/validate-ops.ts` (update import) |
| Acceptance gates | `implemented`, `testsPassed`, `qaPassed` |
| Evidence atoms | `commit:<sha>;files:packages/core/src/tools/sdk/tool-resolver.ts,packages/core/src/tools/sdk/tool-cache.ts,packages/core/src/validation/validate-ops.ts` |
| Test invocation | `pnpm run test` |
| IVTR | Single implementer. Zero-risk re-exports. |

### T1819 — pipelineManifestAppend promotion

| Item | Detail |
|------|--------|
| Files created/modified | `packages/core/src/tools/sdk/manifest.ts` (NEW), `packages/core/src/tools/sdk/index.ts` (update) |
| Note | Do NOT update any of the 28+ consumers — re-export makes new path available, no forced migration |
| Acceptance gates | `implemented`, `testsPassed`, `qaPassed` |
| Evidence atoms | `commit:<sha>;files:packages/core/src/tools/sdk/manifest.ts` |
| Test invocation | `pnpm run test` |
| IVTR | Single implementer. Lowest risk task in Wave 2. |

### T1820 — Architecture docs

| Item | Detail |
|------|--------|
| Files created | `docs/architecture/sdk-tools.md` |
| Prerequisite | Must run after T1819 completes (needs all sdk/ files populated for accurate path listing) |
| Acceptance gates | `implemented`, `documented` (files:docs/architecture/sdk-tools.md), `qaPassed` (biome) |
| Evidence atoms | `commit:<sha>;files:docs/architecture/sdk-tools.md` |
| Test invocation | `tool:lint` for qaPassed. No test run required (doc task). |
| IVTR | Single writer. Reference the audit at `.cleo/rcasd/T1768/architecture/sdk-tools-audit.md` for all import paths and consumer counts. |

### T1821 — ClaudeCodeSpawnProvider refactor

| Item | Detail |
|------|--------|
| Files modified | `packages/adapters/src/providers/claude-code/spawn.ts` |
| Critical import path | MUST use `@cleocode/contracts` (not `@cleocode/core`) to avoid circular dep |
| Acceptance gates | `implemented`, `testsPassed`, `qaPassed` |
| Evidence atoms | `commit:<sha>;files:packages/adapters/src/providers/claude-code/spawn.ts` |
| Test invocation | `pnpm run test` — verify adapters package tests pass |
| IVTR | Single implementer. Verify `provisionIsolatedShell` is called in the spawn path (not just referenced in comment). Check lines 114-116 of current spawn.ts for the comment-only reference to replace. |

### T1822 — PiHarness verification

| Item | Detail |
|------|--------|
| Files modified | `packages/caamp/src/core/harness/pi.ts` (TSDoc update only — no logic change) |
| Nature of work | Read-confirm + documentation: verify pi.ts import from `@cleocode/contracts`, add `@adr ADR-064` TSDoc annotation to spawn method |
| Acceptance gates | `implemented` (commit + file), `testsPassed`, `qaPassed` |
| Evidence atoms | `commit:<sha>;files:packages/caamp/src/core/harness/pi.ts` |
| Test invocation | `pnpm run test` |
| IVTR | Single verifier. Very low effort. |

### T1823 — P0 isolation breach close-out

| Item | Detail |
|------|--------|
| Remaining work | T1851 + T1852 subtasks already done. Parent task needs `testsPassed` + `qaPassed` gates. Run `pnpm run test`, confirm regression test passes, run biome, then verify + complete. |
| Files already modified | `packages/contracts/src/branch-lock.ts`, `packages/core/src/worktree/isolation.ts`, `packages/git-shim/src/isolation-boundary.ts` |
| Acceptance gates remaining | `testsPassed` (tool:test), `qaPassed` (tool:lint) |
| Evidence atoms | `test-run:<path>;tool:lint` |
| Test invocation | `pnpm run test` — confirm `packages/core/src/worktree/__tests__/isolation.test.ts` passes; also confirm `packages/git-shim/` tests pass |
| IVTR | Single implementer. This is a verification + gate-capture task, not a new-code task. Low effort but blocks P0 closure. |

---

## Open Questions for HITL

| # | Question | Context | Recommended Action |
|---|----------|---------|-------------------|
| Q1 | **ADR number**: T1816 acceptance criterion says `ADR-063-sdk-tools-surface.md` but ADR-063 is already taken by the release pipeline. Should T1816 use `ADR-064`? | `docs/adr/ADR-063-release-pipeline.md` exists (accepted, T1597, 2026-04-29). Owner note on T1768 says placeholder `ADR-XXX` until T1824-3. Next sequential slot is ADR-064. | Confirm: T1816 worker should write `docs/adr/ADR-064-sdk-tools-surface.md`. No HITL block — just update the acceptance criterion text before dispatching T1816. |
| Q2 | **T1816 blocking dep on T1827**: DB shows T1816 depends on T1827 (which depends on T1826, not yet started). Owner note says ADR can be written with placeholder number. Should the orchestrator override the T1827 dep to unblock T1816? | T1827 is about wiring the ADR-creation flow with sequential numbering. The writing of the ADR draft (T1816) does not require T1827 — only the final publication does. | Recommended: override/ignore the T1827 dep for spawn purposes. T1816 proceeds with `ADR-064` as working number. T1827 remains a prerequisite for the final `cleo docs publish` action if that system is ever used. |
| Q3 | **T1823 scope**: T1823 depends on T1817 per the DB, but T1851 and T1852 (subtasks that implement the fix) are already done. Does T1823 still need to wait for T1817, or can it be closed now by just running the gate evidence? | T1823 has `implemented: true` but `testsPassed: false`. The SDK-level fix (T1817) has not been merged yet, but the git-shim enforcement (T1851/T1852) is in place. | Spawn a T1823 close-out worker that only runs `pnpm run test` + `tool:lint` and captures evidence — this can proceed in Wave 3 after T1817 completes (T1817 adds the SDK re-export that T1823 references). |
| Q4 | **T1820 ADR reference**: T1820 acceptance says "References ADR-063" — this is the stale number. The docs file should reference ADR-064 (the correct SDK Tools ADR). | Same collision as Q1. | No HITL block. Update acceptance criterion for T1820 before dispatch: reference `ADR-064`, not `ADR-063`. |

---

## New Tasks Proposed

| Proposed Task | Rationale | Priority |
|---------------|-----------|----------|
| **T1768-N1: Promote `buildAgentEnv` + `buildWorktreeSpawnResult` to `tools/sdk/spawn-primitives.ts`** | Audit identified these in `packages/core/src/spawn/branch-lock.ts` as Category B SDK Tools (low urgency — no external consumers yet). Wave B did not include them. Should be filed as a follow-up task under T1768 or a new child for cleanup. | low |
| **T1768-N2: Update 28+ `pipelineManifestAppend` consumer import paths to use `tools/sdk/manifest.ts`** | T1819 intentionally does NOT migrate consumers (additive re-export only). A follow-up migration task should update callers over time to use the canonical `tools/sdk/manifest.ts` path. | low |
| **Update T1816 acceptance criterion** (not a task — orchestrator action): Change `ADR-063-sdk-tools-surface.md` to `ADR-064-sdk-tools-surface.md` via `cleo update T1816 --acceptance "..."` before dispatching. | ADR-063 is already taken. | critical (before spawn) |
| **Update T1820 acceptance criterion**: Change "References ADR-063" to "References ADR-064". | Same stale number issue. | medium (before spawn) |

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **ADR-063 number collision** — worker writes `ADR-063-sdk-tools-surface.md` which collides with accepted `ADR-063-release-pipeline.md` | HIGH | Orchestrator MUST update T1816 acceptance criterion to `ADR-064` before spawning. Worker must use `ADR-064`. |
| **T1821 circular dependency** — ClaudeCodeSpawnProvider imports from `@cleocode/core` (which imports from `@cleocode/adapters` creating a circle) | MEDIUM | Worker MUST import `provisionIsolatedShell` from `@cleocode/contracts` directly, not from `@cleocode/core/tools/sdk/isolation.js`. Acceptance criterion already includes this caveat. |
| **T1816 spawn blocked by T1827 dep in DB** | MEDIUM | Orchestrator should treat T1827 as a publish-gate (not write-gate) and spawn T1816 after T1815 completes. Owner note explicitly endorses the `ADR-XXX` placeholder approach. |
| **T1823 remains open with `testsPassed: false`** | MEDIUM | This is a P0 ticket. The close-out worker for T1823 must be included in Wave 3 dispatch. It is primarily a gate-capture task (tests already written, just needs to run and record evidence). |
| **T1815 SdkTool interface placement** — acceptance says "defined in `packages/contracts/src/`" but does not specify the file | LOW | Worker should create `packages/contracts/src/sdk-tool.ts` (new file) or add to an existing contracts barrel. Must not inline the type in `packages/core/`. |
| **Wave 2 parallelism file overlap** — T1817, T1818, T1819 all update `packages/core/src/tools/sdk/index.ts` | LOW | Each task adds its own export line to `sdk/index.ts`. If run in worktrees, the barrel file will have merge conflicts. Mitigation: run T1817, T1818, T1819 in separate worktrees, then merge sequentially (not simultaneously). The orchestrator's `git merge --no-ff` integration handles this, but the merge order matters. **Recommend**: T1817 merges first (isolation, critical path), then T1818, then T1819. |
| **T1823 partial implementation state** — T1823 has `implemented: true` (T1851/T1852 commits) but `testsPassed: false`. If a worker tries to re-implement rather than just run gates, they may overwrite existing work. | LOW | Spawn T1823 worker with explicit instruction: "subtasks T1851 and T1852 are already done — do NOT rewrite any files. Only action needed: run `pnpm run test`, capture test evidence, run biome, then verify gates and complete." |

---

## Dependency Graph Summary

```
T1814 [done]
  └─ T1815 (Wave 0 — scaffold)
       └─ (T1816 can proceed concurrently with T1815 or after)
T1816 (Wave 1 — ADR) [dep on T1827 is a publish-gate, not write-gate; spawn after T1815]
  ├─ T1817 (Wave 2 — isolation promotion)     ┐
  ├─ T1818 (Wave 2 — resolver promotion)      ├─ all parallel
  └─ T1819 (Wave 2 — manifest promotion)      ┘
       ├─ T1820 (Wave 3 — architecture docs)
       ├─ T1821 (Wave 3 — Claude Code adapter refactor)  ┐ parallel
       ├─ T1822 (Wave 3 — PiHarness verification)        ┤
       └─ T1823 (Wave 3 — P0 close-out gates)            ┘
```

**Total remaining tasks**: 9 (T1815-T1823)  
**Wave 0**: 1 task  
**Wave 1**: 1 task (can overlap with Wave 0 tail)  
**Wave 2**: 3 parallel tasks (after T1816)  
**Wave 3**: 4 tasks (T1820 after T1819; T1821/T1822/T1823 after T1817)

**Critical path**: T1815 → T1816 → T1817 → T1821/T1823 (longest chain: 4 hops)
