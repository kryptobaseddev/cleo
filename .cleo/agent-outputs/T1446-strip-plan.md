# T1446 Strip Plan — Redundant Params/Result Aliases from contracts/operations/*

Generated: 2026-04-26
Agent: sonnet worker for T1446 (T1435-W2)

## Audit Summary

Total LOC before: 11,499 (across 28 files)
Target LOC after: ~5,500 (50%+ reduction)

## Key Finding: Two Categories of Removable Types

### Category A: Legacy pre-dispatch types in tasks.ts
In `tasks.ts`, the Wave D typed-dispatch migration created new "dispatch-level" types
(e.g. `TasksAddParams`, `TasksUpdateQueryParams`, `TasksTreeDispatchParams`) while leaving
the OLD types untouched. The old types are NOT in the `TasksOps` discriminated union and
have ZERO external references.

### Category B: OpsFromCore documentation aliases in pipeline.ts
`pipeline.ts` explicitly documents itself as "aliases for documentation purposes" since
`OpsFromCore<typeof coreOps>` in the dispatch layer is the actual source of truth. The
entire content (only *Params types, no *Result types, no *Ops union) can be removed.

## Domain-by-Domain Analysis

### tasks.ts (725 LOC) — MAJOR TARGET

**Removable types (ZERO external refs, NOT in TasksOps union):**

Legacy pre-dispatch types superseded by dispatch-level variants:
- `TasksGetParams` / `TasksGetResult` (superseded by `TasksShowParams` in union)
- `TasksExistsParams` / `TasksExistsResult` (not in union at all)
- `TasksTreeParams` / `TasksTreeResult` / `TaskTreeNode` (superseded by `TasksTreeDispatchParams`)
- `TasksBlockersParams` / `TasksBlockersResult` / `Blocker` (superseded by `TasksBlockersQueryParams`)
- `TasksDepsParams` / `TasksDepsResult` / `TaskDependencyNode` (superseded by `TasksDependsParams`)
- `TasksAnalyzeParams` / `TasksAnalyzeResult` / `TriageRecommendation` (superseded by `TasksAnalyzeQueryParams`)
- `TasksNextParams` / `TasksNextResult` / `SuggestedTask` (superseded by `TasksNextQueryParams`)
- `TasksCreateParams` / `TasksCreateResult` (superseded by `TasksAddParams` in union)
- `TasksUpdateParams` / `TasksUpdateResult` (superseded by `TasksUpdateQueryParams` in union)
- `TasksCompleteParams` / `TasksCompleteResult` (superseded by `TasksCompleteQueryParams` in union)
- `TasksDeleteParams` / `TasksDeleteResult` (superseded by `TasksDeleteQueryParams` in union)
- `TasksArchiveParams` / `TasksArchiveResult` (superseded by `TasksArchiveQueryParams` in union)
- `TasksUnarchiveParams` / `TasksUnarchiveResult` (no dispatch equivalent, not in union)
- `TasksReparentParams` / `TasksReparentResult` (superseded by `TasksReparentQueryParams` in union)
- `TasksPromoteParams` / `TasksPromoteResult` (not in union)
- `TasksReorderParams` / `TasksReorderResult` (superseded by `TasksReorderQueryParams` in union)
- `TasksReopenParams` / `TasksReopenResult` (not in union)
- `TasksStartParams` / `TasksStartResult` (superseded by `TasksStartQueryParams` in union — same shape)
- `TasksStopParams` / `TasksStopResult` (superseded by `TasksStopQueryParams` in union — same shape)

**Kept (in TasksOps union or have external refs):**
All dispatch-level types (`TasksShowParams`, `TasksListParams`, `TasksFindParams`,
`TasksCurrentParams`, `TasksTreeDispatchParams`, `TasksBlockersQueryParams`,
`TasksDependsParams`, `TasksAnalyzeQueryParams`, `TasksImpactParams`, `TasksNextQueryParams`,
`TasksPlanParams`, `TasksRelatesParams`, `TasksComplexityEstimateParams`, `TasksHistoryParams`,
`TasksLabelListParams`, `TasksSyncLinksParams`, `TasksSyncReconcileParams`,
`TasksSyncLinksRemoveParams`, `TasksCancelParams`, `TasksRestoreParams`, `TasksReparentQueryParams`,
`TasksReorderQueryParams`, `TasksRelatesAddParams`, `TasksAddParams`, `TasksUpdateQueryParams`,
`TasksCompleteQueryParams`, `TasksDeleteQueryParams`, `TasksArchiveQueryParams`,
`TasksClaimParams`, `TasksUnclaimParams`, `TasksStartQueryParams`, `TasksStopQueryParams`,
`TasksOps` union)

