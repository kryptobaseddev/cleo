# Design Recommendation: CLEO Docs SSoT as a Live, Obsidian-Grade View

Status: DESIGN (no code). Author: system-architect. Date: 2026-06-05.
Scope: how CLEO exposes `cleo.db` `docs_*` (the SOLE doc authority) as a live, Obsidian-grade view.
Read-only investigation grounded in files/commits/tasks below.

---

## 1. Ground Truth (what EXISTS vs what is DESIGNED)

### 1.1 T11769 REST API-standard — DESIGNED, not built
- `cleo show T11769` → **pending** epic `E-API-STANDARD-FOUNDATION`, parent saga **T10400** `SG-CLEO-SDK-API` (also pending). It is the contracts op-registry → OpenAPI → one generated client over core's gateway, config-as-domain, REST `/v1`, Studio-via-SDK. None of that code-generation / OpenAPI surface exists yet.

### 1.2 A REAL transport-neutral gateway already exists (and is tested) — but is NOT started by any live daemon
This is the single most important finding and it changes the recommendation.
- `packages/runtime/src/gateway/` is a framework-agnostic CQRS gateway with **four transport adapters**: CLI (in-process), MCP (stdio), **RPC (unix-socket NDJSON)**, **HTTP (`node:http`)**, plus shared **SSE** primitives.
  - HTTP embedder: `packages/runtime/src/gateway/http/listen.ts` — `startHttpServer(handler, {port,host})`, routes `POST /<gateway>/<domain>/<operation>` (`<gateway>` ∈ `query|mutate`) through `routeUnary`, LAFS-shaped errors, 1 MiB body cap, loopback-default bind.
  - SSE: `packages/runtime/src/gateway/http/sse.ts` — `createSseStream` / `SSE_HEADERS` / `encodeSseFrame`. Abort-safe, run-once teardown. **Studio's live task feed already consumes this** (`packages/studio/src/routes/api/tasks/events/+server.ts`).
  - RPC: `packages/runtime/src/gateway/rpc/server.ts` — unix-socket NDJSON, the canonical local-client wire (CLI, Studio server, tests).
  - Subsystem wrapper: `packages/runtime/src/gateway/daemon-subsystem.ts` — `defineGatewaySubsystem({scope, handler, rpc?, http?})` exposes RPC+HTTP as a supervised daemon subsystem with `start/healthProbe/shutdown`.
- **CRITICAL GAP:** `defineGatewaySubsystem` is only referenced in its own definition + the runtime barrel. **No daemon boot path in `packages/cleo` or `packages/core` registers it.** So the HTTP `/<gateway>/<domain>/<op>` surface is *built and tested but never listening*. Wiring it into daemon boot is the missing ~1 task, not a from-scratch REST-server epic.
- Note: the routing vocabulary today is `POST /query/<domain>/<op>` and `POST /mutate/<domain>/<op>` — **not** `/v1/...`. T11769 is what later standardizes the path + generates an OpenAPI client. The live-view does NOT need the OpenAPI generator; it needs the listener turned on.

### 1.3 Studio (`packages/studio`) — server-side SSR, reads core SDK directly
- `svelte.config.js` uses `@sveltejs/adapter-node` → **server-side (SSR) Node process**, not static.
- Server routes call **`@cleocode/core` narrow subpaths in-process** (e.g. `@cleocode/core/tasks/list`, `/lifecycle/rollup`, `/store/data-accessor`) — see `routes/api/tasks/+server.ts`. ZERO raw SQL in-route; opens a `DataAccessor` bound to the project DB.
- Live updates already work: `routes/api/tasks/events/+server.ts` is an SSE endpoint built on the shared `createSseStream` (2 s poll on `tasks.db`).
- Studio depends on `@cleocode/core` AND `@cleocode/runtime` (`package.json`). It already has a `routes/api/v1/graph/+server.ts`. It only shells out to the `cleo` CLI for heavy nexus ops (`lib/server/spawn-cli.ts`) — never for hot reads.
- **Implication:** Studio is already the proven "in-process core-SDK reader + SSE live feed over HTTP" pattern. A docs view fits it natively.

