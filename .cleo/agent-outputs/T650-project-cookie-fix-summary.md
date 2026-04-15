# T650: Project Selection Cookie Fix

**Date**: 2026-04-15
**Status**: complete
**Task**: BUG CRITICAL — Project selection cookie ignored; all pages always read cwd .cleo/ paths.

## Root Cause

`packages/studio/src/lib/server/db/connections.ts` used module-level singleton caches (`let brainDb`, `let tasksDb`, `let conduitDb`) that were populated once per process lifetime via `getBrainDbPath()` / `getTasksDbPath()` / `getConduitDbPath()` from cleo-home.ts. These helpers resolve paths from `process.cwd()` — completely ignoring the `cleo_project_id` cookie set by `/api/project/switch`.

## Fix

### (1) app.d.ts (NEW)
`packages/studio/src/app.d.ts` — declares `App.Locals.projectCtx: ProjectContext` so the type is available throughout the SvelteKit app.

### (2) hooks.server.ts (NEW)
`packages/studio/src/hooks.server.ts` — reads `cleo_project_id` cookie on every request via `getActiveProjectId(event.cookies)`, resolves context via `resolveProjectContext(id)`, falls back to `resolveDefaultProjectContext()` when cookie is absent or invalid. Sets `event.locals.projectCtx`.

### (3) connections.ts (REWRITTEN)
- `getNexusDb()` and `getSignaldockDb()` retain module-level caches (global DBs, path never changes per machine).
- `getBrainDb(ctx)`, `getTasksDb(ctx)`, `getConduitDb(ctx)` — now accept `ProjectContext` and open a fresh `DatabaseSync` per call using `ctx.brainDbPath` / `ctx.tasksDbPath` / derived conduit path. No cross-request caching.
- `getDbStatus(ctx)` — now accepts `ProjectContext`, reports per-project paths.

### (4) 20+ callers updated
All page server loads and API endpoints now destructure `locals` from the event and pass `locals.projectCtx` to the per-project getters.

Files updated:
- routes/+page.server.ts
- routes/brain/+page.server.ts
- routes/brain/overview/+page.server.ts
- routes/tasks/+page.server.ts
- routes/tasks/pipeline/+page.server.ts
- routes/tasks/sessions/+page.server.ts
- routes/tasks/tree/[epicId]/+page.server.ts
- routes/tasks/[id]/+page.server.ts
- routes/api/brain/decisions/+server.ts
- routes/api/brain/graph/+server.ts
- routes/api/brain/observations/+server.ts
- routes/api/brain/quality/+server.ts
- routes/api/health/+server.ts
- routes/api/living-brain/+server.ts
- routes/api/living-brain/node/[id]/+server.ts
- routes/api/living-brain/substrate/[name]/+server.ts
- routes/api/living-brain/stream/+server.ts
- routes/api/tasks/+server.ts
- routes/api/tasks/events/+server.ts
- routes/api/tasks/pipeline/+server.ts
- routes/api/tasks/sessions/+server.ts
- routes/api/tasks/tree/[epicId]/+server.ts
- routes/api/tasks/[id]/+server.ts

### (5) Living Brain adapters updated
- adapters/brain.ts — uses `options.projectCtx ?? resolveDefaultProjectContext()` before calling `getBrainDb(ctx)`.
- adapters/tasks.ts — same pattern for `getTasksDb(ctx)`.
- adapters/conduit.ts — same pattern for `getConduitDb(ctx)`.
- types.ts — `LBQueryOptions.projectCtx?: ProjectContext` added so `getAllSubstrates()` can thread context to adapters.

### (6) Tests
- NEW: `src/lib/server/__tests__/project-context-propagation.test.ts` (4 tests) — verifies hook handler sets correct context from cookie.
- UPDATED: `routes/api/living-brain/stream/__tests__/stream.test.ts` — updated to pass `locals.projectCtx` fixture to handler.

## Quality Gates
- `pnpm biome check packages/studio` — PASS (no fixes)
- `pnpm --filter @cleocode/studio run build` — PASS
- `pnpm --filter @cleocode/studio run test` — 120/120 PASS

## Verification Note
Manual verification (curl with/without cookie against a second registered project) requires a second registered project in nexus.db. The code path is correct: the hook resolves a different `ProjectContext` per cookie value, and all callers use that context for DB resolution. Cannot demonstrate data difference without a second project, documented as follow-up.