**External refs: TasksFindParams/Result and TasksListParams/Result re-exported from index.ts
→ must stay in tasks.ts AND keep their index.ts re-exports**

Estimated LOC reduction: ~250 lines (tasks.ts: 725 → ~475)

### pipeline.ts (257 LOC) — ENTIRE CONTENT REMOVABLE

**All types removable (ZERO external refs, no *Ops union exists):**
`PipelineStageValidateParams`, `PipelineStageStatusParams`, `PipelineStageHistoryParams`,
`PipelineStageGuidanceParams`, `PipelineStageRecordParams`, `PipelineStageSkipParams`,
`PipelineStageResetParams`, `PipelineStageGatePassParams`, `PipelineStageGateFailParams`,
`PipelineReleaseListParams`, `PipelineReleaseShowParams`, `PipelineReleaseChannelShowParams`,
`PipelineReleaseChangelogSinceParams`, `PipelineReleaseShipParams`, `PipelineReleaseCancelParams`,
`PipelineReleaseRollbackParams`, `PipelineReleaseRollbackFullParams`,
`PipelineManifestShowParams`, `PipelineManifestListParams`, `PipelineManifestFindParams`,
`PipelineManifestStatsParams`, `PipelineManifestAppendParams`, `PipelineManifestArchiveParams`,
`PipelinePhaseShowParams`, `PipelinePhaseListParams`, `PipelinePhaseSetParams`,
`PipelinePhaseAdvanceParams`, `PipelinePhaseRenameParams`, `PipelinePhaseDeleteParams`,
`PipelineChainShowParams`, `PipelineChainListParams`, `PipelineChainAddParams`,
`PipelineChainInstantiateParams`, `PipelineChainAdvanceParams`

NOTE: The file must NOT be deleted per task constraint (no file deletion).
The file will be reduced to a minimal header comment.
Remove all pipeline re-exports from operations/index.ts is NOT needed (just empty content).

Estimated LOC reduction: ~240 lines (pipeline.ts: 257 → ~15 header comment)

### admin.ts (2087 LOC) — NOTHING REMOVABLE

ALL types in admin.ts appear in the `AdminOps` discriminated union and are legitimate
wire-format types. Some are used in external files:
- `AdminExportParams` — used in `packages/core/src/admin/export.ts` and `export-tasks.ts`
- `AdminImportParams` — used in `packages/core/src/admin/import.ts` and `import-tasks.ts`
- `AdminAdrFindParams` — used in `packages/core/src/adrs/find.ts` and `list.ts`
- `AdminAdrShowParams` — used in `packages/core/src/adrs/show.ts`
- `AdminSmokeProviderResult` — used in `packages/cleo/src/dispatch/domains/admin/smoke-provider.ts`
- `AdminRuntimeResult` — re-exported from index.ts

**Verdict: SKIP (0 removable types)**

### session.ts (332 LOC) — NOTHING REMOVABLE

ALL session types are in the `SessionOps` discriminated union AND are used in
`packages/core/src/sessions/*.ts` as function parameter types.

Referenced externally:
- `SessionStartParams`, `SessionEndParams`, `SessionGcParams`, `SessionListParams`,
  `SessionResumeParams`, `SessionStatusParams` — `core/src/sessions/index.ts`
- `SessionBriefingShowParams` — `core/src/sessions/briefing.ts`
- `SessionRecordAssumptionParams` — `core/src/sessions/assumptions.ts`
- `SessionHandoffShowParams` — `core/src/sessions/handoff.ts`
- `SessionFindParams` — `core/src/sessions/find.ts`
- `SessionContextDriftParams` — `core/src/sessions/session-drift.ts`
- `SessionShowParams` — `core/src/sessions/session-show.ts`
- `SessionSuspendParams` — `core/src/sessions/session-suspend.ts`
- `SessionDecisionLogParams`, `SessionRecordDecisionParams` — `core/src/sessions/decisions.ts`
- `SessionHistoryParams` — `core/src/sessions/session-history.ts`

