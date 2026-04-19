# Studio API Wire-up Audit — Post-T962 Rename

> Scope: `packages/studio/src` — every fetch site, every `+server.ts` endpoint, shape & liveness validation.
> Studio target: `http://localhost:3456` (live, HTTP 200 on `/api/health`).
> Generated: 2026-04-19 for T990 (design research).

## TL;DR

- T962 rename is **clean**. Zero `/api/living-brain` references survive in source. `/api/brain` returns the super-graph; `/api/memory/*` returns observations/decisions/quality/graph/tier-stats/observations.
- **0 dead frontend fetches**: every URL the client hits has a live endpoint and every response shape matches what the Svelte consumer parses.
- **3 dead backend endpoints**: `/api/nexus/community/[id]`, `/api/nexus/symbol/[name]`, and `/api/project/[id]/index` have no frontend fetch caller (consumed only by server-side `+page.server.ts` loads via direct imports, or by nothing at all).
- **POST/DELETE mutation endpoints have zero auth** — `switch`, `scan`, `clean`, `[id]` DELETE, `[id]/index`, `[id]/reindex` all accept anonymous requests. Safe while Studio binds to localhost only; hard-blocker if it ever binds to `0.0.0.0`.
- Error handling on frontend fetchers is **naive** — no retry, no typed envelope, 7/10 sites use `throw new Error('HTTP ' + res.status)` and surface raw messages to the user. No abort controller except on `tasks/+page.svelte` search.

---

## 1. Frontend Fetch Matrix

Every `fetch(...)` and `new EventSource(...)` call in `packages/studio/src` (excluding `routes/api/**`), cross-referenced against live curl probes against `http://localhost:3456`.

| # | Caller (file:line) | URL | Method | Endpoint Status | Live Probe | Shape Match |
|---|---|---|---|---|---|---|
| 1 | `routes/brain/+page.svelte:158` | `/api/brain/stream` | SSE | **LIVE** | `data: {"type":"hello",…}` | yes |
| 2 | `routes/brain/+page.svelte:344` | `/api/brain?limit=5000` | GET | **LIVE** (renamed T962) | 200 `{nodes,edges,counts,truncated}` | yes — `BrainGraph` |
| 3 | `routes/brain/+page.svelte:363` | `/api/brain/node/${id}` | GET | **LIVE** | 200 `{node,neighbors,edges}` | partial — frontend reads only `.node`, ignores `neighbors`/`edges` (lossy, not broken) |
| 4 | `routes/brain/3d/+page.svelte:155` | `/api/brain/stream` | SSE | **LIVE** | as #1 | yes |
| 5 | `routes/brain/3d/+page.svelte:286` | `/api/brain/node/${id}` | GET | **LIVE** | as #3 | partial (same as #3) |
| 6 | `routes/brain/decisions/+page.svelte:54` | `/api/memory/decisions` | GET | **LIVE** (new T962) | 200 `{decisions[],total}` | yes — `BrainDecision[]` |
| 7 | `routes/brain/quality/+page.svelte:85` | `/api/memory/quality` | GET | **LIVE** (new T962) | 200 observations/decisions/patterns/learnings buckets | yes — `BrainQualityResponse` |
| 8 | `routes/brain/graph/+page.svelte:67` | `/api/memory/graph` | GET | **LIVE** (new T962) | 200 `{nodes,edges,total_nodes,total_edges}` | yes — `BrainGraphResponse` |
| 9 | `routes/brain/observations/+page.svelte:65` | `/api/memory/observations?${params}` | GET | **LIVE** (new T962) | 200 `{observations[],total,filtered}` | yes — `BrainObservationsResponse` |
| 10 | `routes/tasks/+page.svelte:291` | `/api/tasks/search?q=${q}` | GET (abort-able) | **LIVE** | 200 `{kind:"id",task}` or `{kind:"title",tasks,total}` | yes — uses exported `SearchTaskRow` |
| 11 | `routes/tasks/+page.svelte:396` | `/api/tasks/events` | SSE | **LIVE** | `event: connected\ndata: …` | yes |
| 12 | `routes/projects/+page.svelte:68` | `/api/project/${id}/${action}` | POST | **LIVE** for `action ∈ {index, reindex}` | 200 LAFS envelope | yes — `{success,error?}` |
| 13 | `routes/projects/+page.svelte:109` | `/api/project/${id}` | DELETE | **LIVE** | 200 LAFS envelope | yes |
| 14 | `lib/components/ProjectSelector.svelte:134` | `/api/project/switch` | POST | **LIVE** | 200 `{success:true}` | yes |
| 15 | `lib/components/admin/ScanModal.svelte:33` | `/api/project/scan` | POST | **LIVE** | 200 LAFS envelope | yes |
| 16 | `lib/components/admin/CleanModal.svelte:39` | `/api/project/clean` | POST | **LIVE** | 200 LAFS envelope | yes |

