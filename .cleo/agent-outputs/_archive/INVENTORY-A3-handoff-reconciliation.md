# INVENTORY A3 — Handoff Backlog Reconciliation

**Date**: 2026-04-28  
**Baseline**: NEXT-SESSION-HANDOFF.md (written post-T1414, v2026.4.141)  
**Current state**: v2026.4.152 (npm installed), HEAD at b4aa64f5f  
**Scope**: 13 P0-P3 items + 4 pump items from handoff  

---

## Summary Table

| # | Priority | Item | Filed Task | Code Addressed? | Current Reality |
|---|----------|------|-----------|----------------|-----------------|
| 1 | P0 | `cleo memory sweep --rollback` dispatch gap | NONE | Partial — case exists, routing missing | **STILL BROKEN** in v2026.4.152. The `case 'sweep'` block handles rollback internally, but `'sweep'` only appears in the `query[]` routing array, never in `mutate[]`. Result: `E_INVALID_OPERATION: Unknown operation: mutate:memory.sweep`. All 4 sweep runs are now `rolled-back` status so no live data is at risk, but the operation remains non-functional. Fix: add `'sweep'` to the `mutate[]` array in the `getOperationConfig()` routing table in `packages/cleo/src/dispatch/domains/memory.ts`. ~1 LOC. |
| 2 | P0 | 68-candidate BRAIN sweep awaiting owner approval | NONE | N/A — owner decision | **MOOT**. All 4 `brain_backfill_runs` rows have `status=rolled-back`. No staged sweep awaiting approval. Owner decision is effectively "abandoned" by the rollback. No action required unless owner wants to re-run. |
| 3 | P0 | `backup-pack.test.ts` staging-dir cleanup failure | NONE | Fixed (tests pass) | **RESOLVED** — all 29 backup-pack tests PASS in isolation (confirmed via `vitest run backup-pack`). The test run failure seen during investigation was from `pipeline.integration.test.ts` running alongside it — an unrelated pre-existing failure. The backup-pack cleanup issue from the handoff no longer exists. **NEW ISSUE DISCOVERED**: `pipeline.integration.test.ts` has 7 failing tests (T4798/T4801 lifecycle passGate + cross-session resume). Not filed as a task; pre-existing before v2026.4.141 based on git history. |
| 4 | P1 | Wave 7 `reconcile-scheduler.ts` absent | NONE | No | **STILL ABSENT**. `packages/core/src/sentient/reconcile-scheduler.ts` does not exist. PLAN.md §7.3 specified a periodic scheduler that extends the sentient tick. Reconciliation still runs only on-demand or via dispatch reflex. No task filed for this specific gap. |
| 5 | P1 | PLAN.md Part 10 T1151 subtasks never filed | NONE (T1151 archived) | No | **HANDOFF WAS INCORRECT RE: IDs**. T1151 is `archived` with no children in DB. The IDs T1152–T1159 exist in the database but are *unrelated* T-MSR (migration state reconciliation) tasks — they got those IDs incidentally. The four-pillar subtasks (step-level retry, reflection agent, session tree, soft-trim, context budget, TUI adapter, pluggable filesystem/sandbox) were NEVER filed as concrete tasks. T1151 was absorbed into T1148 per Council 2026-04-24 with an owner-override `testsPassed`. The 4-pillar work is now aspirational with no task representation. |
| 6 | P1 | Wave 5 §5.3 dispatcher-to-durable-queue upgrade | NONE | No — still setImmediate | **STILL OUTSTANDING**. `packages/cleo/src/dispatch/dispatcher.ts:188` wraps `evaluateDialectic` + `applyInsights` in a `setImmediate` fire-and-forget. The `enqueueDerivation` from the T1145 deriver queue is never called for dialectic evaluations. Process crashes lose in-flight dialectic analysis. No task filed for this upgrade path specifically. |
| 7 | P1 | Wave 8 §8.3 representation-via-dialectic sigil schema delta | NONE | No | **STILL OUTSTANDING**. `packages/core/src/store/nexus-schema.ts` sigils table (line 530) does NOT include `mental_model` or `representationJson` columns. `DialecticInsights.peerRepresentationDelta` merge logic absent from `dialectic-evaluator.ts` and `applyInsights`. Either permanently descoped from T1148 or still unimplemented. No task filed. |
| 8 | P2 | T1414 CHANGELOG entry | NONE (was item from handoff) | Yes — auto-included | **RESOLVED**. CHANGELOG.md line 326: `f82fd7c93 — refactor(T1414): trim CLEO-INJECTION.md from 289 → 264 lines`. The fix commit was included in the v2026.4.142 release CHANGELOG. Not a silent fix. |
| 9 | P2 | `observation_embeddings`/`turn_embeddings` tables | NONE | No | **STILL UNCONFIRMED**. `grep -rn "observation_embeddings\|turn_embeddings" packages/core/src/` returns zero results. These PORT-AND-RENAME §2 table-level schema items do not exist in the codebase. Column-level additions (provenance_class, times_derived, level, tree_id) land via lazy `ensureColumns` ALTER TABLE. The table-level items were silently dropped from scope. No task filed to track or explicitly descope this. |
| 10 | P2 | `tasks-sqlite.ts` naming inconsistency | NONE needed | Yes — FIXED | **RESOLVED** post-handoff. Commit `926f002c7` (2026-04-24 23:25): `refactor(T1407-followup): rename task-store.ts → tasks-sqlite.ts`. All import sites updated. `tasks-sqlite.ts` now exists as the canonical CRUD file matching the `<domain>-sqlite.ts` naming convention. |
| 11 | P3 | T1403 Release post-deploy-execute stage | **T1403** (pending, epic) | No | **FILED, NOT IMPLEMENTED**. T1403 status=pending, pipelineStage=research, no children, no evidence. CI still has no `execute-payload` post-tag stage. |
| 12 | P3 | T1404 Parent-closure-without-atom enforcement | **T1404** (pending, epic) | No | **FILED, NOT IMPLEMENTED**. T1404 status=pending, pipelineStage=research, no children, no evidence. `cleo complete <epicId>` still accepts `verification=null`. 106 owner-override invocations occurred since the handoff was written (2026-04-25 to 2026-04-28). |
| 13 | P3 | `conduit-schema.ts` extraction | NONE needed | Yes — FIXED | **RESOLVED** post-handoff. Commit `7300e3eed` (2026-04-24 23:31): `refactor(T1407-followup): split conduit-sqlite.ts → conduit-schema.ts`. `packages/core/src/store/conduit-schema.ts` now contains Drizzle table defs (16 tables). `conduit-sqlite.ts` is thinned to open/init/CRUD. |
| 14 | Pump | T-PUMP-OVERRIDE-CAP (cap CLEO_OWNER_OVERRIDE invocations) | NONE | No | **NOT FILED. ESCALATING URGENCY**. 106 force-bypass entries since 2026-04-25 (3 days). 36 unique tasks bypassed. Top patterns: epic lifecycle advancement (18+), worktree pre-existing test failures (many). The cap mechanism does not exist in code — `force-bypass.jsonl` has 665 total entries with no enforcement gate. |
| 15 | Pump | T-PUMP-BATCH-EVIDENCE (require --shared-evidence for batch closes) | NONE | No | **NOT FILED**. No task exists for requiring `--shared-evidence` on batch child closures. The single shared `tool:pnpm-test` evidence pattern across N>3 tasks remains unchecked by the system. |

