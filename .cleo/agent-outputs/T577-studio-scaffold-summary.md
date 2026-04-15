# T577: CLEO Studio Scaffold — Implementation Summary

**Date**: 2026-04-14
**Status**: complete
**Task**: CLEO Studio scaffold — unified web portal for T578 + T579 + T580

---

## Deliverables

### Package Created: `packages/studio/`

| File | Purpose |
|------|---------|
| `package.json` | `@cleocode/studio` v2026.4.47, SvelteKit + Hono + adapter-node |
| `svelte.config.js` | adapter-node → `build/` output |
| `vite.config.ts` | SvelteKit via `@sveltejs/kit/vite`, port 3456 |
| `tsconfig.json` | Extends `.svelte-kit/tsconfig.json`, bundler resolution |
| `src/app.html` | HTML shell |
| `src/lib/server/cleo-home.ts` | Path resolution: CLEO_HOME, CLEO_ROOT, all three db paths |
| `src/lib/server/db/connections.ts` | Lazy cached read-only `node:sqlite` connections (nexus, brain, tasks) |
| `src/routes/+layout.svelte` | Navigation bar: Nexus / Brain / Tasks |
| `src/routes/+page.svelte` | Home with portal cards and live stat previews |
| `src/routes/+page.server.ts` | Server load: fetches counts from all three DBs |
| `src/routes/nexus/+page.svelte` | "NEXUS View coming soon" placeholder |
| `src/routes/nexus/+page.server.ts` | Loads live nexus.db stats |
| `src/routes/brain/+page.svelte` | "BRAIN View coming soon" placeholder |
| `src/routes/brain/+page.server.ts` | Loads live brain.db stats |
| `src/routes/tasks/+page.svelte` | "TASKS View coming soon" placeholder |
| `src/routes/tasks/+page.server.ts` | Loads live tasks.db stats |
| `src/routes/api/health/+server.ts` | `GET /api/health` → JSON with db availability |

### Modified: `packages/cleo/src/cli/commands/web.ts`

- `distServerDir` now points to `packages/studio/build/` (SvelteKit adapter-node output)
- Uses `pnpm --filter @cleocode/studio run build` for auto-build fallback
- Passes `HOST`, `PORT`, `CLEO_ROOT` env vars to the studio server process
- `CLEO_STUDIO_DIR` env var override for testing/custom installs

### Workspace

`pnpm-workspace.yaml` already uses `packages/*` glob — no change needed. Studio is automatically included.

---

## Architecture Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Frontend | SvelteKit 2 + Svelte 5 | Orchestrator mandate (override of T578 React proposal) |
| Server | SvelteKit adapter-node | Produces standalone `node build/index.js` server |
| DB access | `node:sqlite` (built-in) | Matches rest of monorepo; no extra native deps |
| DB connections | Lazy + cached | No overhead if DB absent; single open per process |
| Port | 3456 | Matches `cleo web start` default; consistent with existing `web.ts` |
| Paths | `src/lib/server/cleo-home.ts` | Independent path resolution without `@cleocode/core` dep |

---

## Acceptance Test Results

```
GET /          PASS — returns CLEO Studio HTML
GET /nexus     PASS — returns "NEXUS View coming soon"
GET /brain     PASS — returns "BRAIN View coming soon"
GET /tasks     PASS — returns "TASKS View coming soon"
GET /api/health PASS — { ok: true, nexus: available, brain: available, tasks: available }
```

## Quality Gates

- `pnpm biome check` — clean (0 errors after auto-fix)
- `pnpm --filter @cleocode/studio run build` — success (adapter-node output in `build/`)
- `pnpm run test` — 409 test files, 7357 passed, 0 new failures
- TypeScript — `tsc --noEmit --skipLibCheck` on cleo package — 0 errors

---

## Handoff Notes for T578 / T579 / T580 Workers

- T578 (Nexus): Implement `/nexus/*` routes in `src/routes/nexus/`. DB helper: `getNexusDb()` from `$lib/server/db/connections.js`. Schema: `nexus_nodes`, `nexus_relations` (see T578-nexus-portal-design.md).
- T579 (Brain): Implement `/brain/*` routes. DB helper: `getBrainDb()`. Schema: `brain_page_nodes`, `brain_observations`, `brain_decisions`, `brain_patterns`, `brain_learnings`.
- T580 (Tasks): Implement `/tasks/*` routes. DB helper: `getTasksDb()`. Schema: `tasks`, `sessions`, lifecycle tables.
- Shared lib: Add D3/graphology utilities to `src/lib/` per T579 W6 spec.
- The API layer can be pure SvelteKit server routes (`+server.ts`) — no separate Hono server needed at this stage.