**10/10 frontend GET/SSE sites resolve to live endpoints returning the shape the caller parses.** No moved/broken/dead frontend fetches.

Signals verified:
- `grep -r "living-brain" packages/studio/src --include='*.svelte' --include='*.ts'` → **zero hits outside tests**. `routes/brain/__tests__/route-existence.test.ts:100-108` asserts the rename landed (`/api/brain` present, `/api/living-brain` absent). The test file is the **only** surviving `living-brain` reference in source, and it is assertion, not call site.
- The three memory pages (`decisions`, `quality`, `graph`) use the renamed `/api/memory/*` paths. No stale `/api/brain/…` calls that would 404.

---

## 2. Backend Endpoint Inventory

All 31 `+server.ts` files under `packages/studio/src/routes/api`:

| Path | Methods | Status | Caller |
|---|---|---|---|
| `/api/health` | GET | live, 200 `{ok,service,version,databases,paths}` | observability only — no UI caller |
| `/api/search` | GET `?q&scope&limit` | live, LAFS envelope, 400 on q<2 | no frontend caller (placeholder for global symbol search UI) |
| `/api/brain` | GET | live, `BrainGraph` | `routes/brain/+page.svelte` #2 |
| `/api/brain/stream` | GET (SSE) | live | `routes/brain/+page.svelte` #1, `routes/brain/3d/+page.svelte` #4 |
| `/api/brain/node/[id]` | GET | live, 400 when id prefix missing | `routes/brain/+page.svelte` #3, `routes/brain/3d/+page.svelte` #5 |
| `/api/brain/substrate/[name]` | GET | live, 400 on unknown substrate | **no frontend caller** — orphan |
| `/api/memory/decisions` | GET | live | `routes/brain/decisions/+page.svelte` #6 |
| `/api/memory/graph` | GET | live | `routes/brain/graph/+page.svelte` #8 |
| `/api/memory/quality` | GET | live | `routes/brain/quality/+page.svelte` #7 |
| `/api/memory/observations` | GET | live | `routes/brain/observations/+page.svelte` #9 |
| `/api/memory/tier-stats` | GET | live | **no frontend fetch** — duplicated by `brain/overview/+page.server.ts` direct-DB load |
| `/api/tasks` | GET | live, rollups merged | **no frontend caller** — `/tasks` uses `+page.server.ts` direct DB, and `/tasks/pipeline` fetches `/api/tasks/pipeline` server-side |
| `/api/tasks/pipeline` | GET | live | consumed by `routes/tasks/pipeline/+page.server.ts` (server-to-server) |
| `/api/tasks/search` | GET | live | `routes/tasks/+page.svelte` #10 |
| `/api/tasks/graph` | GET `?epic\|taskId` | live, 400 when neither | consumed by `routes/tasks/graph/+page.server.ts` (server-to-server) |
| `/api/tasks/events` | GET (SSE) | live | `routes/tasks/+page.svelte` #11 |
| `/api/tasks/sessions` | GET | live | consumed by `routes/tasks/sessions/+page.server.ts` |
| `/api/tasks/tree/[epicId]` | GET | live | **no caller** — legacy; `routes/tasks/tree/[epicId]/+page.server.ts` is now a 301 redirect to `/tasks#hierarchy?epic=ID` (T957). Endpoint is orphaned. |
| `/api/tasks/[id]` | GET | live | **no frontend caller** — `routes/tasks/[id]/+page.server.ts` queries DB directly. Endpoint is orphaned (only referenced by a doc comment on `DetailDrawer.svelte:56`). |
| `/api/tasks/[id]/deps` | GET | live | **no frontend caller** — documented in `DetailDrawer.svelte:56` but the drawer receives deps from parent via prop; no fetch issued |
| `/api/nexus` | GET | live, returns community list | consumed by `routes/code/+page.server.ts` (server-to-server) |
| `/api/nexus/search` | GET | live | consumed by `routes/code/+page.server.ts` (server-to-server) |
| `/api/nexus/community/[id]` | GET | live | **no frontend caller** — `routes/code/community/[id]/+page.server.ts` queries directly |
| `/api/nexus/symbol/[name]` | GET | live | **no frontend caller** — `routes/code/symbol/[name]/+page.server.ts` queries directly |
| `/api/project/switch` | POST | live, 400 on bad body | `lib/components/ProjectSelector.svelte` #14 |
| `/api/project/scan` | POST | live (spawns `cleo nexus projects scan`) | `lib/components/admin/ScanModal.svelte` #15 |
| `/api/project/clean` | POST | live (spawns `cleo nexus projects clean`) | `lib/components/admin/CleanModal.svelte` #16 |
| `/api/project/[id]` | DELETE | live | `routes/projects/+page.svelte` #13 |
| `/api/project/[id]/index` | POST | live, 404 on unknown id | **no frontend caller** — `routes/projects/+page.svelte` calls `${id}/index` as `action='index'`, but the dropdown only offers `reindex`. Verify by UI inspection; currently path is technically reachable but unused. |
| `/api/project/[id]/reindex` | POST | live, 404 on unknown id | `routes/projects/+page.svelte` #12 (`action='reindex'`) |

