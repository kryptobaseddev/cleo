# BRAIN Synaptic Visualization — Research & Implementation Plan

> **Status**: Research complete, ready for prototyping
> **Date**: 2026-04-15
> **Owner**: keatonhoskins@gmail.com
> **Goal**: Build a live, visual brain mapping of CLEO's typed memory (observations, learnings, patterns, decisions) + NEXUS code intelligence (11K+ symbols, 22K+ relations). User-requested reference: [sigma.js](https://github.com/jacomyal/sigma.js).
> **Integration target**: `packages/studio` (SvelteKit + Hono, port 3456)

---

## 1. Context

The user asked whether [sigma.js](https://github.com/jacomyal/sigma.js) is the right pick — *or if something better exists* — for a "live synaptic" view of the AI brain: the nodes and edges of knowledge spanning observations, learnings, patterns, and decisions.

Relevant CLEO state:

- **BRAIN** database stores typed memory (`observation`, `learning`, `pattern`, `decision`).
- **NEXUS** code intelligence: 11,195 symbols, 22,505 relations, 6 functional clusters, 75 execution flows (per `.cleo/nexus-bridge.md`, 2026-04-15).
- **CLEO Studio** exists at `packages/studio` — SvelteKit + Hono on port 3456 (T577).
- Decision D008 already commits to a 7-technique memory architecture (LLM extraction, dedup, observer/reflector, temporal supersession, graph memory bridge, sleep-time consolidation, retrieval).
- Decision D009 explicitly keeps `brain.db` on SQLite + Drizzle — this plan concerns **visualization**, not storage migration.

---

## 2. Research Summary — The Graph Viz Landscape (April 2026)

### 2.1 Library tiers at a glance

| Library | Rendering | Scale ceiling | Physics | Built-in analytics | Fit for CLEO |
|---|---|---|---|---|---|
| **Cosmograph / cosmos.gl** | WebGL 2 (luma.gl) | **1M+ nodes** | **GPU** (full simulation on GPU) | Clustering, sampling | 🥇 **Primary — scale mode** |
| **3d-force-graph** (vasturiano) | ThreeJS / WebGL (3D) | ~50K nodes | d3-force-3d (CPU) | None | 🥈 **Hero view — "the brain"** |
| **Sigma.js + Graphology** | WebGL | ~100K rendering, ~50K layout | ForceAtlas2 (CPU) | PageRank, centrality, communities | 🥉 **Analytics-first alt** |
| Cytoscape.js | Canvas / SVG | ~10K | Multiple | Rich (PageRank, shortest path, etc.) | ❌ Too slow past 10K |
| react-force-graph | Canvas / WebGL | As above | As above | None | ❌ React-only (we're on Svelte) |
| AntV G6 | Canvas / SVG / WebGL | ~50K | Multiple | Built-in | ❌ Heavier API, less brain-aesthetic |
| D3 force layout | SVG / Canvas | ~5K | CPU | DIY | ❌ Roll-your-own when better exists |
| Graphistry | WebGL + GPU backend | Enterprise | Server-side | Rich | ❌ Commercial SaaS |
| KeyLines / ReGraph | Canvas / WebGL | Enterprise | Multiple | Rich | ❌ Commercial license |

### 2.2 AI-memory-specific systems (not just viz)

| System | What it is | Why it matters |
|---|---|---|
| **Graphiti (by Zep)** | Temporal knowledge graph engine for AI agents | Tracks fact evolution, provenance, incremental ingestion, hybrid retrieval (semantic + BM25 + graph). Architectural peer to CLEO BRAIN's D008 direction. |
| **Zep** | Production memory layer for LLMs | Stores conversation → facts → knowledge graph → temporal retrieval. |
| **MCP Memory Servers** | Local knowledge-graph memory for agents | Not relevant — CLEO removed MCP 2026-04-04. |
| **Microsoft GraphRAG** | Entity/relation extraction for RAG | Reference architecture for BRAIN extraction pipeline. |
| **LangGraph** | Stateful agent-as-graph | Orthogonal — control-flow modeling, not memory viz. |
| **InfraNodus** | Text → knowledge graph analysis UI | Good UX reference for how to *present* a brain. |
| **NVIDIA txt2kg** | Text → knowledge graph w/ Three.js WebGPU | Reference for GPU-accelerated render choices. |

---

## 3. Deep-Dive: The Top 3 Options

### 🥇 Cosmograph / cosmos.gl — **the real answer for "live synaptic brain"**

**What it is**: A WebGL-based force-graph engine where **both the force simulation and rendering run on the GPU** via fragment/vertex shaders. Cosmograph is the productized toolkit; `cosmos.gl` is the core engine.

**Why it beats Sigma.js for this use case**:

- Sigma runs rendering on GPU but layout on CPU (ForceAtlas2 via Graphology) — chokes past ~50K nodes.
- Cosmograph runs **everything** on GPU → real-time physics on 100K–1M nodes on a laptop.
- Dragging a node re-heats the simulation → the whole brain visibly reacts. **This is the exact "synapses firing" aesthetic the user described.**

**2026 updates** (from [cosmos.gl repo](https://github.com/cosmosgl/graph) & [OpenJSF announcement](https://openjsf.org/blog/introducing-cosmos-gl)):

- Joined the **OpenJS Foundation** in 2026 (first-class open-source governance).
- Rendering ported from `regl` → **luma.gl (WebGL 2)**, supports sharing a `Device` across multiple graphs.
- **Async init**: constructor returns immediately; all methods queue until `graph.ready` fires.
- Simulation separated from rendering — `start()`, `stop()`, `pause()`, `unpause()`.
- `getSampledLinks()` / `getSampledLinkPositionsMap()` for rendering overlays/labels on visible links.
- Context-menu callbacks: `onContextMenu`, `onPointContextMenu`, `onLinkContextMenu`, `onBackgroundContextMenu`.
- Point clustering force (`setPointClusters`, `setClusterPositions`, `setPointClusterStrength`).
- Drag-to-reposition points.

**Python widget** available for Jupyter (useful later if we want the owner's notebook to show BRAIN too).

**Limitations**:

- iOS versions < 15.4 broke the `EXT_float_blend` WebGL extension — latest iOS works again.
- Android devices without `OES_texture_float` can't run it.
- Graph physical space has a max size — millions of nodes may not all fit even at max space.

---

### 🥈 3d-force-graph (vasturiano) — **if we want the literal "neural brain" visual**

**What it is**: A ThreeJS/WebGL 3D force-directed graph component. Part of a suite: [force-graph (2D Canvas)](https://github.com/vasturiano/force-graph), [3d-force-graph](https://github.com/vasturiano/3d-force-graph), [3d-force-graph-vr](https://github.com/vasturiano/3d-force-graph-vr), 3d-force-graph-ar.

**Why it's on the list**:

- **3D** rotation gives the most literal "neural net / brain" metaphor.
- VR variant uses A-Frame → could preview the brain in a headset.
- Shared JSON data format across all 4 variants (2D/3D/VR/AR) → one pipeline feeds every view.
- Trackball / orbit / fly camera controls.
- Curved bezier links, self-loops, node drag re-heats simulation.

**Versions** (as of April 2026 search):

- `react-force-graph` v1.48.2 (React bindings — not needed for Svelte)
- `react-force-graph-3d` v1.29.1 (2026-04)

**Use as**: the "hero view" — marketing shot, demo reel, public-facing Studio page. Not the primary analytics surface.

**Note**: We'd use `3d-force-graph` (plain) directly in Svelte, not `react-force-graph`, since `packages/studio` is SvelteKit.

---

### 🥉 Sigma.js + Graphology — **still excellent, not the ceiling**

**What it is**: The library the user asked about. WebGL rendering, typed-node "programs" (shapes, images, sprites). Relies on **Graphology** for the data model and layout algorithms.

**Architecture (3-layer)**:

1. **Graphology** — graph data structure, utilities, layouts (ForceAtlas2, Circular, Random), metrics (PageRank, betweenness centrality), import/export (GEXF, GraphML).
2. **Sigma core** — WebGL renderer.
3. **@react-sigma** ecosystem (React-only; not useful for us) or direct Sigma integration with Svelte.

**Strengths for CLEO**:

- Mature, widely deployed for knowledge graphs.
- `NodeImageProgram` — set an `image` attribute per node → Sigma caches and renders it. Perfect for **typed memory icons**: observation 👁️, learning 📘, pattern ♻️, decision ⚖️ (TBD iconography).
- Graphology's **PageRank / community detection** would directly answer: "which memories are load-bearing?" and "what functional clusters exist in the brain?"

**Weaknesses**:

- **Sparse reference docs** — TypeScript types help, but you learn from examples, not a reference.
- Layout on CPU → ForceAtlas2 on 11K+ nodes is a noticeable pause, not a frame-by-frame animation.
- If the goal is literally "see synapses fire in real time at scale", Cosmograph is a better match.

**Keep Sigma in the plan** as an analytics view when we want centrality highlights, community coloring, and static snapshots — Graphology's algorithms are genuinely useful independent of the renderer.

---

## 4. Recommended Stack for CLEO Studio

```
┌─ Hero view: 3d-force-graph (ThreeJS)              ← "the brain"
│   • typed node shapes (obs / learn / pat / dec)
│   • edge animation on memory-write events via SSE
│   • VR variant available for demo
│
├─ Analytics view: Cosmograph (2D, GPU)             ← "scale mode"
│   • 11K+ NEXUS symbols + BRAIN entries together
│   • cluster coloring by functional community
│   • 1M-node headroom for long-term growth
│
├─ Data layer: Graphology                           ← "browser SSoT"
│   • same graph object feeds both renderers
│   • PageRank highlights load-bearing memories
│   • import from GEXF / export for snapshots
│
└─ Live wire: WebSocket / SSE from brain.db hooks   ← "synapses firing"
    • every `cleo observe` → pulse the relevant node
    • memory-consolidation events → animate edge creation
    • session end → fade/consolidate unused nodes
```

**Why this specific stack**:

- **Cosmograph** gives the **scale ceiling** — we never need to re-architect as BRAIN grows.
- **3d-force-graph** gives the **living synapses** visual — demo-worthy, rotating 3D, VR-capable.
- **Graphology** is the **shared in-memory model** both renderers consume — avoids dual sources of truth.
- All three are **framework-agnostic** → Svelte-friendly, no React runtime needed.

---

## 5. Prototype Plan (Incremental)

### Phase 1 — Static brain (1–2 days)

1. Add a command: `cleo nexus export --format gexf` that dumps symbols + relations to [GEXF format](https://gexf.net/) (Graphology has a native importer).
2. Add a command: `cleo memory export --format gexf` that dumps BRAIN typed entries + cross-refs to GEXF.
3. In `packages/studio`, add a `/brain` route that loads both GEXF files into one Graphology instance.
4. Drop into Cosmograph for a static proof-of-scale render.

### Phase 2 — Typed nodes + clustering (1 day)

1. Apply per-type node colors/shapes (obs/learn/pat/dec).
2. Run Graphology community detection; recolor by cluster.
3. Apply Graphology PageRank; scale node size by centrality.

### Phase 3 — Live synapses (2 days)

1. Add an SSE endpoint in Hono: `GET /studio/brain/events` emitting `{nodeId, event, ts}` on every memory write.
2. Wire brain.db hooks to push into the channel.
3. On client, pulse-animate the relevant node when an event arrives.
4. For new nodes: spawn with a "firing" animation; for new edges: draw with a synapse-style animation.

### Phase 4 — 3D hero view (1 day)

1. Add a `/brain/3d` route using `3d-force-graph`.
2. Same Graphology instance, different renderer.
3. Camera controls: orbit by default, trackball toggle.

### Phase 5 — Polish (optional)

1. Filter panel: by type, by cluster, by time range.
2. Snapshot export: PNG / GEXF / JSON.
3. VR demo route (`3d-force-graph-vr`).

---

## 6. Decisions to Lock

- **Primary renderer for analytics view**: Cosmograph (default) vs Sigma (fallback if GPU extensions missing).
- **3D view scope**: ship with initial release, or post-MVP?
- **GEXF vs JSON wire format**: GEXF is richer and round-trips through tools like Gephi, but JSON is simpler. Recommend **both** — GEXF for export/archive, JSON for live SSE feed.
- **Memory → graph-node mapping schema**: needs a short spec. At minimum:
  - `id` — brain entry UUID or symbol FQN
  - `type` — `observation` | `learning` | `pattern` | `decision` | `symbol`
  - `label` — display name
  - `size` — PageRank or confidence
  - `createdAt`, `lastSeenAt` — for temporal fade

---

## 7. Sources (all links)

### Sigma.js ecosystem

- [sigma.js on GitHub](https://github.com/jacomyal/sigma.js) — user-referenced project
- [Graphology (data layer for Sigma)](https://graphology.github.io/)
- [A Look At Graph Visualization With Sigma React (William Lyon)](https://lyonwj.com/blog/sigma-react-graph-visualization)
- [React Sigma.js: The Practical Guide (MENUDO)](https://www.menudo.com/react-sigma-js-the-practical-guide-to-interactive-graph-visualization-in-react/)

### Cosmograph / cosmos.gl (top recommendation)

- [Cosmograph docs — Concept](https://cosmograph.app/docs-general/concept/)
- [Cosmograph docs — Introduction](https://cosmograph.app/docs-general/)
- [Cosmograph docs — How to use](https://cosmograph.app/docs-app/)
- [cosmos.gl — GPU-accelerated force graph (GitHub)](https://github.com/cosmosgl/graph)
- [Introducing cosmos.gl — joined OpenJS Foundation (2026)](https://openjsf.org/blog/introducing-cosmos-gl)
- [cosmosgl GitHub organization](https://github.com/cosmosgl)
- [cosmos architecture deep dive (DeepWiki)](https://deepwiki.com/cosmograph-org/cosmos)
- [Cosmograph — Information is Beautiful Awards](https://www.informationisbeautifulawards.com/showcase/5231-cosmograph)
- [@sqlrooms/cosmos (third-party SQL-aware wrapper)](https://sqlrooms.org/api/cosmos/)

### 3d-force-graph / react-force-graph (vasturiano suite)

- [react-force-graph (React bindings to the suite)](https://github.com/vasturiano/react-force-graph)
- [react-force-graph demo](https://vasturiano.github.io/react-force-graph/)
- [3d-force-graph (ThreeJS/WebGL)](https://github.com/vasturiano/3d-force-graph)
- [3d-force-graph demo](https://vasturiano.github.io/3d-force-graph/)
- [3d-force-graph-vr (A-Frame)](https://github.com/vasturiano/3d-force-graph-vr)
- [3d-force-graph-vr demo](https://vasturiano.github.io/3d-force-graph-vr/)
- [react-force-graph-3d on npm](https://www.npmjs.com/package/react-force-graph-3d)
- [react-force-graph on npm](https://www.npmjs.com/package/react-force-graph)
- [react-force-graph-3d CodeSandbox examples](https://codesandbox.io/examples/package/react-force-graph-3d)
- [Graph Data Visualization With GraphQL & react-force-graph (William Lyon)](https://lyonwj.com/blog/graph-visualization-with-graphql-react-force-graph)

### AI memory systems (the layer above visualization)

- [Graphiti — Real-Time Knowledge Graphs for AI Agents (getzep)](https://github.com/getzep/graphiti)
- [InfraNodus — AI Text Analysis with Knowledge Graph](https://infranodus.com)
- [NVIDIA txt2kg (Text → Knowledge Graph with Three.js WebGPU)](https://build.nvidia.com/spark/txt2kg)
- [AI Knowledge Graph Generator (robert-mcdermott)](https://github.com/robert-mcdermott/ai-knowledge-graph)
- [From Unstructured Text to Interactive Knowledge Graphs Using LLMs (Robert McDermott)](https://robert-mcdermott.medium.com/from-unstructured-text-to-interactive-knowledge-graphs-using-llms-dd02a1f71cd6)
- [Awesome Knowledge Graph (totogo)](https://github.com/totogo/awesome-knowledge-graph)

### Comparative analyses & benchmarks

- [Top 10 JavaScript Libraries for Knowledge Graph Visualization (Focal)](https://www.getfocal.co/post/top-10-javascript-libraries-for-knowledge-graph-visualization)
- [A Comparison of JavaScript Graph / Network Visualisation Libraries (Cylynx)](https://www.cylynx.io/blog/a-comparison-of-javascript-graph-network-visualisation-libraries/)
- [Best Libraries and Methods to Render Large Force-Directed Graphs on the Web (Stephen, Medium)](https://weber-stephen.medium.com/the-best-libraries-and-methods-to-render-large-network-graphs-on-the-web-d122ece2f4dc)
- [You Want a Fast, Easy-To-Use, and Popular Graph Visualization Tool? Pick Two! (Memgraph)](https://memgraph.com/blog/you-want-a-fast-easy-to-use-and-popular-graph-visualization-tool)
- [Graph Drawing Libraries Comparison (anvaka)](https://github.com/anvaka/graph-drawing-libraries)
- [Focal AI: Deep Dive into the Best Graph Libraries & Network Visualization](https://skywork.ai/skypage/en/Focal-AI-A-Deep-Dive-into-the-Best-Graph-Libraries-Network-Visualization/1976807925743284224)
- [Top 13 JavaScript graph visualization libraries (Linkurious)](https://linkurious.com/blog/top-javascript-graph-libraries/)
- [How to Visualize a Graph with a Million Nodes (Nightingale)](https://nightingaledvs.com/how-to-visualize-a-graph-with-a-million-nodes/)
- [JavaScript libraries for visualizing complex relationship mappings (Zigpoll)](https://www.zigpoll.com/content/can-you-recommend-any-javascript-libraries-or-tools-for-visualizing-and-managing-complex-relationship-mappings-between-entities-in-a-web-application)

### Knowledge graph tooling (end-to-end)

- [7 Best Knowledge Graph Tools and Software (AtlasWorkspace)](https://www.atlasworkspace.ai/blog/knowledge-graph-tools)
- [Best AI Tools for Knowledge Graphs 2026 — GraphRAG, Agent Memory & Graph DBs (TokRepo)](https://tokrepo.com/en/ai-tools-for/knowledge-graph)
- [15 Best Graph Visualization Tools for Neo4j (Neo4j blog)](https://neo4j.com/blog/graph-visualization/neo4j-graph-visualization-tools/)
- [Knowledge Graph Tools — The Ultimate Guide (PuppyGraph)](https://www.puppygraph.com/blog/knowledge-graph-tools)

---

## 8. Open Questions

1. Does the Studio route need to work offline (no SSE) or is live-always acceptable?
2. How do we want to render **temporal decay** — opacity fade? Physical drift? Removal?
3. Is there an appetite for **the VR view** as a shipped feature, or keep it internal demo?
4. Do we want **edge animation directionality** (causal provenance) or undirected visual flow?
5. Should NEXUS symbols and BRAIN entries **share one canvas** by default, or toggle between them?

---

## 9. Next Steps

- [ ] Create epic task: `cleo task add` — "BRAIN Synaptic Visualization" under CLEO Studio parent
- [ ] Decompose into Phase 1–5 subtasks per §5
- [ ] Spec the memory → graph-node schema (§6)
- [ ] Spike: drop Cosmograph into `packages/studio` behind a feature flag
- [ ] Spike: verify GEXF export from NEXUS + BRAIN round-trips through Graphology
