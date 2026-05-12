# Wave B Structural Fixes — T1629 Research Output

**Date**: 2026-05-01
**Task**: T1629 — T-HR-B: Wave B Structural fixes
**Status**: Partial (T1563 close blocked by actual child state)

## Key Findings

1. **T1467 REOPENED**: Epic prematurely closed with 2 pending children (T1491: thin fat CLI, T1495: pipeline contract types decision). Both are genuine work items preserved as ready-to-work.

2. **T1603 REOPENED**: Epic prematurely closed with 3 pending children (T1619: commit-msg hook fix, T1620: hotfix CHANGELOG fix, T1621: ripgrep fallback). All V3 follow-up tasks are genuine bugs filed after close.

3. **T1622 COMPLETED**: Doctrine cleanup sub-epic (3 done + 1 cancelled = effective complete). Completed via owner-override with waiver. T1623, T1624, T1625 all had real evidence atoms (biome ci, tests, commit hashes).

4. **T1563 NOT CLOSEABLE**: H1 audit reported 4/4 children done, but actual DB shows 7 children with 3 still pending (T1493, T1491, T1495). These were added to T1563 after the H1 snapshot was taken. Close deferred.

5. **T1232 STAGE DRIFT PARTIALLY CORRECTED**: pipelineStage field cannot be moved backward (system enforces forward-only). Used `cleo lifecycle reset T1232 release` to reset the lifecycle stage. Added note documenting the drift. The task field shows `release` but lifecycle tracking reset to `pending`.

6. **LOOM STATUS**: All 9 Type-E epics checked. T631 is the only epic with "epic has no children" from orchestrate ready — it has no decomposition. T889, T911, T942, T1232, T1055, T1212 all have ready tasks. No `cleo orchestrate start` was needed (LOOM is already initialized for epics with children).

7. **TYPE-E STALE EPICS**: All 9 confirmed genuine work — none cancelled. Notes added to each. Memory observation recorded. Priority order: T942 (critical sentient redesign, 8 ready tasks) > T1055 (nexus P1, 5 ready) > T911 (sandbox harness, 4 ready) > T1212 (migration lint, 3 ready) > T889 > T1007 > T1042 > T631.

## Needs Follow-up

- T1563: Cannot close until T1493, T1491, T1495 are completed
- T1232: The `pipelineStage` field stuck at `release` — forward-only constraint blocks correction. Owner should either accept status quo or use DB-level correction
- T631: Needs decomposition before any work can start
- T1007: Blocked on T991 Wave 1 — needs unblocking assessment
- T1042: Needs decomposition into research subtasks

## Actions Taken

| Action | Task | Result |
|--------|------|--------|
| REOPEN | T1467 | Done — status=pending |
| INVESTIGATE + keep ready | T1491 | Confirmed genuine, pending |
| INVESTIGATE + keep ready | T1495 | Confirmed genuine, pending |
| REOPEN | T1603 | Done — status=pending |
| INVESTIGATE + keep ready | T1619 | Confirmed genuine (commit-msg hook), pending |
| INVESTIGATE + keep ready | T1620 | Confirmed genuine (CHANGELOG auto-add), pending |
| INVESTIGATE + keep ready | T1621 | Confirmed genuine (ripgrep fallback), pending |
| NOT DONE (blocked) | T1563 close | 3 pending children, cannot close |
| DONE | T1622 close | Completed with owner-override waiver |
| STAGE LIFECYCLE RESET | T1232 | release stage reset to pending via lifecycle reset |
| NOTE ADDED | T1232 | Documents stage drift for owner review |
| LOOM CHECK | T631 | No children — no LOOM to init |
| NOTES ADDED | All 9 Type-E | Hygiene notes on each epic |
| MEMORY OBSERVE | Type-E summary | Captured in BRAIN |
| MEMORY OBSERVE | T1563 discrepancy | Captured in BRAIN |