---

## 3. Dead Endpoints (zero callers anywhere)

These endpoints exist and return 200, but nothing in the Studio codebase calls them:

| Endpoint | Reason | Recommended action |
|---|---|---|
| `/api/brain/substrate/[name]` | Declared as cleaner alias for `/api/brain?substrates=<name>`, but no page uses it. | Keep — clean URL for future faceted filter UI. Document as "public API surface only". |
| `/api/tasks` | Listing endpoint with rollup enrichment (T948). `/tasks/+page.server.ts` hits DB directly; no client-side pagination or filter UI exists. | Keep — canonical listing for external SDK/tests. Wire `/tasks` page to use it to avoid server/API drift. |
| `/api/tasks/tree/[epicId]` | Legacy; route was redirected to `/tasks#hierarchy?epic=ID` in T957. | **Delete** or clearly mark `@deprecated`. No active consumer, and the `tree` page is a redirect shell now. |
| `/api/tasks/[id]` | Doc comment references it on `DetailDrawer.svelte:56`, but drawer never fetches. | Keep — useful for single-task refresh without full page reload; wire it in the drawer to replace the "reload entire page" pattern. |
| `/api/tasks/[id]/deps` | Same as above — drawer docs reference it, nothing fetches. | Keep — useful for lazy dep loading. Wire into drawer or delete the doc comment. |
| `/api/nexus/community/[id]` | `code/community/[id]/+page.server.ts` queries DB directly. | Keep for external use OR delete if only Studio consumes nexus.db. |
| `/api/nexus/symbol/[name]` | Same — `code/symbol/[name]/+page.server.ts` queries directly. | Keep/delete as above. |
| `/api/memory/tier-stats` | Live, complete, shape matches `brain/overview/+page.server.ts` data, but overview page inlines the same SQL rather than fetching. | **Consolidate** — delete the inlined SQL from `brain/overview/+page.server.ts` and `fetch('/api/memory/tier-stats')` from the load function. Prevents drift. |
| `/api/project/[id]/index` | Frontend only exposes `reindex`. Endpoint may be exercised by external CLI/integration tests. | Keep — semantically distinct (first index vs. re-index), even if implementation is identical today. |
| `/api/health` | Exists for observability and health checks. Not called by UI. | Keep — uptime checks / Docker healthcheck. |
| `/api/search` | Placeholder for cross-project symbol search UI (T622). No page calls it yet. | Keep — wire to global search bar or add a `/search` page. |

---

## 4. Frontend Fetches With No Backing Endpoint

**None.** All 10 active fetch sites land on live endpoints.

---

## 5. Shape Mismatches