---

## Narrative Analysis

### Items Obsolete or Auto-Resolved Since v2026.4.141

**Item 2 (68-candidate BRAIN sweep)**: Moot. All 4 runs show `status=rolled-back`. There is no pending sweep waiting for owner approval. If the sweep should be re-run, owner would need to issue a fresh `cleo memory sweep` to generate new candidates.

**Item 8 (T1414 CHANGELOG)**: Auto-resolved by the v2026.4.142 release cycle. The fix commit `f82fd7c93` was included in the release CHANGELOG. The handoff's concern that it might be "silently lost" did not materialize.

**Item 10 (tasks-sqlite naming)**: Resolved by commit `926f002c7` on 2026-04-24 (same day the handoff was written, slightly after). The rename was already complete before the ink was dry on the handoff.

**Item 13 (conduit-schema.ts)**: Resolved by commit `7300e3eed` on 2026-04-24. `conduit-schema.ts` now exists with all 16 Drizzle table defs. conduit-sqlite.ts is properly thinned.

**Item 3 (backup-pack.test.ts cleanup failure)**: The stated failure does not exist in v2026.4.152. All 29 backup-pack tests pass. The handoff noted a "pre-existing test failure that surfaced during T1414 worker's investigation" — it was apparently fixed between sessions without a dedicated task.

---

### Items That Are Now MORE Urgent

**Item 14 (T-PUMP-OVERRIDE-CAP)**: CRITICAL escalation. The handoff acknowledged 15 batch overrides as the root cause of CLEO-INJECTION.md sprawl. Since the handoff was written 3 days ago, 106 additional force-bypass entries have been generated across 36 unique tasks. The 9 most common reasons:
- "T1417 epic close-out" (9 entries) — suggests lifecycle advancement is routinely bypassed for parent epics
- "subagent advancing parent epic lifecycle" (6 entries) — subagents are using overrides to advance lifecycle stages
- "subagent advancing T1417 to unblock" (5 entries) — worktree-spawned agents using override as workaround

This is the exact failure mode the handoff warned about, repeating within 72 hours of the warning. The pump task needs to be filed and implemented before the next major work cycle.

**Item 1 (memory sweep --rollback dispatch gap)**: Still broken. The fix is genuinely ~1 LOC (add `'sweep'` to the `mutate[]` array). The `case 'sweep'` block already has working rollback logic. This should be filed as a focused P0 task and fixed in the next session.

**Item 6 (Wave 5 §5.3 dialectic fire-and-forget)**: The dispatcher still wraps dialectic evaluation in `setImmediate`. The T1145 deriver queue exists and is operational, but dialectic evaluations never go through it. Process crashes lose in-flight dialectic turns silently. This is a data-integrity concern, not just technical debt.