### 1.4 The docs.read foundation (T11825 / T11826) — built on a branch, NOT yet on `main` HEAD
- Commit `26f6a1f63` `feat(docs): docs.read core-SDK API + docs_wikilinks derived edge graph` adds: `packages/contracts/src/docs/read.ts` (`DocReadResponse`, `DocFrontmatter`, `DocBody`, zod schemas, `isDocReadResponse`), `packages/core/src/docs/read-doc.ts` (`readDoc(slug)`), `packages/core/src/docs/wikilinks.ts`, `build-provenance-graph.ts`, and `attachments` schema cols.
- **`git merge-base --is-ancestor 26f6a1f63 HEAD` → NO.** On this checkout it is a feature branch, not merged into `main` (`265b7b5ca`). Treat as "implemented, pending merge."
- What it exposes (sufficient for a *read* view):
  - `DocReadResponse = { frontmatter, body }`. `frontmatter` carries slug, kind, title, summary, lifecycleStatus, docVersion, ownerVersion, **supersedes/supersededBy**, **topics**, **relatedTasks**, sha256, createdAt.
  - `body` is `{encoding: 'utf-8'|'base64', text?|base64?, sizeBytes, mimeType}` — **blob rendering (images/PDF) already handled** via base64 (T11825 AC2).
  - `docs_wikilinks` derived edge graph + `cleo docs graph` provenance verb.