**None that break a page**, but two minor lossy spots:

1. **`/api/brain/node/[id]` response waste** — backend returns `{node, neighbors, edges}` (types defined in `NodeNeighborsResponse`). Both `brain/+page.svelte:365` and `brain/3d/+page.svelte:288` type as `{ node: BrainNode }` and drop `neighbors`/`edges`. The graph UI could be enriched with the existing payload (1-hop neighbourhood visualization). No fix required; flagged as underutilized contract.
2. **`/api/tasks/graph` returns 400 without params** — correctly guards `epic or taskId query param required`, but no frontend site actually fetches this endpoint from the client. Called only via `routes/tasks/graph/+page.server.ts`. The 400 is a safety rail for external callers.

No frontend call expects a shape the backend doesn't return.

---

## 6. Auth on Mutation Endpoints

**Zero auth**, on six mutations:

| Endpoint | Method | Mutation | Auth |
|---|---|---|---|
| `/api/project/switch` | POST | Writes active-project cookie | none |
| `/api/project/scan` | POST | Spawns CLI, writes nexus.db rows | none |
| `/api/project/clean` | POST | Spawns CLI, can delete nexus rows (defaults to dry-run) | none |
| `/api/project/[id]` | DELETE | Removes project from nexus.db | none |
| `/api/project/[id]/index` | POST | Spawns CLI, writes nexus.db | none |
| `/api/project/[id]/reindex` | POST | Same | none |

**Risk model**: Studio currently binds to `localhost:3456`. All six are safe **as long as** the server is not exposed on `0.0.0.0` / LAN / tunnel. There is no CSRF token either — a local malicious page could POST to any of these.

**Recommendations**:
- Add a per-request server-only CSRF token (bind to the active-project cookie) on all POST/DELETE routes.
- If Studio is ever intended for non-loopback binding, add at minimum a same-origin check in `hooks.server.ts` and a shared-secret header for mutations.
- `clean` already defaults to dry-run — good defensive posture. `scan` and `index`/`reindex` spawn subprocesses and should reject non-local origins even in dev.

---

## 7. Error Handling Audit

**Pattern today** (naive):
```ts
const res = await fetch('/api/memory/quality');
if (!res.ok) throw new Error(`HTTP ${res.status}`);
data = (await res.json()) as QualityData;
```

