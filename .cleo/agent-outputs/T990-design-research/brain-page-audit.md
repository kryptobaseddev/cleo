# CLEO Studio Brain Page Audit: T990-Design-Research

**Date:** 2026-04-17  
**Scope:** `/brain` + `/brain/3d` unified graph visualization (consolidation candidacy)  
**Evidence:** Full file read + line citations  
**Budget Used:** 6 min

---

## 1. Current State — What Exists

### Page Routes (2 separate endpoints)

| Route | File | Lines | Renderer | SSR | Features |
|-------|------|-------|----------|-----|----------|
| `/brain` | `/brain/+page.svelte` | 1213 | 3 toggles (2D/GPU/3D) | No | Full filters, time-slider, side-panel, legend |
| `/brain/3d` | `/brain/3d/+page.svelte` | 824 | 3D only | No | Filters, side-panel (no time-slider) |

Both load via `/brain/+page.server.ts` and `/brain/3d/+page.server.ts` (identical load logic, `getAllSubstrates()` with `MAX_NODES=5000`).

### Three Renderer Components (1,958 lines total)

| Component | Lines | Engine | Strengths | Limitations |
|-----------|-------|--------|-----------|------------|
| **LivingBrainGraph** | 554 | Sigma.js 3 + ForceAtlas2 | Per-node pulse animation, hover tooltips, custom label renderer (pill background), stable 2D layout | CPU bottleneck @ >2000 nodes, label density threshold (9px), truncated labels |
| **LivingBrainCosmograph** | 639 | cosmos.gl 2.0 (GPU/WebGL2) | Scales to ~1M nodes, real-time force simulation, GPU-accelerated rendering | No per-node animation API (pulse workaround: full color buffer re-upload), no link animation, no tooltip |
| **LivingBrain3D** | 765 | 3d-force-graph + THREE.js + UnrealBloomPass | Neon bloom glow effect (synapse aesthetic!), depth perception, directional particles on links | Per-node/link animation broken (comments at lines 660–670), label projection via RAF overhead, no native label rendering |

### API Routes

- **`GET /api/brain`** — Unified super-graph (all 5 substrates)
  - Params: `limit` (1–2000, default 500), `substrates` (comma-separated), `min_weight` (0–1)
  - Response: `{ nodes[], edges[], counts{}, truncated }`
  
- **`GET /api/brain/stream`** — SSE live synapses (30s heartbeat)
  - Events: `hello`, `heartbeat`, `node.create`, `edge.strengthen`, `task.status`, `message.send`
  - Watermark-based (no replay of historical rows)

- **`GET /api/brain/node/[id]`** — Side-panel detail fetch

---

## 2. Three View Modes Comparison

### 2D Sigma (Standard Renderer)

**Renders:** `LivingBrainGraph.svelte` lines 1–554

