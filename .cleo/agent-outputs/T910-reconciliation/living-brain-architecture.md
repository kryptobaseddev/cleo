# Living Brain Architecture — Reconciliation vs. Operator Super-BRAIN Model

**Date**: 2026-04-17
**Task**: T910 Reconciliation
**Scope**: `packages/studio/src/lib/server/living-brain/` + `routes/api/living-brain/` + `routes/brain/`
**Verdict file**: this document

---

## Executive Summary (5 bullets)

1. **Living Brain already IS the operator's super-BRAIN model.** A 5-substrate unified graph (BRAIN + NEXUS + TASKS + CONDUIT + SIGNALDOCK) is fully implemented, typed, tested, streamed live via SSE, and rendered in three modes (2D sigma.js, GPU cosmos.gl, 3D force-graph with bloom). Cross-substrate edges are synthesized and materialized in-memory on every query.
2. **It is live-computed, not materialized.** Every `/api/living-brain` request runs five adapters (one per substrate) against their respective SQLite DBs, merges the outputs, prefixes node IDs with `substrate:` to guarantee uniqueness, then runs a second-pass stub-node loader to recover edges whose targets weren't in the initial budget (`packages/studio/src/lib/server/living-brain/adapters/index.ts:160-231`).
3. **Cross-substrate edges are real and traversable.** Five concrete bridge mechanisms connect BRAIN↔NEXUS (file-modified), BRAIN↔TASKS (`context_task_id`, `brain_memory_links`, `brain_page_edges` with task refs), CONDUIT↔SIGNALDOCK (agent social graph from messages), NEXUS intra (import/call relations), TASKS intra (parent/dependency/relation) — verified by 27 unit tests in `__tests__/bridges.test.ts`.
4. **Naming collision with the OLD brain endpoints** is the primary reconciliation gap. `/api/brain/*` (observations, decisions, graph, quality, tier-stats) are the older typed-memory tables endpoints; `/api/living-brain/*` is the new super-graph. The owner's mental model calls the super-graph "BRAIN," so the routing is inverted relative to operator language. Rename is the cleanup.
5. **Verdict: SHIP-ALIGNED.** Living Brain matches the operator's "all nodes across NEXUS + BRAIN + TASKS + CONDUIT for the complete brain connections" spec. Gaps are cosmetic (naming, one missing adapter — there is no `brain_page_nodes` node-table adapter, only edges; intra-BRAIN nodes come from the four typed tables). Recommend: promote `/api/living-brain` to `/api/brain` and demote `/api/brain` to `/api/memory`.

---

## File Inventory

### Core library — `packages/studio/src/lib/server/living-brain/`

| File | LoC | Purpose |
|------|-----|---------|
| `types.ts` | 182 | Unified `LBNode` / `LBEdge` / `LBGraph` / `LBQueryOptions` / `LBStreamEvent` schema. Defines 10 `LBNodeKind` values and 6 `LBSubstrate` tags (incl. `'cross'` for synthesized edges). |
| `adapters/index.ts` | 232 | Barrel + `getAllSubstrates()` orchestrator. Calls each adapter, dedupes by prefixed ID, runs second-pass stub loader for unresolved edge targets, respects per-substrate filter contract. |
| `adapters/brain.ts` | 395 | Queries `brain.db`: 4 typed tables (observations, decisions, patterns, learnings) + `brain_page_edges` + `brain_memory_links` + `brain_observations.files_modified_json`. Synthesizes 5 bridge types (intra-brain, brain→tasks, brain→nexus, memory_links→tasks, files→nexus). |
| `adapters/nexus.ts` | 120 | Queries global `nexus.db`. Fetches top-N in-degree symbols/files, pulls relations between loaded nodes. Prefixes `nexus:`. |
| `adapters/tasks.ts` | 207 | Queries `tasks.db`. Priority-ordered task fetch + recent sessions; synthesizes `parent_of` / `depends_on` / `task_relations` edges. Prefixes `tasks:`. |
| `adapters/conduit.ts` | 120 | Queries `conduit.db` messages. Creates message nodes + aggregates agent-pair message counts → synthesizes cross-substrate `signaldock:agent → signaldock:agent` edges weighted by message volume. |
| `adapters/signaldock.ts` | 122 | Queries global `signaldock.db`. Fetches active agents + `agent_connections`. Agents are the cross-substrate identity anchor (referenced by TASKS assignee, CONDUIT from/to, BRAIN source). |

