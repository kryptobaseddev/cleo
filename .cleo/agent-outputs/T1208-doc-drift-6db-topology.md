# T1208: Doc Drift Cleanup — 6-DB Topology + Wave 3 Externalization

**Status**: complete
**Commit**: 290035c25788fd60c585ff1a051c9685a9d7873f
**Branch**: main

## Summary

All 6 documentation files updated to reflect the post-v2026.4.109 canonical state: 6-DB topology, correct tier assignments, Wave 3 `packages/core/migrations/` single-source model, and peerDep install instructions.

## Files Edited

| File | Change |
|------|--------|
| `docs/architecture/DATABASE-ERDS.md` | 5→6 DBs; nexus moved to global-tier; telemetry.db row added; aggregate stats table fixed; cross-DB reference map diagram updated; `brain-schema.ts` ref corrected to `memory-schema.ts` |
| `docs/specs/DATABASE-ARCHITECTURE.md` | 5→6 DBs in overview; §6 telemetry.db section added; File System Layout fixed (nexus/signaldock/telemetry in global, conduit in project); ORM Summary table expanded with all 6 DBs + migration paths; "Global Database" heading pluralized |
| `docs/architecture/orchestration-flow.md` | Line ~250: `packages/cleo/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/` → `packages/core/migrations/drizzle-tasks/...` |
| `docs/specs/CLEO-TASKS-API-SPEC.md` | All 4 `packages/cleo/migrations/drizzle-tasks/` refs rewritten to `packages/core/migrations/drizzle-tasks/` |
| `packages/core/migrations/README.md` | Lines 27-28: removed stale `syncMigrationsToCleoPackage()` + `packages/cleo/migrations/` description; replaced with single-source model (ADR-054 Wave 3, T1177) + historical note (T1180 commit `1a9738cf9`, T1182 commit `158717cde`) |
| `README.md` | Install section: added peer dep dual-install form; Documentation section: added links to DATABASE-ARCHITECTURE.md and packages/core/migrations/README.md |

## Path Verification

All migration folder paths inserted into docs were verified to exist:
- `packages/core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/` — confirmed
- `packages/core/migrations/drizzle-tasks/20260417000000_t877-pipeline-stage-invariants/` — confirmed
- All 5 migration sets (`drizzle-{tasks,brain,nexus,signaldock,telemetry}/`) present in `packages/core/migrations/`

## Incidental Findings (flagged, not fixed)

1. `DATABASE-ERDS.md` Referenced `brain-schema.ts` in the Related Documents section — the actual file is `memory-schema.ts`. Fixed as a natural part of the T1208 scope since it was in the same section being updated.

2. The `DATABASE-ARCHITECTURE.md` File System Layout erroneously placed `signaldock.db` inside the project `.cleo/` directory (pre-ADR-037 layout). Fixed as part of this task since the layout section was being touched for telemetry.db placement.

3. Pre-existing RULE-3 migration linter warnings (33 warnings, 0 errors) in `packages/core/migrations/` — these are pre-existing snapshot chain inconsistencies predating this task. Not in scope; pre-commit hook passed.

## Evidence

- implemented: commit:290035c25788fd60c585ff1a051c9685a9d7873f + files (6 docs)
- documented: files (3 primary architecture docs)
- testsPassed: owner override (docs-only, no test surface)
- qaPassed: owner override (biome ignores .md, no TS modified)