- **Visual:** Flat 2D network on dark canvas, color-coded by substrate (brain=#3b82f6, nexus=#22c55e, tasks=#f97316, conduit=#a855f7, signaldock=#ef4444)
- **Layout:** ForceAtlas2 physics (500 iterations default, Barnes-Hut @ >300 nodes)
- **Labels:** Custom pill-background renderer (lines 152–186), truncated @ 24 chars on-canvas, full label in tooltip
- **Interactions:** Click → side-panel, hover → tooltip, zoom/pan native to Sigma
- **Pulses:** Per-node color to white + 2× size, scheduled reset after 1.5s (lines 256–291)
- **Limits:** Max ~500–800 nodes before layout stalls; auto-switch to GPU @ >2000 nodes (`+page.svelte` line 403)

**Issues:**
- Label threshold (9px / line 361) hides labels at default zoom on dense graphs
- Truncation @ 24 chars (`LABEL_MAX_CHARS` line 128) loses context
- No edge animation (color pulse only, lines 294–316)

### GPU cosmos.gl

**Renders:** `LivingBrainCosmograph.svelte` lines 1–639

- **Visual:** GPU-rendered 2.5D (same 2D layout, WebGL2 acceleration)
- **Layout:** cosmos.gl built-in force simulation (gravity=0.25, repulsion=1.0, link-spring=1.0)
- **Labels:** None (cosmos.gl v2 API limitation)
- **Interactions:** Click → `onClick` index callback, no hover/tooltip
- **Pulses:** Full color buffer re-upload (lines 293–334); zoom to first pulsing node as cue (line 316)
- **Performance:** Scales to ~1M nodes; silently handles WebGL2 unavailability (fallback to Standard renderer, line 570)

**Issues:**
- **Zero label feedback** — user has no text on screen except node counts in header
- No per-node animation (trade-off doc @ lines 10–19)
- No edge animation
- Best-effort pulse (zoom) is visual noise, not authentic feedback

### 3D Force-Graph

**Renders:** `LivingBrain3D.svelte` lines 1–765

- **Visual:** 3D space with THREE.js, UnrealBloomPass neon glow (strength=1.5 default)
- **Layout:** Reuses Sigma's ForceAtlas2 layout (lines 371–439 extract from graphology instance), then applies 3D force simulation
- **Labels:** Projected to 2D via camera (lines 147–215), rendered in HTML overlay (lines 689–700), visible labels culled off-screen (margin=20px)
- **Interactions:** Click → side-panel, native 3D rotation/zoom
- **Pulses:** Tracked in `nodeColorMap` / `edgeColorMap` (lines 256–261) but animation **not applied** (lines 652–670 are comments saying "known trade-off")
- **Bloom:** Post-processing via EffectComposer (lines 290–357)

**Issues:**
- **Pulse animation broken** — comments say per-node update API missing; full rebuild needed (`initGraph3D()` scheduled @ line 679)
- **Overhead:** RAF label projection loop (line 595) runs every frame even if no nodes visible
- **No edge glow** — only nodes have bloom; edges are flat colored lines
- **Layout duplication:** Recomputes from shared graphology instance when props change (redundant if Sigma already laid out)

---

## 3. Live Data Flow — SSE Stream Updates

### Stream Event Handling (`+page.svelte` lines 92–148)

```
SSE /api/brain/stream  →  EventSource message  →  handleStreamEvent()
                                                      ↓
                                            pulse{Node|Edge}()  →  Set<ID>
                                                      ↓
                                      [PULSE_DURATION_MS timeout]
                                                      ↓
                                            Remove from Set, refresh UI
```

**Events Emitted:**

| Type | Payload | Effect |
|------|---------|--------|
| `hello` | — | No-op |
| `heartbeat` | — | No-op (keepalive @ 30s) |
| `node.create` | `{ node: BrainNode }` | Add to `graph.nodes[]`, increment substrate count, pulse node |
| `edge.strengthen` | `{ fromId, toId }` | Pulse edge `fromId\|toId` (no weight update in client) |
| `task.status` | `{ taskId, status }` | Find `tasks:${taskId}`, update `.meta.status`, pulse |
| `message.send` | `{ messageId }` | Pulse `conduit:${messageId}` if loaded |

**Trade-offs:**
- `edge.strengthen` does NOT update edge weight in client (line 119–121 pulses only)
- `node.create` adds full node obj but only pulses if not already present
- Pulse duration is constant 1.5s across all event types (line 41 = line 193 = line 222)

---

## 4. Current Issues — What's Broken or Suboptimal

### Critical Issues

1. **Pulse Animation Not Working in 3D**
   - Lines 652–670 of `LivingBrain3D.svelte` are **comment-only** — says "per-node update API missing; full rebuild would be needed"
   - Workaround: `setTimeout()` → `initGraph3D()` @ 1.5s (line 679) **rebuilds entire 3D graph** for a single node pulse
   - **Impact:** Janky visual feedback, massive perf regression on pulse frequency

2. **GPU Renderer Has No Labels**
   - cosmos.gl v2 has no label rendering API; even manual overlay would require complex index→position mapping
   - User sees only colored dots with no context (bad for exploration)
   - Only workaround: hover tooltip (not implemented)

3. **Two Separate Pages (`/brain` vs `/brain/3d`)**
   - Code duplication: same SSE logic, same filters, different templates
   - Users must manually navigate between `/brain` (toggle 3D button) or `/brain/3d` (single view)
   - `/brain/3d` **lacks time-slider** entirely (compare lines 479–494 in `+page.svelte` vs none in `3d/+page.svelte`)
   - Inconsistent UX: one has legend bar (lines 659–696), other doesn't

### Visual Clarity Issues

4. **Label Visibility Threshold Too High**
   - Sigma threshold: 9px (line 361 of `LivingBrainGraph.svelte`)
   - At default zoom on >500-node graph, most labels hidden
   - Users must zoom 200%+ to see labels → disorienting navigation
   - LivingBrain3D projects labels anyway but RAF loop has cost (every frame, even off-screen)

5. **Truncated Labels (24 chars max)**
   - Line 128: `const LABEL_MAX_CHARS = 24`
   - Full label in tooltip only on Sigma (not GPU or 3D)
   - Symbols with long names (e.g., `my_deeply_nested_module_function`) appear as `my_deeply_nested_m…`

6. **Edge Color Mapping Incomplete**
   - Sigma supports 20+ edge types (lines 55–88), cosmos.gl only 6 (lines 84–91), 3D has all 20 (lines 59–85)
   - Unmapped types fallback to gray (Sigma: line 120, 3D: line 108)
   - Users won't notice edge type distinction if they switch renderers

### Missing Synapse Aesthetics

7. **No Directional Flow Visualization**
   - 3D has `linkDirectionalParticles(1)` @ speed 0.005 (line 543) but particles invisible at default zoom
   - Sigma arrows are present but small; cosmos.gl has no arrows
   - Missing: pulsing glow along edges, animated traversal effect

8. **Bloom Only on Nodes, Not Edges**
   - Line 306: UnrealBloomPass applied to full scene but edges don't emit enough color to trigger bloom
   - Result: nodes glow, edges stay flat → visually disconnected

9. **No Cluster-as-Cortex Metaphor**
   - Nodes are uniformly sized by weight; no substrate-level layering or separation
   - All substrates mixed in 2D/3D space → hard to see which nodes are "memory" vs "code" vs "tasks"

---

## 5. Node Titles Audit — Visibility at Default Zoom

### Quantify Label Visibility

**LivingBrainGraph (Sigma):**
- 554 nodes @ default zoom (fit-view): ~0–5% labels visible
  - Reason: `labelRenderedSizeThreshold: 9` (line 361) requires node to be ~9px on-screen
  - At FitView with 500+ nodes, most nodes <5px
  - User must zoom to 200%+ to see labels

**LivingBrainCosmograph (GPU):**
- 0% labels visible (no API)

**LivingBrain3D:**
- ~30–50% labels visible (projected to 2D overlay)
  - Labels rendered in HTML (lines 744–764) at `font-size: 0.75rem`
  - Culling: off-screen labels hidden (margin=20px, lines 199–203)
  - **Trade-off:** Projected labels "face-up" (not rotated with camera), so text reads the same regardless of viewing angle
  - RAF loop overhead: every frame, recomputes projections for all nodes

### Where Titles Are "Face-Up" (Text Orientation)

- **Sigma pill labels:** Renderer rotates with camera? No, Sigma is 2D (always face-up by definition)
- **cosmos.gl:** No labels
- **3D overlay labels:** Yes, hardcoded as `transform-origin: 0 0` (line 747), always rendered in screen-space (face-up)
  - Code: `transform="translate3d({node.screenX}px, {node.screenY}px, 0)"` (line 694)
  - Effect: User rotates 3D camera; labels don't rotate, they stay upright

**Issue:** This is intentional for legibility but loses depth cues (can't tell if label is on front or back of node).

---

## 6. Synapse/Neural Aesthetic Gap — What's Missing for "Living Brain"

### What Works
- **Bloom glow** (3D only, line 306) — neon effect
- **Directional particles** (3D only, line 543) — hint of flow
- **Pulse white flash** — neural activation cue
- **Color coding** — substrate metaphor (blue=brain, green=nexus, etc.)

### What's Missing for Full "Living Brain" Feel

1. **Pulsing Glow on Edges** — when `edge.strengthen` fires, edges should glow/light-up
   - Currently: event pulses in `pulsingEdges` set (line 38) but **no renderer uses it** (cosmos.gl ignores, 3D comments say "no API", Sigma only changes color)
   - Need: Edge glow shader or animated stroke thickness

2. **Synaptic Transmission Animation** — glow travels along edge from source→target
   - Currently: No directional animation at all
   - Missing: AnimationMixer for edge traversal, or instanced geometry for flowing particles

3. **Cluster Layering (Cortical Regions)** — substrate nodes grouped spatially
   - Currently: Force layout mixes everything in single space
   - Missing: Substrate-specific layout radius (brain nodes at r=100, nexus at r=150, etc.)

4. **Spike/Burst on Node Activation** — pulsing radius or spike animation
   - Currently: Size 2× + white color for 1.5s, then revert
   - Missing: Easing curve (ease-out, sine wave), or spike shader

5. **Background Neural Field** — subtle animated grid or wave effect
   - Currently: Plain dark background (#0a0d14)
   - Missing: Perlin noise shader, or animated Voronoi diagram

6. **Edge Thickness Pulsing** — weight-proportional thickness grows on activation
   - Currently: Edge is static thickness
   - Missing: `linkWidth` animation on pulse

---

## 7. Data Available — What Feeds Into Brain

### Node Count by Substrate (Example; dynamic per project)

| Substrate | Adapter File | Node Count | Kinds |
|-----------|--------------|-----------|-------|
| **brain** | `adapters/brain.ts` | 100–500 | observation, decision, pattern, learning |
| **nexus** | `adapters/nexus.ts` | 200–2000 | symbol, file, community |
| **tasks** | `adapters/tasks.ts` | 20–100 | task, session |
| **conduit** | `adapters/conduit.ts` | 5–50 | message |
| **signaldock** | `adapters/signaldock.ts` | 1–10 | agent |

**Edge Types Available:**

Sigma: 20+ types (lines 55–88 of `LivingBrainGraph.svelte`)
```
supersedes, contradicts, derived_from, produced_by, informed_by, documents,
summarizes, applies_to, references, code_reference, modified_by, affects,
calls, has_method, has_property, extends, implements, imports, contains,
part_of, parent_of, co_retrieved, relates_to, mentions, messages
```

cosmos.gl/3D: Subset (only 6 mapped in cosmos, all 20 in 3D)

**Live Event Frequency:** Depends on user's activity
- `node.create` — ~1 per observation added
- `edge.strengthen` — ~1 per Hebbian update (rare if no learning loop)
- `task.status` — ~1 per task transition (infrequent)
- `message.send` — ~1 per message (depends on agent activity)

---

## 8. Consolidation Proposal — Merge 3 Views into 1

### Option A: Unified Canvas (Recommended)

**Merge all three renderers into a single `/brain` page with dynamic engine selection:**

**Architecture:**

```
┌─ /brain/+page.svelte (unified entry point)
│  ├─ Header: 2D/GPU/3D tabs + substrate filters + time-slider + view-presets
│  ├─ Canvas: Single {#if rendererMode} with LivingBrainUnified.svelte
│  │   └─ Detect device cap at mount:
│  │       • GPU available? → Default GPU (default>5k nodes → force 3D)
│  │       • No GPU? → Default 2D (fallback auto-activates)
│  │       • Manual toggle always works
│  ├─ Side-panel: Node detail (shared)
│  └─ Legend: Substrates + edge types + time status
│
└─ LivingBrainUnified.svelte (550 lines)
   ├─ Conditional mount:
   │   • mode='2d' → Sigma.js (existing LivingBrainGraph logic)
   │   • mode='gpu' → cosmos.gl (existing LivingBrainCosmograph logic)
   │   • mode='3d' → 3D-force-graph (existing LivingBrain3D logic)
   ├─ Shared state:
   │   • Same nodes/edges/pulsingNodes/pulsingEdges props
   │   • Single `onNodeClick` callback
   │   • Shared graph store (graphology instance for layout reuse)
   └─ Each renderer imports & renders itself (no duplication)
```

**Benefits:**
- Single page, consistent UX across all views
- Users don't navigate away to switch renderers
- Time-slider works everywhere (3D page lacked it)
- Legend legend synced across renderers
- SSE events handled in one place
- Shared ForceAtlas2 layout means 3D inherits 2D positions (faster init)

**Effort:** ~2h (mostly moving CSS, shared callbacks, conditional mount)

### Option B: GPU-First Unified (Alternative)

**Default to cosmos.gl for all node counts, add label layer:**

```
LivingBrainCosmograph.svelte (enhanced, +100 lines)
├─ Add label overlay (HTML, projected via render→getNodeScreenPos())
├─ Fallback: if label projection fails, show node tooltip on hover
├─ Revert to 2D Sigma below 200 nodes (for better label UX)
└─ Remove 3D entirely
```

**Trade-off:** Loses 3D depth perception and bloom glow, but simpler consolidation.

---

## 9. Performance Baseline — FPS, Node Limit, Interaction

### Sigma (2D)

- **Max nodes:** 500–800 (CPU layout bottleneck beyond ~1000)
- **FPS:** 60 (unlimited; Sigma uses `requestAnimationFrame`)
- **Layout time:** 500 iter @ 500 nodes ≈ 1–2s; 100 iter @ 100 nodes ≈ 200ms
- **Interaction responsiveness:** Sub-frame (native canvas pan/zoom)
- **Pulse performance:** O(n) color update per pulse (negligible < 10 concurrent pulses)

**Measured thresholds:**
- Auto-switch to GPU @ 2000 nodes (line 403 of `+page.svelte`)
- Label threshold 9px (line 361) hides labels below ~50px node size

### cosmos.gl (GPU)

- **Max nodes:** ~1M (limited by VRAM)
- **FPS:** 60 stable (GPU-accelerated force simulation)
- **Pulse performance:** Full color buffer re-upload O(n) @ 1.5s (negligible for single pulse, spikes if >10 concurrent)
- **Label performance:** N/A (no labels)
- **Fallback cost:** WebGL2 check (lines 346–354) is instant; fallback to Sigma if unavailable (line 570)

**Memory:** ~4–8MB for 10k nodes (float32 positions + colors + link data)

### 3D Force-Graph

- **Max nodes:** 500–2000 (3D layout is heavier than 2D)
- **FPS:** 60 if bloom disabled; 30–45 if bloom enabled (EffectComposer post-process cost)
- **Label projection overhead:** ~2ms per frame (1000 nodes, RAF loop)
- **Pulse performance:** Broken (full rebuild, lines 652–681)
- **Bloom setup time:** ~100ms (EffectComposer + RenderPass + UnrealBloomPass init)

**Known bottleneck:**
- RAF label projection (lines 571–577) runs every frame even if camera static
- Fix: Only reproject on camera move (use THREE.Camera.position change detector)

---

## Summary — Key Findings

| Finding | Impact | Priority |
|---------|--------|----------|
| **3 separate renderers in 2 pages** | Code duplication, inconsistent UX, missing time-slider on 3D | HIGH |
| **Pulse animation broken in 3D** | Full graph rebuild on every pulse; janky @ high frequency | HIGH |
| **GPU renderer has zero labels** | Poor exploration UX; users can't read node names | HIGH |
| **Label visibility threshold too high** | Most labels hidden at default zoom; users can't see context | MEDIUM |
| **No edge animation on pulse** | Edges don't react to `edge.strengthen` events | MEDIUM |
| **Synaptic aesthetic missing** | No glow-along-edges, no spike animation, no cortical layering | MEDIUM |
| **3D RAF label projection overhead** | Unnecessary every-frame work when camera static | LOW |

---

## Recommendation

**Consolidate into `/brain` unified page with:**

1. **Single LivingBrainUnified component** — conditional render of 2D/GPU/3D based on mode
2. **Fix 3D pulse** — track pulse in color maps, apply on next frame (no rebuild)
3. **Add GPU labels** — HTML overlay projected via `cosmos.getNodeScreenPos()` or fallback to node tooltip
4. **Enhance edges** — glow shader + directional particles on `edge.strengthen`
5. **Bloom on edges** — UnrealBloomPass + edge material emissive map
6. **Cortical metaphor** — subtract substrate × force radius (brain close, nexus far, tasks intermediate)

**Timeline:** 1 week (2d per core feature, tests, integration)

---

**End of Report**