---

### Items That Should Be Re-Filed with Concrete Acceptance Criteria

**Item 1 (P0) — `cleo memory sweep --rollback`**:
- File as: `fix(memory): add 'sweep' to mutate[] routing in memory dispatch`
- Acceptance: `cleo memory sweep --rollback <runId>` returns success/error (not `E_INVALID_OPERATION`); one-line change in `getOperationConfig()` mutate array; biome+tsc green
- File: `packages/cleo/src/dispatch/domains/memory.ts` line ~1994 (`mutate[]` array)

**Item 4 (P1) — reconcile-scheduler.ts**:
- File as: `feat(sentient): implement periodic reconcile-scheduler per PLAN.md §7.3`
- Acceptance: `packages/core/src/sentient/reconcile-scheduler.ts` created with interval-based `runReconciler()` invocation; wired to sentient tick; configurable interval; biome+tsc+test green

**Item 5 (P1) — T1151 subtasks never filed**:
- Options: (a) Explicitly file T1152-T1159 equivalents under T942 (Sentient CLEO Architecture Redesign) as concrete tasks, OR (b) Mark the 4-pillar vision as `aspirational` in T942's description and defer to a v2026.5.x RCASD planning session per handoff recommendation
- The T1151 anchor is archived — there is no live parent for these tasks. They would need to be filed under T942 or a new planning epic.

**Item 7 (P1) — Wave 8 §8.3 representation-via-dialectic**:
- Either file as: `feat(sigil): add mental_model/representationJson columns + DialecticInsights peerRepresentationDelta merge`
- OR explicitly cancel with: `cleo update T1148 --notes "§8.3 descoped: representationJson deferred to v2026.5.x"`
- Currently this is a gap with no task and no explicit cancellation record

**Item 9 (P2) — observation_embeddings/turn_embeddings**:
- Either file as: `feat(brain): add observation_embeddings and turn_embeddings table defs to memory-schema.ts`
- OR: file as `docs: explicitly descope PORT-AND-RENAME §2 table-level items from memory-architecture-spec.md` if the scope is intentionally dropped

**Item 14 (Pump) — T-PUMP-OVERRIDE-CAP**:
- File as: `feat(verify): cap CLEO_OWNER_OVERRIDE invocations per session with waiver requirement above N`
- Acceptance: CLEO tracks per-session override count; emits warn at N=3; blocks at N=10 without explicit `--waiver-doc <path>` flag pointing to an ADR or justification file; `force-bypass.jsonl` includes override count; `cleo session status` surfaces override count for current session

**Item 15 (Pump) — T-PUMP-BATCH-EVIDENCE**:
- File as: `feat(verify): require --shared-evidence flag when single atom backs N>3 child closures`
- Acceptance: `cleo verify` with a shared `tool:pnpm-test` atom applied to >3 tasks in the same session triggers a warning; `--shared-evidence "<explanation>"` flag required above threshold; explanation logged to `force-bypass.jsonl` with `sharedAtomWarning:true`

---

## New Issue Discovered During Investigation

**`pipeline.integration.test.ts` — 7 failing tests (NOT in handoff backlog)**:
- File: `packages/core/src/lifecycle/__tests__/pipeline.integration.test.ts`
- Failures: `passGate` crash (`gateName.split` on undefined), `Invalid stage: undefined` in `recordStageProgress`
- Pattern: test calls `passGate(epicId, gateName)` with `gateName=undefined` — looks like a test authoring issue, not a production code bug
- This test file was created in commits `56ad5a13a` and `f45ce1c82` (part of T001 type-error cleanup) which predates the handoff
- The failures are being routinely bypassed via owner-override ("pre-existing failures unrelated to T###")
- No task filed. Should be filed as a focused test-fix task — the production code (`lifecycle/index.ts:passGate`) has a legitimate defensive gap but the real fix is in the test asserting `gateName` is defined before calling `passGate`.

---

## Key File Paths

| Path | Item | Status |
|------|------|--------|
| `packages/cleo/src/dispatch/domains/memory.ts:1958` | P0 sweep routing — `'sweep'` in query[] only | Fix: add to mutate[] |
| `packages/cleo/src/dispatch/dispatcher.ts:188` | P1 Wave 5 setImmediate dialectic | Not upgraded to enqueueDerivation |
| `packages/core/src/sentient/reconcile-scheduler.ts` | P1 Wave 7 | File does not exist |
| `packages/core/src/store/nexus-schema.ts:530` | P1 sigil schema | No mental_model/representationJson columns |
| `packages/core/src/store/tasks-sqlite.ts` | P2 naming | RESOLVED — canonical CRUD file |
| `packages/core/src/store/conduit-schema.ts` | P3 split | RESOLVED — Drizzle defs separated |
| `.cleo/audit/force-bypass.jsonl` | Pump | 665 entries, 106 since handoff (3 days) |
| `packages/core/src/lifecycle/__tests__/pipeline.integration.test.ts` | NEW | 7 failing tests, not filed |
