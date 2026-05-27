# T578: NEXUS Web Portal — Design Specification

**Date**: 2026-04-14
**Status**: Design complete, ready for decomposition
**Task**: T578 — Build NEXUS Web Portal

---

## Research Findings

**GitNexus OSS web UI** (`/mnt/projects/gitnexus/gitnexus-web/`): React + Vite + TypeScript + Tailwind, uses `sigma` + `graphology` for graph rendering, `@tailwindcss/vite` plugin, `react-zoom-pan-pinch` for pan/zoom. Its architecture is a drop-zone SPA with an LLM chat panel. We adopt its graph library choices but NOT its SPA structure or LLM coupling.

**nexus.db schema** (`~/.local/share/cleo/nexus.db`):
- `nexus_nodes`: 11,324 nodes — kinds: function (4030), file (2580), interface (2129), method (748), type_alias (632), folder (443), community (259), class (116), process (75)
- `nexus_relations`: 17,802 edges — types: calls (8932), member_of (4033), contains (2990), has_method (748), imports (186), extends (88)
- `project_registry`: project_id, project_path, name, health_status, task_count, labels_json
- `nexus_nodes.community_id`: 259 distinct community IDs (cluster membership)

**Existing nexus CLI ops**: `nexus graph`, `nexus status`, `nexus list`, `nexus show`, `nexus resolve`, `nexus deps`, `nexus search`, `nexus path.show`, `nexus blockers.show` — all available as structured JSON output via `cleo nexus <op>`.

**Monorepo infra**: pnpm workspace, Vite 8, Vitest 4, TypeScript strict ESM. No existing HTTP server packages. `cleo web` command exists (manages something else — not nexus).

---

## Architecture

### Tech Stack

**React + Vite + TypeScript** — matches GitNexus OSS exactly, fits monorepo conventions (Vite 8 already a root devDep), zero new build tooling. Tailwind CSS via `@tailwindcss/vite`.

**Graph rendering: `sigma` + `graphology`** — GitNexus already uses this stack. `sigma` is a dedicated graph renderer (WebGL + Canvas) that handles 10K+ nodes without DOM thrashing. `graphology` provides the in-memory graph model with layout algorithms. This is the only production-tested option for this scale in the reference project.

**API layer: Hono** — lightweight, typed HTTP framework, ESM-native, runs in Node.js. Serves two responsibilities: (1) static files from the built React app, (2) a JSON REST API that reads nexus.db via existing `@cleocode/core` and `@cleocode/nexus` functions. No subprocess shelling needed — direct function calls.

### Package Location

`packages/nexus-web/` — new standalone package `@cleocode/nexus-web`.

Rationale: The portal is a deployable artifact with its own build output (Vite SPA + Hono server). Colocating inside `packages/nexus/web/` would pollute the library package with a bundled SPA and a devserver. A separate package keeps concerns clean and allows independent versioning.

### Data Access

The Hono server imports `@cleocode/core` functions directly (same process, same SQLite connection). No subprocess. The React SPA fetches from `http://localhost:7777/api/*`.

API responses are paginated and projection-limited — the SPA never requests all 11K nodes at once (see performance strategy below).

---

## Pages / Routes

### `/` — Project Registry

Lists all entries from `project_registry`. Shows: name, path, health_status, task_count, last_seen. Link to `/project/:id`.

### `/project/:id` — Project Overview

Top stats: node count by kind, relation count by type, community count. Lists community clusters as cards with member counts. Entry point symbols listed. Links to `/project/:id/graph` and `/project/:id/symbol/:name`.

### `/project/:id/graph` — Interactive Symbol Graph

Sigma canvas rendering the symbol graph. Default view: community-level macro graph (259 community nodes, edges aggregated by inter-community call counts). Clicking a community node drills in to show its member symbols as a subgraph. Supports pan, zoom, node selection.

### `/project/:id/symbol/:name` — Symbol Detail

Shows: kind, file_path, line range, doc_summary, parameters, return_type. Two columns: callers (upstream `calls` relations) and callees (downstream `calls` relations). Impact tier badges (d=1 WILL BREAK, d=2 LIKELY AFFECTED, d=3 MAY NEED TESTING). Back link to graph with that node highlighted.

---

## Graph Rendering — Performance Strategy

11K nodes cannot be rendered at once in any browser. Three-tier strategy:

1. **Macro view (default)**: Render community nodes only (259 nodes, ~500 aggregated edges). Fast.
2. **Community drill-down**: On community click, fetch that community's members (~40–100 nodes average). Render as subgraph overlay. Replace macro view or panel in.
3. **Symbol focus**: From symbol detail page, render a 2-hop ego network (target node + direct callers + direct callees, max ~50 nodes). This is the most common interactive use case.

Layout: `graphology-layout-forceatlas2` with `graphology-layout-noverlap` pass for label spacing — same as GitNexus.

Node color encoding: kind (function=blue, interface=green, file=gray, class=orange, etc.). Edge color: type (calls=red, imports=purple, extends=teal).

---

## CLI Integration

Add `serve` operation to the existing `NexusHandler` in `packages/cleo/src/dispatch/domains/nexus.ts`.

```
cleo nexus serve [--port 7777] [--open]
```

The `serve` operation spawns the Hono server from `@cleocode/nexus-web/server.js`. It reads the global nexus.db path from `getCleoHome()`. The `--open` flag opens the browser after the server is ready. The command stays in foreground (like `vite dev`) and handles SIGINT for clean shutdown.

