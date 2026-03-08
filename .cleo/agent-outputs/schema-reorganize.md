# Schema Reorganization Refactor Summary

**Task**: T5650
**Date**: 2026-03-08
**Commit**: f7089c1e
**Branch**: main

---

## Files Renamed (git mv)

| Old path | New path |
|----------|----------|
| `src/store/schema.ts` | `src/store/tasks-schema.ts` |
| `drizzle.config.ts` | `drizzle-tasks.config.ts` |
| `dev/migrations/drizzle-tasks/` | `migrations/drizzle-tasks/` |
| `dev/migrations/drizzle-brain/` | `migrations/drizzle-brain/` |
| `dev/migrations/drizzle-nexus/` | `migrations/drizzle-nexus/` |

## Import Files Updated

Total source files updated: ~35 files containing import references to `schema.js`.

Two categories required extra attention beyond the initial `from '...' ` sed pass:
- Dynamic imports (`import('../store/schema.js')`) in: `src/core/repair.ts`, `src/core/validation/validate-ops.ts`, `src/core/audit-prune.ts`, `src/core/stats/index.ts`, `src/core/tasks/task-ops.ts`, `src/dispatch/engines/system-engine.ts`, `src/dispatch/middleware/audit.ts`, `src/core/lifecycle/__tests__/stage-record-provenance.integration.test.ts`, `src/mcp/__tests__/e2e/brain-operations.test.ts`, `src/mcp/__tests__/integration-setup.ts`, `src/mcp/__tests__/test-environment.ts`, `src/core/__tests__/audit-prune.test.ts`, `src/core/validation/schema-integrity.ts`, `src/store/__tests__/db-helpers.test.ts`, `src/store/__tests__/migration-safety.test.ts`, `src/store/__tests__/task-store.test.ts`, `src/core/system/__tests__/cleanup.test.ts`
- `vi.mock()` paths in: `src/dispatch/middleware/__tests__/audit.test.ts`

## drizzle-kit Check

| Config | Result |
|--------|--------|
| `drizzle-tasks.config.ts` | Generated 1 new migration (`20260308024513_oval_king_bedlam`) for pre-existing `token_usage` table drift — correct behavior, migration + snapshot both present |
| `drizzle-brain.config.ts` | PASS — No schema changes |
| `drizzle-nexus.config.ts` | PASS — No schema changes |

## Build Status

PASS — `npm run build` completed with zero errors.

## TypeScript Status

PASS — `npx tsc --noEmit` reported zero errors.

## Runtime Migration Paths Updated

| File | Old path segment | New path segment |
|------|-----------------|-----------------|
| `src/store/sqlite.ts` | `dev/migrations/drizzle-tasks` | `migrations/drizzle-tasks` |
| `src/store/brain-sqlite.ts` | `dev/migrations/drizzle-brain` | `migrations/drizzle-brain` |
| `src/store/nexus-sqlite.ts` | `dev/migrations/drizzle-nexus` | `migrations/drizzle-nexus` |

## package.json Scripts Updated

- `db:generate` now uses `--config drizzle-tasks.config.ts` explicitly (no more implicit default)
- `db:generate:custom` now uses `--config drizzle-tasks.config.ts`
- `db:studio` now uses `--config drizzle-tasks.config.ts`

## AGENTS.md Updates

- Schema table updated: file names, config names, migration paths
- drizzle-kit command examples updated
- Pre-commit hook rule reference updated
- Project structure listing updated (`dev/migrations/` → `migrations/`)
- Workflow docs updated to reference `tasks-schema.ts`

## Commit SHA

`f7089c1e`

## Push

PASS — pushed to `origin main` successfully.

## Issues Found

None blocking. One expected side effect: drizzle-kit detected pre-existing schema drift for the `token_usage` table (it existed in `tasks-schema.ts` but not in the previous snapshot chain). Generated migration `20260308024513_oval_king_bedlam` is correct and complete with its sibling `snapshot.json`.
