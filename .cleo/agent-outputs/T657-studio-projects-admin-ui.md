# T657 — Studio /projects Admin UI

**Status**: complete
**Date**: 2026-04-15
**Task**: Studio /projects Admin UI — Index / Re-Index / Delete (modal) / Clean / Scan

## Summary

Upgraded the Studio `/projects` page into a full admin surface with per-row actions and toolbar operations.

## Files Created

### API Endpoints

- `packages/studio/src/routes/api/project/[id]/+server.ts` — DELETE endpoint, calls `cleo nexus projects remove <id> --json`
- `packages/studio/src/routes/api/project/[id]/index/+server.ts` — POST endpoint, calls `cleo nexus analyze <path> --json` for never-indexed projects
- `packages/studio/src/routes/api/project/[id]/reindex/+server.ts` — POST endpoint, same analyze command for re-indexing existing projects
- `packages/studio/src/routes/api/project/clean/+server.ts` — POST endpoint, calls `cleo nexus projects clean --json` with optional flags; defaults to dry-run unless `dryRun: false` is explicit
- `packages/studio/src/routes/api/project/scan/+server.ts` — POST endpoint, calls `cleo nexus projects scan --json` with optional roots/maxDepth/autoRegister flags

### Shared Utility

- `packages/studio/src/lib/server/spawn-cli.ts` — `runCleoCli(args)` utility using `child_process.spawn` (async, 60s timeout, captures stdout+stderr, parses JSON envelope)

### Svelte Components

- `packages/studio/src/lib/components/admin/DeleteConfirmModal.svelte` — type-to-confirm modal (must match project name exactly)
- `packages/studio/src/lib/components/admin/ScanModal.svelte` — roots/maxDepth/autoRegister form + inline results display
- `packages/studio/src/lib/components/admin/CleanModal.svelte` — filter toggles + Preview (dry-run) + Purge (requires typing "PURGE")

### Modified

- `packages/studio/src/routes/projects/+page.svelte` — upgraded with toolbar (Scan + Clean buttons), per-row Index/Re-Index/Delete actions, stale indicator, inline loading/success/error state; no full-page reload

### Tests

- `packages/studio/src/routes/api/project/__tests__/project-admin.test.ts` — 31 tests covering all 5 endpoints (CLI arg construction, dryRun defaults, error paths, flag mapping)

## Quality Gates

- biome check --write: passed (3 unsafe optional-chain fixes applied)
- build: clean (2.08s, no errors)
- tests: 174 passed (up from 143, +31 new tests)

## Key Design Decisions

1. All endpoints use `runCleoCli` (spawn-based) to avoid blocking the event loop on slow CLI commands
2. Clean endpoint always dry-runs by default — `dryRun: false` must be explicit
3. Purge confirmation requires typing literal "PURGE" (different from project deletion which requires the project name)
4. Delete removes the row from local reactive state immediately on success — no full page reload
5. Stale indicator (orange dot) shown when `lastIndexed > 7 days` ago
6. `listRegisteredProjects()` is called server-side in index/reindex to resolve the project path from the ID