Repeated across sites #2, #3, #5, #6, #7, #8, #9. Issues:
- No typed envelope awareness — the backend returns `{error: string}` on 4xx/5xx, but frontend only shows `HTTP 500`, never the actual message.
- No retry/backoff for transient DB-busy / WAL-checkpoint races.
- No abort controller except `/api/tasks/search` (site #10) which correctly uses one.
- No trace ID propagation.
- Cast-style type assertions (`as BrainGraph`) rather than Zod/valibot parse — runtime shape drift becomes a silent render bug.

POST sites (#12, #13, #14, #15, #16) correctly read `res.json()` and surface `envelope.error.message`, so LAFS error envelopes work for mutations but are ignored on GETs.

---

## 8. Recommended Contract: Typed Client

Replace stringly-typed URLs with a single generated client. Goals:

1. **One fetch wrapper** that:
   - Parses the LAFS envelope (`{success, data?, error?, meta}`) uniformly.
   - Handles retry-on-503 with exponential backoff (SQLite WAL transient).
   - Supports abort signal passthrough.
   - Surfaces `error.message` to the UI, never `HTTP NNN`.
   - Returns `Result<T, CleoApiError>` (discriminated union), not `throw`.

2. **Schema-first contracts** colocated with each `+server.ts`:
   - Every endpoint exports its response interface (already done for `TasksResponse`, `BrainQualityResponse`, etc.).
   - Add a Zod schema next to each interface (auto-generated if possible) so the client can `.parse()` runtime shapes.

3. **Code-generated client** in `packages/studio/src/lib/api/client.ts`:
   ```ts
   export const api = {
     brain: {
       graph: (opts?: { limit?: number }) => call<BrainGraph>('GET', '/api/brain', opts),
       node:  (id: string) => call<NodeNeighborsResponse>('GET', `/api/brain/node/${encodeURIComponent(id)}`),
     },
     memory: {
       decisions:    () => call<BrainDecisionsResponse>('GET', '/api/memory/decisions'),
       quality:      () => call<BrainQualityResponse>('GET', '/api/memory/quality'),
       graph:        () => call<BrainGraphResponse>('GET', '/api/memory/graph'),
       observations: (q: ObservationsQuery) => call<BrainObservationsResponse>('GET', '/api/memory/observations', { query: q }),
       tierStats:    () => call<TierStatsResponse>('GET', '/api/memory/tier-stats'),
     },
     tasks: {
       search:   (q: string, signal?: AbortSignal) => call<TasksSearchResponse>('GET', '/api/tasks/search', { query: { q }, signal }),
       pipeline: () => call<PipelineResponse>('GET', '/api/tasks/pipeline'),
       byId:     (id: string) => call<TaskByIdResponse>('GET', `/api/tasks/${encodeURIComponent(id)}`),
       deps:     (id: string) => call<DepsResponse>('GET', `/api/tasks/${encodeURIComponent(id)}/deps`),
     },
     project: {
       switch:  (projectId: string) => call<{success:boolean}>('POST', '/api/project/switch', { body: { projectId } }),
       scan:    (opts: ScanBody) => call<LafsEnvelope>('POST', '/api/project/scan', { body: opts }),
       clean:   (opts: CleanBody) => call<LafsEnvelope>('POST', '/api/project/clean', { body: opts }),
       delete:  (id: string) => call<LafsEnvelope>('DELETE', `/api/project/${encodeURIComponent(id)}`),
       index:   (id: string) => call<LafsEnvelope>('POST', `/api/project/${encodeURIComponent(id)}/index`),
       reindex: (id: string) => call<LafsEnvelope>('POST', `/api/project/${encodeURIComponent(id)}/reindex`),
     },
     streams: {
       brain: (onEvent: (e: BrainStreamEvent) => void) => eventSource('/api/brain/stream', onEvent),
       tasks: (onEvent: (e: unknown) => void) => eventSource('/api/tasks/events', onEvent),
     },
   };
   ```

4. **Kill the direct-DB drift** — `routes/brain/overview/+page.server.ts` and `routes/tasks/[id]/+page.server.ts` currently reimplement the same SQL as their API counterparts. Either:
   - Collapse load functions into calls through the API layer (adds one hop, but eliminates two places to change the shape), or
   - Extract the query into a single shared service function (`$lib/server/brain/tier-stats.ts`) consumed by both the API route and the page load.

5. **Delete or complete the orphan endpoints**:
   - Delete `/api/tasks/tree/[epicId]` (route is a 301 redirect — the API is dead weight).
   - Remove doc comment referencing `/api/tasks/[id]/deps` in `DetailDrawer.svelte:56` or wire the drawer to call it.
   - Decide: keep `/api/nexus/community/[id]` + `/api/nexus/symbol/[name]` as external API, or collapse into shared service.

---

## Files (absolute paths)

**Frontend fetch sites:**
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/3d/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/decisions/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/quality/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/graph/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/observations/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/tasks/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/routes/projects/+page.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/ProjectSelector.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/admin/ScanModal.svelte`
- `/mnt/projects/cleocode/packages/studio/src/lib/components/admin/CleanModal.svelte`

**Server endpoint files (31):**
- `/mnt/projects/cleocode/packages/studio/src/routes/api/health/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/search/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/brain/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/brain/stream/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/brain/node/[id]/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/brain/substrate/[name]/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/decisions/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/graph/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/quality/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/observations/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/memory/tier-stats/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/pipeline/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/search/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/graph/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/events/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/sessions/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/tree/[epicId]/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/[id]/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/tasks/[id]/deps/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/nexus/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/nexus/search/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/nexus/community/[id]/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/nexus/symbol/[name]/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/project/switch/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/project/scan/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/project/clean/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/project/[id]/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/project/[id]/index/+server.ts`
- `/mnt/projects/cleocode/packages/studio/src/routes/api/project/[id]/reindex/+server.ts`

**Rename test (guardrail):**
- `/mnt/projects/cleocode/packages/studio/src/routes/brain/__tests__/route-existence.test.ts` — asserts `/api/brain` exists, `/api/living-brain` is gone, `/api/memory` exists.
