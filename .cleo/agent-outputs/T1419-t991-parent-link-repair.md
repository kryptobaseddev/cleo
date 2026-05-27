# T1419 — T991 BRAIN Integrity Parent-Child DB Link Repair

**Task**: T1419  
**Status**: complete  
**Date**: 2026-04-25  
**Epic**: T1415 (T1216 Remediation Queue)

## Summary

Repaired missing parent-child links for the T991 BRAIN Integrity epic. All 8 child tasks (T992-T999) had `parentId=null` despite shipping real work in v2026.4.98 (release commit `18128e3cec`). The Council 2026-04-24 audit (T1227) confirmed `schema-artifact-not-work-defect` — all work shipped, only the DB relationship was missing.

## Pre-Repair State

- T992-T999: `parentId=null` (all archived, status=archived)
- `cleo show T991` → `childRollup: {total: 0, done: 0}`
- `cleo list --parent T991` → 0 results

## Post-Repair State

- T992-T999: `parentId=T991` (confirmed via `cleo show <id>` for each)
- `cleo list --parent T991 --status archived` → 8 children returned

## Files Created

- `packages/cleo/src/migrations/2026-04-25-t991-parent-link-repair.ts` — typed migration module exporting `PARENT_EPIC_ID`, `CHILD_TASK_IDS`, `GIT_EVIDENCE` anchors, and `RepairResult`/`MigrationSummary` interfaces
- `scripts/repair-t991-parent-links.mjs` — idempotent runnable script using `cleo update --parent T991` for each child (dry-run mode + verbose mode + post-repair verification)

## Commit

`02cc7844cdebe3928b3c57d3f1fa26a0a85b201f` on branch `task/T1419`

## Git Evidence Used

- Release commit: `18128e3cec6b61f7486c136fb9a2cd956c51b37c` (v2026.4.98)
- Individual child commits: T993-T999 all verified in git history
- T992: documented in CHANGELOG under v2026.4.98 (no standalone commit — work bundled in release)

## Idempotency Verified

Script re-run after repair: all 8 children SKIP (already parentId=T991), 0 repaired, 0 failed.

## Key Findings

- `cleo list --parent T991` (default) excludes archived tasks — must use `--status archived` to see repaired children
- `cleo update --parent <epicId>` is the canonical write path per AGENTS.md
- The worktree commit is not reachable from main HEAD — orchestrator cherry-picks post-complete per ADR-055