- What a *live* view still needs on top of `readDoc`:
  1. A **transport** to call `readDoc`/graph from outside the Node process (Obsidian runs in its own Electron/Node, cannot import `@cleocode/core`).
  2. A **change signal** (the wikilink graph + a doc's `docVersion`/`sha256` change when a doc is rewritten) → push or poll so the view re-renders live. `readDoc` itself is pull-only.
  3. A **list/graph endpoint** (enumerate slugs, fetch backlinks) so the view builds a navigable vault, not just single-doc fetches.

### 1.5 Obsidian plugin reality
- An Obsidian plugin runs inside Obsidian's Electron renderer/Node. It can: `fetch()` an HTTP(S) endpoint on localhost; open an `EventSource`/SSE or WebSocket; read/write vault files. It **cannot** cleanly own a long-lived child subprocess, and a subprocess-per-call (`cleo docs ... --json`) pays cold-start cost on every keystroke/hover — wrong for a "live view."
- Therefore the right transport for a live Obsidian view is **a persistent localhost HTTP connection with SSE for push** — exactly what the gateway HTTP adapter + `createSseStream` already provide.

---

## 2. Evaluation Matrix — PLACEMENT × TRANSPORT

PLACEMENT ∈ {separate `cleo-obsidian` repo · in-monorepo package · Studio docs-view + thin Obsidian bridge · pure gateway HTTP endpoint Obsidian fetches}
TRANSPORT ∈ {REST/HTTP gateway (`POST /query|mutate/docs/...` today; `/v1` later) · NDJSON unix socket · CLI-JSON subprocess}

| Option | Placement | Transport | Consolidation | Live-ness | Aligns ratified REST dir. | Effort | Built today? |
|---|---|---|---|---|---|---|---|
| **A (PRIMARY)** | Gateway HTTP `docs` ops in `core`/`runtime`, hosted by daemon; Obsidian = thin fetch+SSE client | REST/HTTP gateway + SSE | ✅ in-monorepo, no new pkg | ✅ persistent conn + SSE push | ✅ IS the gateway T11769 standardizes | **Low–Med** (wire daemon subsystem + add `docs` query ops + thin plugin) | ✅ gateway+SSE+readDoc all exist; only daemon-wiring missing |
| **B (runner-up)** | Studio docs-view page + Studio `/api/docs` SSE; Obsidian = thin iframe/fetch bridge to Studio | REST/HTTP (Studio SSR routes) | ✅ in Studio, no new pkg | ✅ Studio already does SSR+SSE | ⚠️ Studio routes, not the canonical gateway | **Low** (Studio already imports core + has SSE pattern) | ✅ pattern proven; needs docs routes |
| **C (runner-up)** | In-monorepo `@cleocode/obsidian` plugin package | REST/HTTP gateway | ⚠️ adds a package (mild tension w/ collapse-to-fewer) | ✅ | ✅ | Med | plugin code is net-new |
| D (reject) | Separate `cleo-obsidian` repo | any | ❌ contradicts consolidation philosophy | ✅ | ✅ | High (release/version skew) | ❌ |
| E (reject) | Obsidian plugin shells `cleo docs ... --json` | CLI-JSON subprocess | ✅ | ❌ cold spawn per call ≠ live | ❌ conflicts ratified REST direction | Low but wrong | ✅ CLI exists |
| F (reject) | NDJSON unix socket from plugin | NDJSON | ✅ | ✅ | ⚠️ local-only; not the public REST dir; harder for Electron fetch | Med | RPC server exists, unwired |

---

## 3. PRIMARY RECOMMENDATION

**Placement:** in-monorepo — add `docs` **query operations** to the existing operation registry (`core`), host the existing **gateway HTTP + SSE adapter** via the daemon (`defineGatewaySubsystem`), and ship a **thin Obsidian plugin** (fetch + EventSource client; ~few hundred LOC) as the only net-new surface. The plugin is a *bridge*, not a place where logic lives.

**Transport:** the existing **HTTP gateway over loopback** (`POST /query/docs/read`, `/query/docs/graph`, `/query/docs/list`) for pull, plus **SSE** (`GET` stream of `docs-changed` frames) for push. This is the same wire the daemon already exposes for every other domain and the exact surface T11769 later standardizes to `/v1` — so we ride the ratified REST direction instead of inventing a parallel path.

**Rationale:**
- Honors consolidation: **no new runtime package** for the data path; `core` IS the SDK (owner's own framing), `runtime` already owns the HTTP/SSE transport, the daemon already owns subsystem supervision. The only new artifact is the thin plugin client (unavoidable — it lives in Obsidian's process).
- Honors the ratified REST/NDJSON/gRPC direction: the live view talks to the **gateway**, the canonical API surface. When T11769 standardizes paths to `/v1` and generates an OpenAPI client, the plugin swaps its base path / adopts the generated client with no architectural change.
- Honors live-ness: persistent HTTP keep-alive + SSE push (`createSseStream`) — no subprocess spawns, no polling from the plugin. Blob/PDF/image render is already solved by `DocReadResponse.body.base64` (T11825 AC2).
- Lowest *true* effort because ~80% is already built and tested: gateway HTTP, SSE plumbing, `readDoc`, wikilinks graph. The missing pieces are small and additive.

### Top 2 trade-offs
1. **Requires turning the daemon gateway ON (and accepting a localhost listener).** The HTTP subsystem is built but unwired; we must register `defineGatewaySubsystem` in daemon boot and accept a loopback port as part of CLEO's running surface (auth/origin policy needed before any non-loopback bind). This is a deliberate widening of the daemon's responsibility — but it is the same listener T11769/Studio-via-SDK need anyway, so the cost is paid once for the whole API standard, not just for Obsidian.
2. **A change-notification (`docs-changed`) signal must be produced.** `readDoc` is pull-only; the docs SSoT has no event today. We need a cheap change source — either a `docs_*` version/sha poll inside the SSE source (mirrors Studio's 2 s `tasks.db` poll — already the proven pattern) or, better, emit a domain event on `cleo docs add/supersede`. Poll-first keeps effort low; event-driven is the clean follow-up.

### Why the 2 runner-ups lose
- **B (Studio docs-view + Obsidian bridge):** genuinely attractive and *lowest* effort (Studio already SSRs core + has the SSE pattern, and a docs page in Studio is independently valuable). It loses as the *primary docs API* only because Studio routes are an **app surface, not the canonical gateway** — making Studio the API would re-create the "Studio-specific routes drift from the SSoT" problem that T11769 exists to kill (Studio-via-SDK). **Strong recommendation: still build the Studio docs page, but have it consume the same gateway `docs` ops** — Studio becomes the first proof-of-life consumer, Obsidian the second. So B is not discarded; it is *folded under A* as a parallel consumer.
- **C (in-monorepo `@cleocode/obsidian` package):** correct placement-philosophy-wise but adds a package while the owner is collapsing ~21 → fewer. A plugin is a *distribution artifact* (it ships into a user's vault), not a library other packages import — so it does not need to be a first-class workspace package. Ship the thin plugin as build output / a `templates/`-style asset or a single non-published dir, not a numbered package. (If a package proves necessary for build tooling, it is a minor variation of A, not a different architecture.)

---

## 4. Phased Build Plan

- **Phase 0 — Land the foundation on `main` (prerequisite).** Merge T11825/T11826 (`docs.read` + `docs_wikilinks`, commit `26f6a1f63`) into `main`. Until then `readDoc`/wikilinks are branch-only.
- **Phase 1 — Add `docs` query ops + host the gateway (the real keystone).** Register `docs.read` (wrap `readDoc`), `docs.graph`/`docs.list` (wrap wikilinks + slug enumeration) as **query** operations in the registry so they route through the gateway automatically. Wire `defineGatewaySubsystem` (HTTP transport) into daemon boot on a loopback port; add an origin/token guard. Deliverable: `curl POST 127.0.0.1:<port>/query/docs/read {slug}` returns a `DocReadResponse`.
- **Phase 2 — Live signal + Studio proof-of-life.** Add a `GET /query/docs/events` SSE source emitting `docs-changed` (poll `docs_*` max(version)/sha like the tasks-events route, or emit on `docs add/supersede`). Build a Studio docs-view page consuming `docs/read` + `docs/graph` + the SSE feed — proves the gateway docs API end-to-end inside an existing consumer.
- **Phase 3 — Thin Obsidian plugin (the bridge).** Plugin: on note open/hover, `fetch` `docs/read` (render markdown + base64 blobs), `docs/graph` for backlinks pane, `EventSource` on `docs/events` to live-refresh. No CLI spawns, no business logic in the plugin. Distribute as build output, not a published package.
- **Phase 4 (optional, post-T11769) — adopt `/v1` + generated client.** When T11769 ships the op-registry→OpenAPI→generated client and `/v1` path standard, repoint the plugin (and Studio) at the generated SDK. Pure swap; no redesign.

---

## 5. Dependency on T11769 — and the honest "defer?" call

**Not blocked on T11769.** T11769 is the *standardization + codegen* of the API surface; the live Obsidian view needs only the *transport that already exists* (gateway HTTP + SSE) plus `docs` ops + daemon wiring. Building Obsidian on the current gateway vocabulary (`/query/docs/...`) and migrating to `/v1` in Phase 4 is a clean, low-cost path — and it *de-risks* T11769 by giving it a real second consumer beyond Studio.

**Do NOT defer the whole effort until REST `/v1` lands.** Deferring would idle a gateway that is already 80% built and tested, and would leave the docs SSoT with no live view for the duration of a large standardization epic. The one thing that *should* gate is Phase 1's daemon-gateway wiring: it is a genuine widening of CLEO's running surface (a listening socket) and must land with an origin/auth guard — but that wiring is needed for T11769 / Studio-via-SDK regardless, so doing it now is not wasted.

**Net:** proceed now, on the existing gateway, in-monorepo, with a thin plugin. Treat T11769 as the later path-standardization that the plugin painlessly adopts — not a blocker.
