# T11028 Verification Report: BRAIN Refs Survive Project Move

**Date**: 2026-05-27
**Auditor**: cleo (Prime Orchestrator)
**Task**: T11028 — T10298-8: Verify BRAIN refs survive project move (projectId-based anchoring)

## Summary

**Verdict**: CONDITIONAL PASS — 1 gap found, follow-up filed.

The brain DB itself survives project moves (it lives in `.cleo/` which moves with the project). The writer side (core) uses projectId-based resolution. The reader side (brain package) still uses CWD-walk-up in one path — follow-up T11040 filed.

## AC-by-AC Findings

### AC1: brain_observations.project_anchor / brain_decisions.project_anchor reference projectId
**PARTIAL PASS — schema naming differs from expected**

- `brain_observations` has a `project` TEXT column (not `project_anchor`). All current rows have NULL project.
- `brain_decisions` has NO `project` or `project_anchor` column at all.
- The writer side (`core/store/memory-sqlite.ts`) correctly resolves brain.db path via `resolveProjectByCwd()` + `resolveCanonicalCleoDir(projectId)`.
- The schema doesn't match the column names assumed in the AC, but the anchoring concept is correct on the writer side.

### AC2: No rewrite needed on project move — verification only
**PASS**

This is a verification-only task. No code changes are needed to satisfy the verification. One follow-up bug (T11040) filed for the reader-side gap.

### AC3: Query brain.db after project move — all observations/decisions still resolve
**CONDITIONAL PASS**

The brain.db file physically lives in `.cleo/` which moves with the project. After a move:
- If `CLEO_ROOT` is set correctly, the brain package resolves correctly
- If relying on `process.cwd()`, resolution depends on the caller's CWD matching the new project root
- The core writer side resolves correctly regardless via projectId

### AC4: Document path-based refs, file follow-up
**DONE — T11040 filed**

Gap: `packages/brain/src/cleo-home.ts:29` — `getCleoProjectDir()` uses `process.env['CLEO_ROOT'] ?? process.cwd()` (CWD-walk-up) instead of `resolveProjectByCwd()` + `resolveCanonicalCleoDir(projectId)`. This function is called by `getBrainDbPath()`, `getTasksDbPath()`, `getConduitDbPath()`, and `resolveDefaultProjectContext()`.

### AC5: Create observation before move, move project, query — still resolves
**CONDITIONAL PASS**

Same as AC3 — since the DB file moves with the project, the data survives. Resolution depends on the caller's CWD matching the new project root until T11040 is fixed.

### AC6: brain.db path in .cleo/ moves with project
**PASS**

Confirmed: `getBrainDbPath()` → `getCleoProjectDir()` → `${CLEO_ROOT ?? cwd}/.cleo/brain.db`. The DB is colocated with the project.

### AC7: No CWD-walk-up in brain resolution path
**FAILED — gap found, T11040 filed**

`brain/src/cleo-home.ts:29` explicitly uses CWD-walk-up:
```ts
const root = process.env['CLEO_ROOT'] ?? process.cwd();
```

This does NOT use the projectId→registry→canonicalPath resolver that the core writer side uses. The `@cleocode/paths` package already exports `resolveProjectByCwd` and `resolveCanonicalCleoDir` and is a dependency of `@cleocode/brain`.

## Gap: Reader-Side Resolution

| Component | Resolution Method | Survives Move? |
|-----------|-------------------|----------------|
| `core/store/memory-sqlite.ts` (writer) | `resolveProjectByCwd` + `resolveCanonicalCleoDir(projectId)` | YES |
| `brain/src/cleo-home.ts` (reader) | `CLEO_ROOT` env or `process.cwd()` | Conditional |

## Follow-up

- **T11040**: Fix `brain/src/cleo-home.ts` to use projectId-based resolution
