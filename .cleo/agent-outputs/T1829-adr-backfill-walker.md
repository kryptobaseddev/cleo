# T1829 — ADR Backfill Walker Output

**Status**: COMPLETE
**Date**: 2026-05-05
**Task**: T1829
**Epic**: T1824

## Deliverables

- `packages/core/src/tools/adr-backfill-walker.ts` — new backfill walker script (760 LOC)
- `.cleo/agent-outputs/T1824-5-backfill-report.md` — full backfill report with row-by-row log

## Results

- 60 `brain_decisions` rows inserted with `adrNumber` + `adrPath` populated
- 4 collision-pair ADRs (051–054 from `docs/adr/`) skipped — HITL required
- ADR-033 and ADR-034 marked `superseded` by ADR-031 and ADR-032 respectively
- ADR-019 and ADR-042 detected as superseded from frontmatter
- Idempotent: re-run produces 60 `skipped-exists` entries, 0 inserts

## Commit

- Worktree commit: `f9b883391ebe324eacc9b962f2b178a2e15e65ff` (task/T1829)
- Merge commit: `a29610e704160d7377bfde67240819cf88dc36cc`