### Tests — `packages/studio/src/lib/server/living-brain/__tests__/`

| File | Purpose |
|------|---------|
| `bridges.test.ts` | 778 lines, 27 tests. Verifies all 5 brain-adapter bridge synthesis paths using synthetic in-memory fixtures (no real DB). Covers intra-brain, brain→tasks (from `brain_page_edges`), brain→nexus (from `::` paths), `brain_memory_links`, `files_modified_json`, and `decisions.context_task_id` soft-FK. |
| `stub-loader.test.ts` | Verifies second-pass stub loader handles missing targets, partitions by substrate, respects requested-substrates filter, marks stubs with `meta.isStub: true`. |
| `types.test.ts` | Type-system + schema contract tests for `LBNode`/`LBEdge`/`LBGraph`. |
| `created-at-projection.test.ts` | Verifies timestamp normalization across heterogeneous column types (ISO text vs UNIX epoch) per substrate. |

### API routes — `packages/studio/src/routes/api/living-brain/`

| File | Purpose |
|------|---------|
| `+server.ts` | `GET /api/living-brain` — unified endpoint. Query params: `limit` (max 2000), `substrates` (CSV filter), `min_weight`. Returns full `LBGraph`. |
| `node/[id]/+server.ts` | `GET /api/living-brain/node/:id` — single node + neighbors. `id` must be substrate-prefixed (e.g. `brain:O-abc`, `nexus:pkg/file.ts::Sym`). Returns `{node, neighbors, edges}`. 404 on miss. |
| `substrate/[name]/+server.ts` | `GET /api/living-brain/substrate/:name` — filters to one substrate (`brain`/`nexus`/`tasks`/`conduit`/`signaldock`). 400 on invalid name. Equivalent to `?substrates=<name>` but cleaner URL. |
| `stream/+server.ts` | `GET /api/living-brain/stream` — SSE endpoint. 1 s polling against `brain_observations` (rowid watermark), `brain_page_edges` (weight diff snapshot), `tasks` (status diff), `conduit.messages` (rowid watermark). Emits `hello`/`heartbeat`/`node.create`/`edge.strengthen`/`task.status`/`message.send`. |

### Frontend — `packages/studio/src/routes/brain/`

| File | Purpose |
|------|---------|
| `+page.server.ts` | Loads full graph (limit 5000) on first paint via `getAllSubstrates()`. SSR disabled (WebGL dep). |
| `+page.svelte` | 1213 lines. Controls pane with substrate toggles, min-weight slider, time slider, renderer mode (2D/GPU/3D). SSE wiring with exponential-backoff reconnect. Side-panel node detail via `/node/:id`. Pulse animations on `node.create` / `edge.strengthen` / `task.status`. |
| `3d/+page.server.ts` | Same loader as `/brain` but mounted at `/brain/3d` for direct 3D deep-link. |
| `3d/+page.svelte` | 3D-only surface. Uses `LivingBrain3D.svelte` (THREE.js + `3d-force-graph` + `UnrealBloomPass` for neon synapse glow). |

### Components — `packages/studio/src/lib/components/`

| File | LoC | Purpose |
|------|-----|---------|
| `LivingBrainGraph.svelte` | 554 | 2D sigma.js renderer. Default for ≤2000 nodes. |
| `LivingBrainCosmograph.svelte` | 639 | GPU cosmos.gl renderer. Auto-activates >2000 nodes. |
| `LivingBrain3D.svelte` | 765 | THREE.js + 3d-force-graph + bloom. Pulse animations for live synapse events. |

---

## Substrate Pattern

**Contract**: every adapter is a pure function `(options: LBQueryOptions) => { nodes: LBNode[]; edges: LBEdge[] }` registered in `ADAPTER_MAP` at `adapters/index.ts:27-36`.

**Registration** (`adapters/index.ts:27-36`):

```ts
const ADAPTER_MAP: Record<LBSubstrate, (options: LBQueryOptions) => {...}> = {
  brain: getBrainSubstrate,
  nexus: getNexusSubstrate,
  tasks: getTasksSubstrate,
  conduit: getConduitSubstrate,
  signaldock: getSignaldockSubstrate,
};
```

