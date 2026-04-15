# CLEO Living Brain — Plan & Status

> **Doc version**: v3 (grounded in shipped reality, 2026-04-15)
> **Active epic**: [T627 — Stabilization + Phase 2 RCASD](https://github.com/) (Phase 1 epic [T626](https://github.com/) is **done**)
> **Owner**: keatonhoskins@gmail.com
> **Subject**: Visualize and instrument CLEO's typed memory + code intelligence + tasks + messaging across all substrates as a single, plastic, living graph.
> **STDP details**: factored into [docs/plans/stdp-feasibility.md](./stdp-feasibility.md)

---

## §0 Locked Decisions (read first)

| ID | Decision | Rationale (one-line) |
|---|---|---|
| D-BRAIN-VIZ-01 | Stack: **Cosmograph** (GPU 2D) + **3d-force-graph** (3D hero) + **Graphology** (browser SSoT) + **SSE** (live feed) | Cosmograph for 1M-node ceiling; 3d-force-graph for brain aesthetic; Graphology as renderer-agnostic model |
| D-BRAIN-VIZ-02 | **Option B** — one unified canvas with substrate filter toggles (not separate views per DB) | Cross-layer insight is the value; A loses it, C doubles client complexity |
| D-BRAIN-VIZ-03 | **Five substrates**, not four — include SIGNALDOCK | Agent identity is the cross-project bridge; without it the meta-brain is incomplete |
| D-BRAIN-VIZ-04 | Preserve shipped Hebbian strengthener during STDP upgrade (feature-flagged coexistence) | `strengthenCoRetrievedEdges` works; STDP v2 runs alongside until validated |
| D-BRAIN-VIZ-05 | Rename emitted edge `relates_to` → `co_retrieved`; add `co_retrieved` + `code_reference` to `BRAIN_EDGE_TYPES` | Both edge types are emitted by shipped code but missing from the Drizzle enum (raw SQL bypasses the check) |
| D-BRAIN-VIZ-06 | Cross-project meta-brain is **Phase 4**, not MVP | Single-project unified view ships first; meta-brain compounds on top |
| D-BRAIN-VIZ-07 | Use **vanilla `3d-force-graph`** (not the React wrapper) — Studio is SvelteKit | No React runtime; vanilla build imports cleanly |
| D-BRAIN-VIZ-08 | STDP gets its own epic (Phase 5) with an owner checkpoint | Schema changes + algorithm tuning warrant a dedicated decision gate |
| D-BRAIN-VIZ-09 | We build **STDP-*inspired*** plasticity, NOT biological STDP | SNN frameworks (BindsNET/Nengo/Brian2) are wrong tool class. Algebraic edge-weight updates at batch cadence — SQLite handles it |
| D-BRAIN-VIZ-10 | Keep `sqlite-vec` (already loaded); skip sqliteai's `sqlite-vector` / `sqlite-memory` / `sqlite-rag` / `sqlite-agent` | sqlite-vec is MIT/Apache and shipped. sqliteai's are Elastic License 2.0 + would replace our T549 model |
| D-BRAIN-VIZ-11 | Evaluate `sqlite-ai` in Phase 6+, not now | Could replace `@huggingface/transformers`, but Elastic License needs review and we shouldn't churn before viz ships |
| D-BRAIN-VIZ-12 | SQLite scale ceiling is **not a concern** for this workload | 2M edges ≈ 200 MB, 10–50K UPDATEs/sec WAL, batch decay <10 s — 10× margin |
| D-BRAIN-VIZ-13 | Consider R-STDP via `brain_retrieval_log.reward_signal` column | Task completion + verification signals already exist; reward gating is the dopamine third-factor analog at near-zero cost |

---

## §1 Status Truth Table (what shipped / what's open)

| Phase | Scope | Status | Evidence | Tracking task |
|---|---|---|---|---|
| **0** | Schema audit + cross-link reality assessment | ✅ DONE | This doc + memory `brain-living-initiative.md` | T626 |
| **1a** | `/living-brain` route + 5-substrate API + filter toggles | ✅ DONE | `packages/studio/src/routes/living-brain/+page.svelte` (loaded), `LivingBrainGraph.svelte`, `LBNode/LBGraph/LBSubstrate` types | T626 |
| **1b** | `/brain` overview page + stats | ✅ DONE | `packages/studio/src/routes/brain/+page.server.ts` (8 stat cards) | T620 |
| **1c** | `/brain/graph` route — typed nodes + edges | ✅ DONE | `packages/studio/src/routes/brain/graph/+page.svelte`, `BrainGraph.svelte` | T620 |
| **1d** | `/brain/decisions`, `/brain/observations`, `/brain/quality` | ✅ DONE | Routes present | T620 |
| **2a** | LBNode.createdAt + working time slider | 🟡 IN PROGRESS | TODO at `living-brain/+page.svelte:299` | **T635** |
| **2b** | SSE live synapses (pulse on memory write / Hebbian strengthen / task status / nexus reindex) | 🔴 OPEN | No SSE endpoint exists | **T635** |
| **2c** | Cosmograph spike for >2K node graphs | 🔴 OPEN | Not integrated; current renderer is custom force layout | **T635** |
| **3a** | Enum drift fix (`co_retrieved` + `code_reference` into `BRAIN_EDGE_TYPES`) | 🔴 OPEN | `packages/core/src/store/brain-schema.ts` enum needs 2 additions | TBD task |
| **3b** | Backfill missing bridge edges (decisions→tasks, observations→symbols/files via regex) | 🔴 OPEN | Most decisions have `context_task_id` but no `brain_page_edges` row | TBD task |
| **4** | Cross-project meta-brain (multiple `nexus.project_registry` projects unified) | 🔴 OPEN | Schema needed: `nexus_cross_project_edges` | TBD epic |
| **5** | STDP-inspired plasticity upgrade | 🔴 OPEN | Spec at `docs/plans/stdp-feasibility.md` | TBD epic |
| **6** | 3D hero view (`3d-force-graph`) | 🔴 OPEN | Not integrated | TBD task |
| **7** | Polish (filters, snapshot export, cross-references, query bar) | 🔴 OPEN | Filters partially in place (substrate + weight) | TBD task |

**Active stabilization tasks under T627**: T628 (auto-dream cycle), T629 (provider-agnostic memory), T630/T633 (CI fixes), T632 (migration reconciler bandaid), **T634** (this doc), **T635** (Studio Phase 2).

---

## §2 Context

The user asked whether [sigma.js](https://github.com/jacomyal/sigma.js) was the right pick for a "live synaptic" view of the AI brain. Research reframed it as a **substrate** project, not a viz project: CLEO already had nearly all the pieces of a living, plastic, cross-layer knowledge graph — they just didn't visualize or cross-connect.

**CLEO state at start (.cleo/nexus-bridge.md, 2026-04-15)**:
- 2,374 files indexed
- 11,195 symbols (4,503 functions, 1,848 interfaces, 787 methods, 537 type aliases, …)
- 22,505 relations (10,766 calls, 2,752 imports, 77 extends)
- 6 functional clusters, 75 traced execution flows

**Foundational decisions already in place**:
- D008 — 7-technique memory architecture (LLM extraction, dedup, observer/reflector, temporal supersession, **graph memory bridge**, sleep-time consolidation, retrieval)
- D009 — Keep brain.db on SQLite + Drizzle (don't migrate to LadybugDB/Kùzu)
- T549 — Tiered + typed memory shipped (tiers, cognitive types, source confidence, bitemporal validity, citation counts)
- T523 — BRAIN integrity work shipped
- T513 — NEXUS pipeline shipped
- T577 — CLEO Studio (SvelteKit + Hono on port 3456)

---

## §3 Substrate Map at a Glance

| Substrate | Scope | Schema (verify with) | Graph layer? | Cross-link surface |
|---|---|---|---|---|
| **NEXUS** | global | `packages/core/src/store/nexus-schema.ts` (verify: `cleo nexus status`) | `nexus_nodes` (31 kinds) + `nexus_relations` (22 types incl. **`documents`** + **`applies_to`** for brain bridge) | `project_registry.brain_db_path` + `.tasks_db_path` per project |
| **BRAIN** | per-project | `packages/core/src/store/brain-schema.ts` (verify: `cleo memory graph-stats`) | `brain_page_nodes` (12 kinds incl. file/symbol/task/session) + `brain_page_edges` (12 types incl. **`references`** / **`documents`** / **`applies_to`** / **`modified_by`**) | `brain_decisions.context_task_id` + `brain_memory_links.task_id` + `brain_observations.source_session_id` |
| **TASKS** | per-project | `packages/core/src/store/tasks-schema.ts` (verify: `cleo dash`) | Implicit graph: `tasks.parent_id` (hierarchy) + `task_dependencies` + `task_relations` (7 types) | `tasks.assignee` (signaldock agent), `tasks.session_id`, `external_task_links` |
| **CONDUIT** | per-project | `packages/core/src/store/conduit-sqlite.ts` (verify: `cleo conduit status`) | Implicit: `messages.from_agent_id` ↔ `to_agent_id` + `attachment_contributors`, FTS5 over content | `project_agent_refs.agent_id` (signaldock soft FK) |
| **SIGNALDOCK** | global | `packages/core/src/store/signaldock-sqlite.ts` | `agent_connections` (cross-agent social) | Touched by every other DB via `agent_id` |

**Verification commands** (each row above):
```bash
cleo nexus status               # Verify nexus.db node/relation counts
cleo memory graph-stats         # Verify brain.db page_nodes/page_edges counts
cleo dash                       # Verify tasks.db live counts
cleo conduit status             # Verify conduit.db messaging
cleo agent list                 # Verify signaldock.db agent identity
```

---

## §4 Cross-Substrate Edge Reality

### §4.1 Edges that already exist (shipped)

```
NEXUS (global)                            BRAIN (project)
  project_registry                          brain_decisions.context_task_id ─→ TASKS
    .brain_db_path                          brain_decisions.context_epic_id ─→ TASKS
    .tasks_db_path                          brain_observations.source_session_id ─→ TASKS
  nexus_relations.type ∈ {                  brain_observations.files_modified_json[*]
    'documents',  ←─ brain bridge           brain_memory_links.task_id ─→ TASKS
    'applies_to'  ←─ brain bridge           brain_page_nodes.node_type ∈ {file, symbol, task, session, epic}
  }                                         brain_page_edges.edge_type ∈ {references, documents, modified_by, applies_to, part_of}

CONDUIT (project)                         SIGNALDOCK (global)
  messages.from_agent_id ─→ SIGNALDOCK      agents.agent_id    ←─ touched by all DBs
  messages.to_agent_id   ─→ SIGNALDOCK      agent_connections   (cross-agent social)
  project_agent_refs.agent_id ─→ SIGNALDOCK
```

### §4.2 Edges that SHOULD exist but don't yet

| From | To | Edge | Status | Phase |
|---|---|---|---|---|
| `brain_decisions.context_task_id` | `tasks.id` | `applies_to` row in `brain_page_edges` | MISSING — backfill needed | 3b |
| `brain_observations.files_modified_json[*]` | `nexus_nodes` (file) | `modified_by` in `brain_page_edges` | MISSING — extractor needed | 3b |
| `brain_observations` content (regex symbol-FQNs) | `nexus_nodes` (symbol) | `references` / `code_reference` | PARTIAL — `cleo memory code-auto-link` exists but enum-drift bug | 3a + 3b |
| `tasks.files_json[*]` | `nexus_nodes` (file) | `tasks_over_file` (synthesized) | MISSING — schema needed | 3b |
| `conduit.messages.content` (FTS5) → memory IDs / task IDs / FQNs | `mentions` | MISSING — extractor needed | 7 |
| `agents.agent_id` | (`tasks` ∪ `observations` ∪ `messages`) | `authored_by` (unified across DBs) | MISSING — view-layer query | 4 |
| `project_registry.project_id` A ↔ B | `shares_pattern` / `shares_decision` / `shares_agent` / `shares_symbol` | MISSING — needs `nexus_cross_project_edges` table | 4 |

---

## §5 Hebbian Plasticity Substrate (already shipped)

**Location**: `packages/core/src/memory/brain-lifecycle.ts:911` — `strengthenCoRetrievedEdges`

**What it does today**:
1. Reads `brain_retrieval_log` for retrievals in the last 30 days
2. Counts every unordered pair from each retrieval's `entry_ids` JSON array
3. For pairs with count ≥ 3 → strengthen edge weight by 0.1 (capped at 1.0); insert edge with weight 0.3 if absent
4. Wired as step 6 of `runConsolidation` (brain-lifecycle.ts:606), which fires from session-end hook

**Verify it works**:
```bash
cleo memory consolidate          # Triggers full lifecycle including step 6
cleo memory graph-stats          # Should show non-zero edges with provenance='consolidation:co-retrieval'
```

**Known issue (D-BRAIN-VIZ-05, fixed in Phase 3a)**: emits `edge_type='relates_to'` which is **not** in `BRAIN_EDGE_TYPES`. Works only because `INSERT OR IGNORE` uses raw SQL bypassing Drizzle's enum check. Same drift affects `cleo memory code-auto-link` which emits `code_reference` (also missing from enum).

**Gaps for full STDP** — see [stdp-feasibility.md](./stdp-feasibility.md).

---

## §6 Unified Architecture

### §6.0 Target architecture (where Phases 2–7 land us)

The aspirational stack — what every phase converges on:

```
┌─ Hero view: 3d-force-graph (ThreeJS)              ← "the brain"
│   • typed node shapes (obs / learn / pat / dec / decision / symbol / task)
│   • edge animation on memory-write events via SSE
│   • VR variant available for demo
│   • plasticity edges pulse on Hebbian/STDP strengthen
│
├─ Analytics view: Cosmograph (2D, GPU)             ← "scale mode"
│   • 11K+ NEXUS symbols + BRAIN entries together
│   • cluster coloring by functional community
│   • 1M-node headroom for long-term growth
│   • activates when payload > 2K nodes (toggle below that)
│
├─ Data layer: Graphology                           ← "browser SSoT"
│   • same graph object feeds both renderers
│   • PageRank highlights load-bearing memories
│   • import from GEXF / export for snapshots
│   • shared model across /living-brain and /brain/graph routes
│
└─ Live wire: SSE from substrate hooks              ← "synapses firing"
    • every `cleo memory observe` → pulse the relevant node
    • Hebbian/STDP edge strengthen → animate the affected edge
    • task status change → tint task node by new state
    • nexus reindex → ripple over touched code subgraph
    • session end → fade/consolidate unused nodes
```

### §6.1 Current shipped state (T620 + T626 + Phase 1)

What `/living-brain` actually renders today, mapped to the target above:

```
┌─ /living-brain (SHIPPED) ─────────────────────────────────────────────────┐
│                                                                            │
│   Renderer:  LivingBrainGraph.svelte (custom force layout)                 │
│              ↑ Phase 2c will swap to Cosmograph for >2K nodes              │
│              ↑ Phase 6  will add 3d-force-graph hero route                 │
│                                                                            │
│   Browser model: derived $state from server payload                        │
│              ↑ Phase 2  will introduce Graphology as in-browser SSoT       │
│                                                                            │
│   API:                                                                     │
│      ✅ GET /api/living-brain?limit=N   → LBGraph                          │
│      ✅ GET /api/living-brain/node/:id  → LBNode detail                    │
│      🔴 GET /api/living-brain/stream    → SSE (Phase 2b — T635)            │
│                                                                            │
│   Substrates: brain | nexus | tasks | conduit | signaldock  ✅             │
│   Filters:    substrate toggles ✅, weight slider ✅, time slider 🟡 (T635) │
│   Edges UI:   supersedes / affects / applies_to / calls / co_retrieved /   │
│               mentions ✅                                                  │
└────────────────────────────────────────────────────────────────────────────┘

┌─ Backing data sources (read by Studio API) ─────────────────────────────────┐
│   ✅ brain.db   page_nodes + page_edges + typed tables + retrieval_log      │
│   ✅ nexus.db   nodes + relations (cross-project)                           │
│   ✅ tasks.db   tasks + sessions + dependencies + relations                 │
│   ✅ conduit.db messages + attachments + project_agent_refs                 │
│   ✅ signaldock.db (global) agents + connections                            │
└─────────────────────────────────────────────────────────────────────────────┘

┌─ SSE event taxonomy (Phase 2b — T635) ──────────────────────────────────────┐
│   • brain_retrieval_log INSERT trigger     → SSE event 'retrieval'          │
│   • brain_page_edges UPDATE (Hebbian)      → SSE event 'edge.strengthen'    │
│   • brain_observations INSERT              → SSE event 'node.create'        │
│   • tasks.status UPDATE                    → SSE event 'task.status'        │
│   • nexus phase transition                 → SSE event 'nexus.reindex'      │
│   • conduit.messages INSERT                → SSE event 'message.send'       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### §6.2 Why this specific stack

- **Cosmograph** gives the **scale ceiling** — 1M nodes on GPU, no re-architect as BRAIN grows
- **3d-force-graph** gives the **living synapses** visual — demo-worthy, rotating 3D, VR-capable
- **Graphology** is the **shared in-memory model** both renderers consume — avoids dual sources of truth
- **SSE** keeps the live wire **simple** — no WebSocket session management, no reconnect protocols, just an event stream
- All four are **framework-agnostic** → Svelte-friendly, no React runtime needed (D-BRAIN-VIZ-07)

---

## §7 Phase Plan (sized + status + kill criteria)

> Sizing per CLEO norms (`small` / `medium` / `large`). No time estimates per project-context.json.

### Phase 1 — Static unified brain `(large) ✅ DONE`

`/living-brain` + `/brain/*` routes shipped under T620 + T626.
**Kill criteria (would have been)**: graph payload >5MB on cold load; render frame stalls >250ms.

### Phase 2 — Live + interactive `(large) 🟡 IN PROGRESS [T635]`

- 2a. LBNode.createdAt projection + time slider
- 2b. SSE endpoint with 5 event types
- 2c. Cosmograph spike behind a toggle for >2K nodes

**Kill criteria**: SSE adds >50% server CPU at idle, OR Cosmograph integration breaks any existing route. Roll back the 2c bit and ship 2a + 2b only.

### Phase 3 — Schema & backfill `(medium) 🔴 OPEN`

- 3a. Enum drift fix: add `co_retrieved` + `code_reference` to `BRAIN_EDGE_TYPES`. One-shot migration relabels `'relates_to'` → `'co_retrieved'`.
- 3b. Backfill missing bridge edges (decisions→tasks, observations→files/symbols).

**Kill criteria**: backfill produces >10× the existing edge count (graph becomes unreadable). Cap with quality threshold.

### Phase 4 — Cross-project meta-brain `(large) 🔴 OPEN`

- New table `nexus_cross_project_edges` in nexus.db
- Analyzers: pattern-hash compare, agent-membership, symbol-FQN match, owner-flagged decisions
- Studio `/living-brain?scope=meta` renders union with `project_id` as cluster color

**Kill criteria**: privacy concerns when shared workspaces leak project-A context into project-B view. Require explicit owner opt-in per project pair.

### Phase 5 — STDP-inspired plasticity `(large, owner-checkpoint) 🔴 OPEN`

- Schema additions per [stdp-feasibility.md](./stdp-feasibility.md) §3
- Algorithm per [stdp-feasibility.md](./stdp-feasibility.md) §4 (LTP/LTD with exponential Δt windows + decay + pruning)
- Optional R-STDP via `reward_signal` column

**Kill criteria**: weight distribution becomes pathologically bimodal (everything 0.05 or 1.0); LTD prunes >10% of edges per consolidation pass.

### Phase 6 — 3D hero view `(medium) 🔴 OPEN`

- `/living-brain/3d` route using vanilla `3d-force-graph` (NOT React wrapper)
- Same Graphology instance, ThreeJS renderer
- Floating HTML labels via Svelte `{#each}` + projected coords (no `<Html>` from drei)
- Optional `EffectComposer` + `UnrealBloomPass` for glow

**Kill criteria**: 3D view requires >1 GB GPU memory, OR breaks on Linux/Wayland. Ship 2D as primary; 3D is hero/demo only.

### Phase 7 — Polish `(medium) 🔴 OPEN`

- Filter panel: time range, plasticity class, agent
- Snapshot export: PNG / GEXF / JSON / SVG
- Query bar: "show me everything agent X touched"
- Subgraph highlight on `cleo memory find` queries

**Kill criteria**: feature creep delays ship. Time-box; defer items past N tasks to a future epic.

---

## §8 Open Questions

1. SSE event volume — should we batch + debounce or stream every event?
2. Cosmograph adoption gating — keep custom force layout as default, or replace once Cosmograph is stable for our payload?
3. Time slider granularity — daily (current shipped pattern in `/brain/graph`), hourly, or wall-clock?
4. Cross-project edges privacy default — opt-in per project pair, or opt-out?
5. R-STDP scope — do we wire reward signals to all plasticity classes or only `stdp` class?

---

## §9 Sources

### Library research

#### Cosmograph / cosmos.gl (D-BRAIN-VIZ-01 primary)
- [Cosmograph docs — Concept](https://cosmograph.app/docs-general/concept/)
- [Cosmograph docs — Introduction](https://cosmograph.app/docs-general/)
- [Cosmograph docs — How to use](https://cosmograph.app/docs-app/)
- [cosmos.gl on GitHub (GPU-accelerated force graph)](https://github.com/cosmosgl/graph)
- [Introducing cosmos.gl — joined OpenJS Foundation (2026)](https://openjsf.org/blog/introducing-cosmos-gl)
- [cosmos architecture deep dive (DeepWiki)](https://deepwiki.com/cosmograph-org/cosmos)
- [Cosmograph — Information is Beautiful Awards](https://www.informationisbeautifulawards.com/showcase/5231-cosmograph)
- [@sqlrooms/cosmos (third-party SQL-aware wrapper)](https://sqlrooms.org/api/cosmos/)

#### 3d-force-graph (D-BRAIN-VIZ-07 hero view)
- [3d-force-graph (ThreeJS/WebGL)](https://github.com/vasturiano/3d-force-graph)
- [3d-force-graph demo](https://vasturiano.github.io/3d-force-graph/)
- [3d-force-graph-vr (A-Frame)](https://github.com/vasturiano/3d-force-graph-vr)
- [react-force-graph (the React wrapper we're NOT using)](https://github.com/vasturiano/react-force-graph)

#### Sigma.js + Graphology (original ask, kept as analytics-fallback)
- [sigma.js on GitHub](https://github.com/jacomyal/sigma.js)
- [Graphology (data layer)](https://graphology.github.io/)
- [A Look At Graph Visualization With Sigma React (William Lyon)](https://lyonwj.com/blog/sigma-react-graph-visualization)

#### AI memory systems (architectural peers)
- [Graphiti — Real-Time Knowledge Graphs for AI Agents (getzep)](https://github.com/getzep/graphiti)
- [InfraNodus — AI Text Analysis with Knowledge Graph](https://infranodus.com)
- [NVIDIA txt2kg (Text → KG with Three.js WebGPU)](https://build.nvidia.com/spark/txt2kg)
- [AI Knowledge Graph Generator (robert-mcdermott)](https://github.com/robert-mcdermott/ai-knowledge-graph)
- [Awesome Knowledge Graph (totogo)](https://github.com/totogo/awesome-knowledge-graph)

#### Comparative & landscape
- [Top 10 JavaScript Libraries for Knowledge Graph Visualization (Focal)](https://www.getfocal.co/post/top-10-javascript-libraries-for-knowledge-graph-visualization)
- [A Comparison of JavaScript Graph / Network Visualisation Libraries (Cylynx)](https://www.cylynx.io/blog/a-comparison-of-javascript-graph-network-visualisation-libraries/)
- [Best Libraries and Methods to Render Large Force-Directed Graphs (Stephen, Medium)](https://weber-stephen.medium.com/the-best-libraries-and-methods-to-render-large-network-graphs-on-the-web-d122ece2f4dc)
- [How to Visualize a Graph with a Million Nodes (Nightingale)](https://nightingaledvs.com/how-to-visualize-a-graph-with-a-million-nodes/)
- [Top 13 JavaScript graph visualization libraries (Linkurious)](https://linkurious.com/blog/top-javascript-graph-libraries/)

### CLEO internal references (verified during plan grounding)

#### Schema files (v3 grounded against these on 2026-04-15)
- `packages/core/src/store/brain-schema.ts` — BRAIN typed tables + graph layer + retrieval log + 12-element edge enum
- `packages/core/src/store/nexus-schema.ts` — `project_registry` (with brain_db_path / tasks_db_path) + `nexus_nodes` (31 kinds) + `nexus_relations` (22 types)
- `packages/core/src/store/tasks-schema.ts` — tasks + sessions + dependencies + lifecycle + agents + warp chains + external links
- `packages/core/src/store/conduit-sqlite.ts` — conduit.db raw DDL (messages + FTS5 + attachments + project_agent_refs)
- `packages/core/src/store/signaldock-sqlite.ts` — global agent identity

#### Shipped code referenced by this plan
- `packages/core/src/memory/brain-lifecycle.ts:911` — `strengthenCoRetrievedEdges` (Hebbian, shipped)
- `packages/core/src/memory/brain-retrieval.ts:1415` — `logRetrieval` (retrieval log writer)
- `packages/core/src/store/brain-sqlite.ts:172` — `loadBrainVecExtension` (sqlite-vec loader)
- `packages/core/src/store/brain-sqlite.ts:192` — `initializeBrainVec` (vec0 virtual table)
- `packages/studio/src/routes/living-brain/+page.svelte` — main /living-brain page (5-substrate filters + weight slider + side panel)
- `packages/studio/src/lib/components/LivingBrainGraph.svelte` — current renderer (custom force layout)
- `packages/studio/src/lib/server/living-brain/types.ts` — LBNode/LBGraph/LBSubstrate

#### Live state files
- `.cleo/nexus-bridge.md` — auto-generated nexus index stats
- `.cleo/memory-bridge.md` — auto-generated BRAIN bridge (recent decisions, learnings, observations)

#### Tasks
- T577 — CLEO Studio (SvelteKit + Hono on port 3456)
- T620 — BRAIN Studio View (knowledge graph + memory tiers + decisions timeline) **DONE**
- T626 — EPIC: T-BRAIN-LIVING — Unified 5-substrate Living Brain **DONE**
- T627 — EPIC: T-BRAIN-LIVING Stabilization + Phase 2 RCASD **ACTIVE**
- T634 — Doc v3 (this doc)
- T635 — Studio Phase 2 (time slider + SSE + Cosmograph spike)
- T549 — Tiered + typed memory (shipped — gave us tiers, cognitive types, source confidence, bitemporal, citation counts)
- T513 — Native Code Intelligence Pipeline
- T523 — BRAIN integrity work
- T5157 — sqlite-vec integration

### Vector / extension landscape (D-BRAIN-VIZ-10..11)
- [sqlite-vec (asg017, Mozilla Builders) — what we use](https://github.com/asg017/sqlite-vec)
- [sqlite-ai (sqliteai.com) — defer to Phase 6+](https://github.com/sqliteai/sqlite-ai)
- [sqlite-vector (sqliteai.com) — skip](https://github.com/sqliteai/sqlite-vector)
- [sqlite-memory (sqliteai.com) — skip](https://github.com/sqliteai/sqlite-memory)
- [sqlite-rag (sqliteai.com) — skip](https://github.com/sqliteai/sqlite-rag)
- [sqlite-agent (sqliteai.com) — skip](https://github.com/sqliteai/sqlite-agent)

### STDP / SNN reference (full details in [stdp-feasibility.md](./stdp-feasibility.md))
- [BindsNET (PyTorch SNN)](https://github.com/BindsNET/bindsnet)
- [Brian2 simulator](https://briansimulator.org/)
- [Inferno SNN framework (2024)](https://arxiv.org/html/2409.11567v1)
- [Synaptic scaling + Hebbian plasticity (SPaSS, Frontiers 2012)](https://www.frontiersin.org/journals/computational-neuroscience/articles/10.3389/fncom.2012.00036/full)
- [Hebbian + gradient plasticity in Transformers (OpenReview)](https://openreview.net/forum?id=34No0A0V56)
- [LadybugDB (still ruled out per D009)](https://github.com/LadybugDB/ladybug)
- [SQLite performance tuning (phiresky's gist)](https://gist.github.com/phiresky/978d8e204f77feaa0ab5cca08d2d5b27)

---

## §10 Next Actions

- [ ] T635 (Studio Phase 2) — worker spawned, time slider first
- [ ] Create Phase 3a task: enum drift fix in `BRAIN_EDGE_TYPES`
- [ ] Create Phase 3b task: backfill bridge edges
- [ ] Owner-checkpoint conversation for STDP (Phase 5) — pre-read [stdp-feasibility.md](./stdp-feasibility.md)
- [ ] When T635 ships: re-render this doc to mark Phase 2 ✅ DONE