No new CLI commands needed — `nexus serve` fits naturally in the existing `nexus` domain as a `mutate` operation.

---

## Worker Tasks (Build Order)

### T578-W1: Package scaffold + Hono API server

**Files to create:**
- `packages/nexus-web/package.json`
- `packages/nexus-web/tsconfig.json`
- `packages/nexus-web/src/server.ts` — Hono app with 5 routes:
  - `GET /api/projects` — project_registry list
  - `GET /api/projects/:id/stats` — node/relation counts by kind/type
  - `GET /api/projects/:id/communities` — community nodes + member counts
  - `GET /api/projects/:id/graph/macro` — community-level graph (nodes + edges JSON)
  - `GET /api/projects/:id/graph/community/:communityId` — member subgraph
  - `GET /api/projects/:id/symbol/:name` — node detail + caller/callee lists (paginated)
- `packages/nexus-web/src/db.ts` — thin read-only accessor using `better-sqlite3` directly against nexus.db path

**Acceptance**: `pnpm --filter @cleocode/nexus-web start` boots server at port 7777 and all 6 API routes return valid JSON.

**Dependencies**: None (foundational).

### T578-W2: React SPA scaffold + project registry page

**Files to create:**
- `packages/nexus-web/index.html`
- `packages/nexus-web/vite.config.ts`
- `packages/nexus-web/src/main.tsx`
- `packages/nexus-web/src/App.tsx` — React Router v6 with 3 routes
- `packages/nexus-web/src/pages/ProjectRegistry.tsx` — table of projects from `/api/projects`
- `packages/nexus-web/src/pages/ProjectOverview.tsx` — stats + community list

**Acceptance**: `pnpm --filter @cleocode/nexus-web dev` renders project registry page with real data from API. Project overview shows node/relation stats and community cards.

**Dependencies**: T578-W1 (API must exist for dev proxy).

### T578-W3: Graph canvas (macro + community drill-down)

**Files to create:**
- `packages/nexus-web/src/components/GraphCanvas.tsx` — sigma renderer
- `packages/nexus-web/src/hooks/useGraphData.ts` — fetches macro or community graph, builds graphology graph
- `packages/nexus-web/src/lib/graph-colors.ts` — kind/type color maps
- `packages/nexus-web/src/pages/ProjectGraph.tsx` — page wrapper with drill-down state

**Acceptance**: `/project/:id/graph` renders 259 community nodes. Clicking a community node renders its member subgraph. Pan and zoom work. Node kind is color-coded.

**Dependencies**: T578-W2 (page routing must exist).

### T578-W4: Symbol detail page + ego network

**Files to create:**
- `packages/nexus-web/src/pages/SymbolDetail.tsx` — shows node metadata, caller/callee tables with impact tier badges
- `packages/nexus-web/src/components/EgoGraph.tsx` — 2-hop sigma subgraph for a single symbol
- `packages/nexus-web/src/components/ImpactBadge.tsx` — tier badge (d1/d2/d3 colors)

**Acceptance**: `/project/:id/symbol/:name` shows symbol metadata, callers/callees lists, and ego network graph. Clicking a caller/callee node navigates to that symbol's detail page.

**Dependencies**: T578-W3 (EgoGraph reuses GraphCanvas internals).

### T578-W5: `cleo nexus serve` CLI integration

**Files to modify:**
- `packages/cleo/src/dispatch/domains/nexus.ts` — add `case 'serve'` to `mutate()` handler
- `packages/cleo/src/dispatch/engines/nexus-engine.ts` — add `nexusServe(port: number, open: boolean)` function that spawns nexus-web server in-process

**Files to create:**
- `packages/nexus-web/src/cli-entry.ts` — standalone entrypoint for spawning from nexus-engine

**Acceptance**: `cleo nexus serve --port 7777` starts the server, logs `NEXUS portal ready at http://localhost:7777`, handles SIGINT cleanly. `cleo nexus serve --open` also opens the browser.

**Dependencies**: T578-W1 (server must exist to be spawned), T578-W2 through T578-W4 (SPA must be built first for production serve).

### T578-W6: Build pipeline + pnpm workspace wiring

**Files to modify:**
- `pnpm-workspace.yaml` — ensure `packages/nexus-web` is included
- `packages/nexus-web/package.json` — add `build` script: `vite build` + `tsc -p tsconfig.server.json`
- Root `package.json` — ensure `nexus-web` included in workspace build order

**Acceptance**: `pnpm run build` from monorepo root builds nexus-web without errors. `pnpm --filter @cleocode/nexus-web build` produces `dist/` (SPA) and `dist-server/` (Hono server).

**Dependencies**: T578-W1 through T578-W4 (all source must exist before build is wired).

---

## Design Decisions Summary

| Decision | Choice | Reason |
|----------|--------|--------|
| Graph library | sigma + graphology | Battle-tested in GitNexus for same scale, WebGL renderer |
| Frontend | React + Vite | Matches GitNexus OSS, fits monorepo Vite 8 devDep |
| Backend | Hono | Lightweight, typed, ESM-native, no subprocess overhead |
| Data access | Direct SQLite in-process | Avoids serializing 11K nodes through CLI subprocess |
| Package location | `packages/nexus-web/` | Keeps library and SPA concerns separate |
| Performance | 3-tier graph (macro/community/ego) | Prevents rendering 11K nodes at once |
| CLI integration | `cleo nexus serve` | Extends existing domain, no new top-level command |