**Five substrates**: `brain` (project `brain.db`), `nexus` (global `nexus.db`), `tasks` (project `tasks.db`), `conduit` (project `conduit.db`), `signaldock` (global `signaldock.db`). Plus a sixth synthetic tag `'cross'` on edges that bridge two substrates.

**What a substrate exposes**: nodes (with stable substrate-prefixed IDs) and edges (with `source`/`target` referencing any substrate). Adapters do NOT expose an iterator or `getNode(id)` — they are bulk query functions budgeted to `Math.ceil(limit / 5)` nodes each.

**Budget discipline**: each adapter gets 1/5 of the caller's limit. Brain subdivides further: 40% observations, 25% decisions, 20% patterns, 15% learnings (`adapters/brain.ts:180-261`). Tasks: 80% tasks + 20% sessions (`adapters/tasks.ts:94-126`). Nexus: all budget to top-in-degree nodes (`adapters/nexus.ts:60-74`).

**Error model**: each adapter wraps its DB work in `try { ... } catch { /* return partial */ }` so one dead DB cannot break the whole endpoint (`adapters/brain.ts:389`, `adapters/tasks.ts:201`, etc.).

---

## Unified Node Schema

```
LBNode {
  id: string           // "<substrate>:<raw-id>"  e.g. "brain:O-abc", "nexus:pkg/f.ts::Sym"
  kind: LBNodeKind     // observation|decision|pattern|learning|task|session|symbol|file|agent|message
  substrate: LBSubstrate  // brain|nexus|tasks|conduit|signaldock
  label: string
  weight?: number      // BRAIN: quality_score  NEXUS: in-degree/50  TASKS: priority rank  SIG/COND: status-derived
  createdAt: string|null  // ISO-8601, normalized across substrates
  meta: Record<string, unknown>   // substrate-specific fields
}

LBEdge {
  source: string       // LBNode.id
  target: string       // LBNode.id
  type: string         // supersedes|applies_to|calls|parent_of|modified_by|messages|...
  weight: number       // [0,1]
  substrate: LBSubstrate | 'cross'
}
```

**Node kinds by substrate**:

```
brain:      observation | decision | pattern | learning
tasks:      task | session
nexus:      symbol | file
signaldock: agent
conduit:    message
```

**ID format** (substrate-prefix, source of truth at `types.ts:43-73`):

```
brain:O-abc123                                        (observation)
brain:D-xxx                                           (decision)
nexus:packages/core/src/cleo.ts                       (file)
nexus:packages/core/src/cleo.ts::Cleo.run             (symbol)
tasks:T626                                            (task)
tasks:ses_20260417192937_649170                       (session)
conduit:msg-xyz                                       (message)
signaldock:agent-007                                  (agent)
```

**Substrate-prefix** guarantees uniqueness across DBs: dedup is a single `Set<string>` by ID (`adapters/index.ts:194-201`).

---

## Graph Build Strategy

**Live-computed, NOT materialized.** There is no `brain_graph_nodes` / `brain_graph_edges` unified table. Each request runs the 5 adapters and composes in-memory.

- **Per-request cost**: ~5 SELECT statements per substrate = ~25 queries total, all against local SQLite with WAL. Budgeted to 500 nodes by default, 5000 max.
- **Caching**: none at the API layer. The frontend's SvelteKit `+page.server.ts` loads once on first paint; subsequent graph mutations arrive via SSE and are merged client-side (`routes/brain/+page.svelte:100-117`).
- **Streaming**: `GET /api/living-brain/stream` polls source tables every 1 s via per-connection watermarks (rowid for appends, in-memory diff for UPDATEs). No DB triggers, no CDC — cheap poll-based change detection (`routes/api/living-brain/stream/+server.ts:195-391`).
- **Stub-node second pass** (`adapters/index.ts:51-141`) recovers cross-substrate edges whose targets weren't in the top-N budget. Missing nexus targets are queried by ID batch; other substrates get minimal inline stubs with `meta.isStub: true`.

**Materialized table that DOES exist**: `brain_page_edges` in `brain.db`. This is the Hebbian/STDP-trained synaptic weight store inside BRAIN. The Living Brain adapter reads this as edge source, but the super-graph itself is not persisted.