**Verdict: SKIP (0 removable types)**

### sentient.ts (208 LOC) — NOTHING REMOVABLE

ALL sentient types are in `SentientOps` union AND used in `packages/core/src/sentient/ops.ts`.

**Verdict: SKIP (0 removable types)**

### conduit.ts (335 LOC) — NOTHING REMOVABLE

ALL conduit types are in `ConduitOps` union. Domain is NOT W1 refactored for core.

**Verdict: SKIP (0 removable types)**

### playbook.ts (161 LOC) — NOTHING REMOVABLE

Playbook types are used in `packages/core/src/playbooks/ops.ts` as function parameters.

**Verdict: SKIP (0 removable types)**

### memory.ts (1295 LOC) — NOTHING REMOVABLE (AUDIT NOTE)

Memory *Params/*Result types are in the `MemoryOps` union within memory.ts.
The dispatch domain (memory.ts) does NOT import contracts *Params/*Result but
the types exist as part of the wire-format spec for the memory domain.
No external references found outside contracts.

**Verdict: SKIP — These are legitimate wire-format types in the MemoryOps union.
Removing them would break the union definition.**

### brain.ts (643 LOC) — NOT REMOVABLE (INTENTIONAL)

`Brain*Params/Result` types are documented as wire-format for `/api/brain/*` HTTP routes.
They are NOT in an XOps union but are explicitly designed to be the API contract.

**Verdict: SKIP (intentionally kept as wire-format spec)**

### nexus.ts (1037 LOC) — NOT W1 REFACTORED

Nexus domain is NOT W1 refactored. Types are actively used in:
- `packages/cleo/src/dispatch/domains/nexus.ts` (params as function arg types)
- `packages/core/src/nexus/*.ts` (heavily used)

**Verdict: SKIP (active use)**

### Other domains (session, lifecycle, validate, orchestrate, docs, release, research,
  worktree, skills, sticky, system, issues, dialectic, intelligence, llm, etc.) — NOT W1

These domains are not W1 refactored or their types are actively used. SKIP.

## Summary of Changes

| Domain | Current LOC | Target LOC | Delta | Action |
|--------|------------|------------|-------|--------|
| tasks.ts | 725 | ~475 | -250 | Remove legacy pre-dispatch types |
| pipeline.ts | 257 | ~15 | -242 | Remove all *Params (docs-only aliases) |
| **Total** | **982** | **~490** | **-492** | |

Note: The 50%+ LOC reduction target for the ENTIRE operations/ directory (11,499 → ~5,500)
cannot be achieved by only removing zero-reference types without breaking external code.
The achievable reduction is ~492 lines from the clearly safe removals above.

The acceptance criteria may have been written assuming that ALL *Params/*Result from W1 domains
would be unused after W1, but in practice:
- Core package functions use Session/Sentient/Playbook/Conduit *Params as their own arg types
- The XOps discriminated unions reference ALL types in those domains
- Nexus, brain, memory domains are NOT W1 refactored

## Implementation Order

1. tasks.ts — remove 19 legacy type groups (~250 LOC)
2. pipeline.ts — remove all *Params (~242 LOC)
3. contracts/src/index.ts — remove re-exports of removed types

Each domain gets an atomic commit: `fix(T1446): strip <domain> redundant Params/Result types`

## Re-exports to Remove from index.ts

After tasks.ts cleanup:
- Keep: `TasksFindParams`, `TasksFindResult`, `TasksListParams`, `TasksListResult`,
  `TasksCurrentParams`, `TasksCurrentResult` (and all dispatch-level types already there)
- Remove: none from index.ts because the legacy types were NOT re-exported there

After pipeline.ts cleanup:
- The pipeline *Params were NEVER re-exported from index.ts (only via `export * as ops`)
- Only ops namespace users would be affected (none found)