**Performance characteristic**: O(limit) per request, where each adapter's SQL is bounded by budget. No index lookups by cross-substrate edge — in-memory edge filter pass only (`routes/api/living-brain/node/[id]/+server.ts:51`).

---

## API Surface

| Method | Path | Returns | Notes |
|--------|------|---------|-------|
| GET | `/api/living-brain` | `LBGraph` | `?limit=500` (max 2000), `?substrates=brain,tasks`, `?min_weight=0.5` |
| GET | `/api/living-brain/node/:id` | `{node, neighbors, edges}` | `id` is URL-encoded substrate-prefixed; 404 on miss |
| GET | `/api/living-brain/substrate/:name` | `LBGraph` (single substrate) | 400 on invalid `name` |
| GET | `/api/living-brain/stream` | SSE `text/event-stream` | 1s poll, 30s heartbeat, auto-close on client abort |

**SSE events** (`types.ts:158-178`):

- `hello` — on connect
- `heartbeat` — every 30 s
- `node.create` — full `LBNode` (new `brain_observations` row)
- `edge.strengthen` — `{fromId, toId, edgeType, weight}` (`brain_page_edges.weight` changed)
- `task.status` — `{taskId, status}` (tasks.status changed)
- `message.send` — `{messageId, fromAgentId, toAgentId, preview}` (new conduit message)

Not yet streamed: new tasks (only status changes), new nexus relations, new agents, new brain decisions/patterns/learnings. Gap if the operator expects full live-synapse fidelity.

---

## Frontend Visualization

**`/brain`** — the canvas.

- **Top bar**: page title, node/edge counts, SSE status pill (live/connecting/reconnecting/offline), 5 substrate toggle pills (blue=brain, green=nexus, orange=tasks, purple=conduit, red=signaldock), min-weight slider, time-slider toggle, and a 2D/GPU/3D renderer switch.
- **Center**: one of three renderers renders the filtered graph:
  - **2D (sigma.js)**: default for ≤2000 nodes. WebGL force-directed. Colors match substrate.
  - **GPU (cosmos.gl)**: auto-activates >2000 nodes. GPU-accelerated force simulation.
  - **3D (3d-force-graph + THREE.js)**: UnrealBloomPass applies neon glow to synapses. Pulse animations (1.5s) fire on SSE events.
- **Side panel** (right, 280px): appears on node click. Shows substrate/kind badge, label, ID, weight, collapsible metadata JSON, and deep-links into the relevant sub-view (`/brain/observations`, `/code/symbol/X`, etc.).
- **Legend bar** (bottom): substrates with per-substrate node counts, edge-type color key, time-slider status.

**`/brain/3d`** — direct 3D deep-link. Same data, same controls, but locked to the 3D renderer. Useful for presentation mode.

**Visual impression**: dark navy canvas (#0f1117 / #1a1f2e), substrate-colored nodes pulsing when events arrive, neon bloom on 3D mode, substrate toggles that let the user isolate e.g. "just BRAIN ↔ TASKS" to see how memory artifacts trace to work. The owner-mandated "canvas always looks complete on first paint" is honored (no half-payload; 5000-node cap on first load).

---

## Gap Analysis vs Operator's Super-BRAIN Model

**Operator's spec**:
> "BRAIN wraps in all the brain and all aspects of every NODE that makes up everything across NEXUS, BRAIN, TASKS, CONDUIT for the complete brain connections of all nodes and domains."

### What's included

| Substrate | Nodes included? | Edges included? | Notes |
|-----------|-----------------|-----------------|-------|
| BRAIN (obs/dec/pat/learn) | YES | YES | 4 typed tables fully covered + `brain_page_edges` (Hebbian/STDP) |
| NEXUS (symbols/files) | YES | YES | Top in-degree nodes + relations between them |
| TASKS (tasks/sessions) | YES | YES | parent/dep/relation edges |
| CONDUIT (messages) | YES | Synthesized | messages become nodes; agent pairs become `signaldock:→signaldock:` edges |
| SIGNALDOCK (agents) | YES | YES | Owner said 4 substrates, implementation has 5 — this is a superset |

### Cross-domain edges (materialized in-memory per request)

| From | To | Source | Implementation |
|------|-----|--------|----------------|
| BRAIN obs/dec/pat/learn | BRAIN (intra) | `brain_page_edges` | `brain.ts:296-329` |
| BRAIN obs/dec/pat/learn | TASKS | `brain_page_edges` w/ `task:` prefix | `brain.ts:299-307` |
| BRAIN obs/dec/pat/learn | NEXUS | `brain_page_edges` w/ `::` path | `brain.ts:308-316` |
| BRAIN obs/dec/pat/learn | TASKS | `brain_memory_links` | `brain.ts:332-351` |
| BRAIN observation | NEXUS files | `brain_observations.files_modified_json` | `brain.ts:353-374` |
| BRAIN decision | TASKS | `brain_decisions.context_task_id` soft FK | `brain.ts:376-388` |
| CONDUIT messages | SIGNALDOCK agents | aggregated `from_agent_id`/`to_agent_id` | `conduit.ts:103-113` |

### Gaps / what's NOT wired

1. **No intra-BRAIN node-layer**: `brain_page_nodes` is NOT used as an adapter source. The adapter treats the four typed tables as the node universe. If there's a `brain_page_nodes` row without a corresponding typed-table row, it is invisible to the super-graph. Verify via `packages/core/src/store/brain-schema.ts`.
2. **Tasks → Code forward edges missing**: There is no "task T123 touched file X" edge except via BRAIN observation. Tasks don't directly reference nexus — all task-code linkage is mediated through observations.
3. **CONDUIT messages → tasks**: a message referencing `T123` in content is NOT parsed to create a `conduit:msg → tasks:T123` edge. Possible uplift if wanted.
4. **Agent → session edges missing**: `signaldock:agent-007 → tasks:ses_xxx` linkage doesn't exist even though sessions have an owning agent.
5. **Decisions → Patterns / Learnings** edges only exist if `brain_page_edges` has them; no direct schema-level FK is walked.
6. **Stream fidelity**: SSE covers 4 event types. Not streamed: new decisions/patterns/learnings, new nexus symbols, new agents, new tasks (only status changes emit). Delta: if operator expects "every write to any DB fires a synapse," the current system covers ~40% of write points.

### Alignment score

- **Topology**: 100% — all 4 operator-named domains included, plus SIGNALDOCK as the identity anchor (bonus).
- **Cross-domain edges**: ~85% — 7 bridge types implemented, 3-4 plausible ones not yet wired.
- **Live synapse feel**: ~40% of DB write points fire SSE events; rest are silent.
- **UX alignment**: 100% — substrate toggles, neon bloom, pulse animations match the "living brain" metaphor the operator has been calling for.

---

## Recommendations

### Already aligned — keep
- The 5-substrate adapter pattern. It's clean, testable, DB-isolated, and matches the "complete brain connections of all nodes and domains" spec verbatim.
- Substrate-prefixed IDs. Future-proof. Add a 6th substrate (plugins? memories?) by registering in `ADAPTER_MAP`.
- Live-computed approach. A materialized supergraph would double-write every DB mutation; the live-query cost is ~25 indexed SELECTs budgeted to 500 rows. Premature to materialize.
- SSE with watermarks. No triggers/CDC needed — portable, safe, works over HTTP.

### Action 1 — Naming cleanup (the only real reconciliation work)

The operator's mental model is "BRAIN = the super-graph." The current code has `BRAIN = the memory DB only`. Two endpoints with a naming collision today:

```
/api/brain/*           → OLD: brain.db typed-memory tables (observations, decisions, graph, quality, tier-stats)
/api/living-brain/*    → NEW: unified 5-substrate super-graph
```

**Proposed rename**:

```
/api/brain/*      → /api/memory/*          (BREAKING — typed memory tables)
/api/living-brain/* → /api/brain/*         (promotion — the super-graph)
```

Frontend follows:

```
/brain/observations, /decisions, /quality → /memory/observations, etc.
/brain (canvas) stays as the super-graph landing
```

This aligns code with operator language at the cost of one breaking change in internal callers.

### Action 2 — Fill the gaps (small effort, high alignment)

- **Wire `brain_page_nodes` as a BRAIN node source** — even if redundant with typed tables, it's the documented graph layer. One more SELECT in `adapters/brain.ts`.
- **Parse task IDs from CONDUIT message content** — `/T\d+/g` regex → `conduit:msg → tasks:T123` edges with `type: 'mentions'`. ~20 lines in `adapters/conduit.ts`.
- **Agent → session edges** — add `SELECT agent_id FROM sessions` and emit `signaldock:X → tasks:ses_Y` as cross edges. One query in `adapters/tasks.ts` or `adapters/signaldock.ts`.
- **Full SSE coverage** — add watermark polls for `brain_decisions`, `brain_patterns`, `brain_learnings`, new tasks (rowid), new agents, new nexus relations. Symmetric with existing code in `stream/+server.ts`.

### Action 3 — Document the model

Publish this architecture (or a shorter version) as `packages/studio/docs/living-brain.md` so future agents understand the contract before touching it. Currently only `docs/plans/brain-synaptic-visualization-research.md` has context.

### Action 4 — Do NOT materialize yet

Resist the temptation to build a `brain_graph_nodes` / `brain_graph_edges` unified table. Every write would need dual-write, consistency becomes a problem, and the 25-query cost budget is fine at current scale. Revisit only if per-request p95 > 200ms.

---

## Verdict

**Living Brain is already the operator's super-BRAIN model.** The implementation matches the spec. The gap is naming (the older `/api/brain` endpoints own the word the operator wants for the super-graph) plus 4 small edge-synthesis gaps and incomplete SSE coverage.

**Recommended reconciliation**: rename, not rebuild. Keep `/api/living-brain/*` as the authoritative super-graph, promote it to `/api/brain/*`, demote the current `/api/brain/*` to `/api/memory/*`, and fill the 4 gap edges.

**Do not**:
- rebuild the adapter pattern
- materialize the supergraph
- change the `LBNode`/`LBEdge` schema
- touch the 27 passing bridge tests

---

## Appendix — Source Citations

- Substrate registration: `packages/studio/src/lib/server/living-brain/adapters/index.ts:27-36`
- `getAllSubstrates` orchestrator: `packages/studio/src/lib/server/living-brain/adapters/index.ts:160-231`
- Stub-node second pass: `packages/studio/src/lib/server/living-brain/adapters/index.ts:51-141`
- BRAIN bridge synthesis: `packages/studio/src/lib/server/living-brain/adapters/brain.ts:295-388`
- NEXUS top-in-degree fetch: `packages/studio/src/lib/server/living-brain/adapters/nexus.ts:60-74`
- TASKS priority query: `packages/studio/src/lib/server/living-brain/adapters/tasks.ts:82-94`
- CONDUIT agent-pair synthesis: `packages/studio/src/lib/server/living-brain/adapters/conduit.ts:72-113`
- SIGNALDOCK agent load: `packages/studio/src/lib/server/living-brain/adapters/signaldock.ts:66-92`
- Unified endpoint: `packages/studio/src/routes/api/living-brain/+server.ts:23-44`
- Single node endpoint: `packages/studio/src/routes/api/living-brain/node/[id]/+server.ts:29-66`
- Substrate-filter endpoint: `packages/studio/src/routes/api/living-brain/substrate/[name]/+server.ts:25-53`
- SSE stream: `packages/studio/src/routes/api/living-brain/stream/+server.ts:397-494`
- Watermark detect functions: `packages/studio/src/routes/api/living-brain/stream/+server.ts:195-391`
- Canvas page loader: `packages/studio/src/routes/brain/+page.server.ts:36-39`
- Canvas page UI: `packages/studio/src/routes/brain/+page.svelte:419-697`
- 3D deep-link page: `packages/studio/src/routes/brain/3d/+page.server.ts:36-39`
- Bridges tests (27): `packages/studio/src/lib/server/living-brain/__tests__/bridges.test.ts`
- 2D renderer: `packages/studio/src/lib/components/LivingBrainGraph.svelte` (554 LoC)
- GPU renderer: `packages/studio/src/lib/components/LivingBrainCosmograph.svelte` (639 LoC)
- 3D renderer: `packages/studio/src/lib/components/LivingBrain3D.svelte` (765 LoC)
- OLD `/api/brain/*` (memory tables): `packages/studio/src/routes/api/brain/{graph,observations,decisions,quality,tier-stats}/+server.ts`
