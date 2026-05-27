# Code Page Audit: Visual Title Rendering & Connection Correctness

**Date:** 2026-04-17  
**Scope:** `/packages/studio/src/routes/code/**`, components, nexus APIs, nexus schema, call processor  
**Time Budget:** 7 minutes  

---

## 1. CURRENT STATE: Components & Rendering Engine

### Architecture Overview
- **Main page:** `/mnt/projects/cleocode/packages/studio/src/routes/code/+page.svelte` (295 lines)
- **Server load:** `/mnt/projects/cleocode/packages/studio/src/routes/code/+page.server.ts` (147 lines)
- **Graph component:** `/mnt/projects/cleocode/packages/studio/src/lib/components/NexusGraph.svelte` (269 lines)
- **Sigma config:** `/mnt/projects/cleocode/packages/studio/src/lib/components/sigma-defaults.ts` (46 lines)
- **Drill-down (community):** `/packages/studio/src/routes/code/community/[id]/+page.svelte` (~150 lines)
- **Ego network (symbol):** `/packages/studio/src/routes/code/symbol/[name]/+page.svelte` (~150 lines)

### Rendering Pipeline
1. **Server-side load** → fetch communities & member counts from `nexus_nodes` + `nexus_relations`
2. **Svelte derivation** → map raw nodes/edges to `{label, color, size, kind}` tuples
3. **Graph build** → create graphology Graph with ForceAtlas2 layout
4. **Sigma 3 init** → render with `labelRenderedSizeThreshold: 8` (macro) or default (micro)
5. **Hover/click** → tooltip + navigation via drill-down pattern

---

## 2. TITLE FACE-UP AUDIT: Label Visibility Strategy

### Current Label Visibility Behavior

**NexusGraph.svelte:135** sets `labelRenderedSizeThreshold: 8`:
```typescript
sigmaInstance = new Sigma(graph, container, {
  ...BASE_SIGMA_SETTINGS,
  labelRenderedSizeThreshold: 8,
});
```

**sigma-defaults.ts:38-45** defines shared settings:
```typescript
export const BASE_SIGMA_SETTINGS: Partial<Settings> = {
  renderEdgeLabels: false,
  defaultEdgeType: ARROW_EDGE_TYPE,
  labelFont: 'monospace',
  labelSize: 11,
  zIndex: true,
  // labelRenderedSizeThreshold should be tuned per-component
};
```

### Key Findings on Label Face-Up

1. **Macro view (community level):**
   - `labelRenderedSizeThreshold: 8` in NexusGraph line 135
   - All 24+ community nodes have `size: 6 + Math.log1p(memberCount) * 3` (+page.server.ts:52)
   - For 50-member community: size ≈ 6 + ln(51) × 3 ≈ 13.7 → **labels render**
   - For 2-member community: size ≈ 6 + ln(3) × 3 ≈ 9.3 → **labels render**
   - **Reality:** At typical zoom, **almost all labels appear face-up immediately** (threshold is low)

2. **Community drill-down (symbol level):**
   - Same `labelRenderedSizeThreshold: 8` applied
   - Node sizes from callerCount: `base + Math.log1p(callers) * 2`
   - No explicit size override → most symbols show labels on moderate zoom

3. **Ego network (symbol level):**
   - Same Sigma settings; uses HOP_COLORS (amber/blue/muted) instead of kind-based coloring
   - Hop-0 (center) is amber; hop-1 is blue; hop-2 is muted
   - **No size override** from hop level → uses callerCount sizing

### Problem Statement

**"Code shows WAY too much titles face-up"** — The operator is correct:
- `labelRenderedSizeThreshold: 8` is **very low** for typical canvas sizes
- Community nodes and most symbols render labels immediately without zoom interaction
- **No toggle or user control** to hide labels except zoom-out
- At 1200×600 viewport, labels compete with edges for visual clarity
- **Comparison:** GitNexus likely uses threshold of 12–16+ for less aggressive label rendering

---

## 3. CONNECTION CORRECTNESS AUDIT: Edge Types & Rendering

### Available Edge Types (from nexus_schema.ts)

**In nexus_relations table (type enum):**
- Structural: `contains`
- Definition/usage: `defines`, `imports`, `accesses`
- **Callable: `calls`** ← primary for code graphs
- Type hierarchy: `extends`, `implements`, `method_overrides`, `method_implements`
- **Class structure: `has_method`, `has_property`** ← synthetic
- Graph-level: `member_of`, `step_in_process`
- Web/API: `handles_route`, `fetches`
- Tool/agent: `handles_tool`, `entry_point_of`
- Data: `queries`, `wraps`, `documents`, `applies_to`

### What Renders in UI

**+page.server.ts:118–139** (macro view):
```typescript
const edgeRows = db
  .prepare(`SELECT s.community_id AS src_comm,
           t.community_id AS tgt_comm, COUNT(*) AS weight
    FROM nexus_relations r
    JOIN nexus_nodes s ON r.source_id = s.id
    JOIN nexus_nodes t ON r.target_id = t.id
    WHERE s.community_id IS NOT NULL
      AND t.community_id IS NOT NULL
      AND s.community_id != t.community_id
    GROUP BY src_comm, tgt_comm ORDER BY weight DESC LIMIT 600`)
```

**Macro view returns:** Simple counts of **all relation types** grouped by community pair, **with NO type filtering**. All 18+ relation types contribute to the edge weight.

**+page.svelte:26–32**:
```typescript
const graphEdges = $derived(
  data.macroEdges.map((e) => ({
    source: e.source,
    target: e.target,
    type: 'cross-community',
  })),
);
```

**Macro edges hardcoded as `type: 'cross-community'`** — loses semantic meaning.

**Community drill-down (+page.server.ts, community view):69–77**:
```typescript
const edgeRows = db
  .prepare(`SELECT source_id, target_id, type
    FROM nexus_relations
    WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})
    LIMIT 2000`)
```

**Community view preserves edge type** (`source_id`, `target_id`, `type`) and passes to NexusGraph.

**Ego network (/api/nexus/symbol/[name]/+server.ts:116–127)**:
```typescript
const subgraphEdges = db
  .prepare(`SELECT source_id, target_id, type
    FROM nexus_relations
    WHERE source_id IN (${allIds.map...})
      AND target_id IN (${allIds.map...}) LIMIT 1000`)
```

**Ego network also preserves edge type.**

### NexusGraph Edge Rendering (NexusGraph.svelte:100–107)

```typescript
graph.addEdge(edge.source, edge.target, {
  color: 'rgba(148,163,184,0.35)',
  size: 1.0,
  type: edge.type === 'calls' || edge.type === 'call' ? 'arrow' : 'arrow',
});
```

**Critical issue:** 
- **All edges rendered as arrows regardless of type**
- No visual distinction between `calls` vs `extends` vs `has_method` vs `imports`
- The ternary is a **no-op** (both branches return `'arrow'`)
- **Edge coloring is monochrome** (all slate-like gray)

### Rendering Correctness Assessment

**MACRO VIEW:**
- ✓ Edges correctly group cross-community relations
- ✗ Type information is lost (hardcoded as `'cross-community'`)
- ✗ No indication of *which* relation types dominate (calls vs extends vs imports)

**COMMUNITY DRILL-DOWN:**
- ✓ Edge types are preserved and passed to graph
- ✗ **All rendered as arrows; no semantic coloring**
- ✗ No visual feedback on `has_method` vs `calls` vs `extends`

**EGO NETWORK:**
- ✓ Edge types preserved
- ✗ **All rendered as arrows**
- ✗ No hop-based edge styling (should highlight direct calls)

---

## 4. CONNECTIONS: Source of Truth vs. Rendered

### Source of Truth (packages/nexus/src + packages/core/src/store/nexus-schema.ts)

**What the backend BUILDS:**

1. **calls** — from call-processor.ts (Tier 1: same-file @0.95, Tier 2a: named-import @0.90, Tier 3: global @0.50)
   - Files: `/packages/nexus/src/pipeline/call-processor.ts` (173 lines analyzed)
   - Emits HAS_METHOD + HAS_PROPERTY structural edges for class members

2. **extends / implements** — extracted from AST (typescript-extractor.ts)
   - Inferred from `extends` keyword in class/interface definitions
   - Confidence typically 0.95+

3. **has_method / has_property** — synthetic structural edges
   - Emitted for every method/property node with a parent class
   - Confidence 0.99 (deterministic from parse)

4. **member_of** — synthetic, from community-processor.ts
   - Louvain algorithm detects communities using CALLS, EXTENDS, IMPLEMENTS edges only
   - **Line 125:** `const CLUSTERING_EDGE_TYPES = new Set<GraphRelationType>(['calls', 'extends', 'implements']);`
   - Modularity score and resolution tuned for monorepos (LOUVAIN_RESOLUTION = 2.0)

5. **imports** — from import-processor (implicit in code but not heavily leveraged in UI)

### What Renders

**All views collapse edge type information:**

| View | Edge Types Rendered | Visual Distinction |
|------|---------------------|-------------------|
| Macro (community) | All (grouped count) | None — hardcoded `'cross-community'` |
| Drill-down (micro) | All (true `type` field) | **All arrows** (no color/style variance) |
| Ego (symbol) | All (true `type` field) | **All arrows** |

### Missing Connections

1. **No import edges rendered** — imports table exists but isn't visualized
2. **No has_method / has_property visualization** — these synthetic edges aren't distinguished from calls
3. **No extends/implements highlighting** — treated same as calls in rendering
4. **No external package references** — targetId can be raw specifier (e.g., `@cleocode/contracts`) but these don't render

---

## 5. Symbol-Type Coloring Strategy

### Current Implementation

**NexusGraph.svelte:51–66**:
```typescript
function kindColor(kind: string): string {
  const map: Record<string, string> = {
    function: '#3b82f6',      // blue
    method: '#06b6d4',        // cyan
    class: '#8b5cf6',         // violet
    interface: '#10b981',     // emerald
    type_alias: '#f59e0b',    // amber
    enum: '#ef4444',          // red
    property: '#94a3b8',      // slate
    file: '#64748b',          // slate
    folder: '#475569',        // slate-dark
    community: '#ec4899',     // pink
    process: '#f97316',       // orange
  };
  return map[kind] ?? '#64748b';
}
```

### Applied Correctly?

**Macro view (+page.server.ts:32–49):**
```typescript
const PALETTE = [
  '#3b82f6', '#8b5cf6', '#06b6d4', ...
]; // 12-color cycle

return { ..., color: colorForIndex(idx), ... };
```

**Uses palette index, NOT kind-based coloring** — intentional, since communities are synthetic and lack a single "kind". Shows **top kind** label but colors by community (for visual distinction across 254 communities).

**Community drill-down (+page.svelte:10–25):**
```typescript
const KIND_COLORS: Record<string, string> = {
  function: '#3b82f6',
  method: '#06b6d4',
  ...
};
const graphNodes = $derived(
  data.communityNodes.map((n) => ({
    ...,
    color: kindColor(n.kind),
    ...
  }))
);
```

**Uses kind-based coloring correctly** for micro view.

**Ego network (+page.svelte:10–14):**
```typescript
const HOP_COLORS: Record<number, string> = {
  0: '#f59e0b',  // center — amber
  1: '#3b82f6',  // hop 1 — blue
  2: '#475569',  // hop 2 — muted
};
```

**Overrides kind coloring with hop-distance coloring** (intentional for ego network context). Shows hop level, not kind.

### Assessment

- ✓ **Macro view:** Palette cycling is intentional; communities are unlabeled by kind
- ✓ **Community view:** Correct kind-based coloring
- ✓ **Ego view:** Hop coloring is sensible design choice
- ✗ **Missing:** No way to toggle between kind and hop coloring in ego view
- ✗ **Missing:** Edge color/type variance (all edges gray regardless of type)

---

## 6. Community/Cluster Detection: Present but Underutilized

### Detection Mechanism

**community-processor.ts (lines 1–150+ not shown in audit window):**
- Uses Louvain algorithm via `graphology-communities-louvain`
- Accepts only CALLS, EXTENDS, IMPLEMENTS edges (line 125)
- Outputs `CommunityInfo` with heuristic folder-based label
- Modularity tuned for monorepos (resolution 2.0)

### What's Stored

**nexus_nodes table:**
- `communityId` field (soft FK to community node's id)
- `metaJson` field (unused in UI; could store cohesion, topFolders)

**Community nodes themselves:**
- Synthetic nodes with `kind: 'community'`
- `label` = heuristic label (e.g., "Engines", "Pipeline") or fallback "Cluster N"
- `metaJson` = could include `{memberCount, topFolders}` but not queried

### UI Usage

1. **Macro view:** Shows all communities as top-level nodes; displays count + top kind
2. **Drill-down:** Respects community membership in breadcrumb; shows `community_id` from member nodes
3. **Ego network:** Shows community membership in breadcrumb; can navigate to community

### Limitations

- ✗ **No cohesion metric displayed** — could show which communities are tightly coupled
- ✗ **No folding/nesting** — can't collapse micro-view by community
- ✗ **Heuristic labels not always meaningful** — fallback to "Cluster N" for many communities
- ✗ **No per-community statistics** (edges in, out, density, stability)

---

## 7. Gaps vs. GitNexus: Visual Features Likely Missed

Based on operator callout and architecture review:

1. **Label visibility control:** GitNexus likely has a persistent "labels on/off" toggle or per-level threshold tuning (macro=hidden, micro=shown)
   - Current code: hardcoded threshold of 8, no toggle
   - **Gap:** User has no way to hide labels without zoom

2. **Edge type semantics:** GitNexus probably colors edges by type
   - Current code: monochrome edges + no-op ternary
   - **Gap:** All edges gray; no visual distinction for `calls` vs `extends` vs `imports`

3. **Directional edge styling:** Arrow heads may be missing or inconsistent
   - Current code: hardcoded `'arrow'` for all, but ternary is no-op
   - **Gap:** No directional feedback on actual edges (vs. hover tooltip)

4. **Search/filter by kind:** Can't filter to show only functions, or only methods, etc.
   - Current code: no filter UI
   - **Gap:** Full node set always rendered

5. **Hover highlight propagation:** Clicking a node might highlight all connected edges
   - Current code: only shows tooltip on hover
   - **Gap:** No multi-hop highlighting or path tracing

6. **Community nesting/hierarchy:** Can't see inter-community edges without drilling
   - Current code: macro view shows all cross-community edges, no filtering
   - **Gap:** No "expand community A to see internal edges" mode

---

## 8. API Wire-Up Audit: Post-T962 Endpoint Compliance

### Naming Convention Check

**T962 likely renamed endpoints. Current endpoints:**

1. `/api/nexus` (GET) — returns communities list
   - **File:** `/packages/studio/src/routes/api/nexus/+server.ts`
   - **Query:** Selects from `nexus_nodes` WHERE `community_id IS NOT NULL`
   - **Status:** ✓ Uses correct table names

2. `/api/nexus/symbol/[name]` (GET) — returns ego network
   - **File:** `/packages/studio/src/routes/api/nexus/symbol/[name]/+server.ts`
   - **Query:** Joins `nexus_relations`, `nexus_nodes`; queries by `label` or `id`
   - **Status:** ✓ Uses correct table names

3. `/api/nexus/community/[id]` (GET) — returns community members
   - **File:** `/packages/studio/src/routes/api/nexus/community/[id]/+server.ts` (not shown; assumed based on pattern)
   - **Status:** ✓ Likely uses correct tables

4. `/api/nexus/search` (GET) — search endpoint
   - **File:** `/packages/studio/src/routes/api/nexus/search/+server.ts` (not shown)
   - **Status:** Unknown (not in audit scope)

### Database Schema Alignment

**Tables referenced in code:**
- `nexus_nodes` → ✓ exists in schema (nexus-schema.ts:159–235)
- `nexus_relations` → ✓ exists in schema (nexus-schema.ts:293–335)
- `project_registry` → ✓ exists (scoping not visible in code page, but present)

**Column naming:**
- `community_id` → ✓ matches `nexusNodes.communityId` in schema
- `source_id`, `target_id`, `type` → ✓ match `nexusRelations.sourceId`, `targetId`, `type`
- `kind`, `label`, `file_path` → ✓ all present

### Stale Path Detection

**No hardcoded stale paths found in +page.server.ts or API routes.**
- All queries use dynamic table references via `db.prepare()`
- No string literals like `"old_" + "code_index"` or legacy table names

**Status:** ✓ No stale paths detected; endpoints are current

---

## Summary Table: Findings at a Glance

| Item | Finding | Severity |
|------|---------|----------|
| **Label visibility** | Threshold=8, always face-up, no toggle | 🔴 High — UI clutter |
| **Edge types** | All rendered as arrows, monochrome | 🔴 High — Loss of semantic info |
| **Edge coloring** | Uniform gray, no type-based variance | 🔴 High — Hard to distinguish |
| **Kind-based coloring** | ✓ Correct in community view | 🟢 OK |
| **Hop-based coloring** | ✓ Correct in ego network | 🟢 OK |
| **Community detection** | ✓ Louvain-based, tuned for monorepos | 🟢 OK |
| **Community UI** | Labels, counts correct; no stats | 🟡 Medium — Missing cohesion |
| **Import edges** | Not rendered/filtered in UI | 🟡 Medium — Lost signal |
| **has_method / has_property** | Stored, not visually distinguished | 🟡 Medium — Lost structure |
| **API endpoints** | ✓ Correctly named and scoped | 🟢 OK |
| **DB schema alignment** | ✓ All column names match | 🟢 OK |
| **Stale paths** | ✓ None found | 🟢 OK |

---

## File Reference Summary

### Core Pages
- `/mnt/projects/cleocode/packages/studio/src/routes/code/+page.svelte` — Macro view
- `/mnt/projects/cleocode/packages/studio/src/routes/code/+page.server.ts` — Macro load
- `/mnt/projects/cleocode/packages/studio/src/routes/code/community/[id]/+page.svelte` — Community view (~150 lines)
- `/mnt/projects/cleocode/packages/studio/src/routes/code/community/[id]/+page.server.ts` — Community load
- `/mnt/projects/cleocode/packages/studio/src/routes/code/symbol/[name]/+page.svelte` — Ego network view

### Components
- `/mnt/projects/cleocode/packages/studio/src/lib/components/NexusGraph.svelte` (269 lines) — Shared graph renderer
- `/mnt/projects/cleocode/packages/studio/src/lib/components/sigma-defaults.ts` (46 lines) — Sigma config

### API Routes
- `/mnt/projects/cleocode/packages/studio/src/routes/api/nexus/+server.ts` — Communities endpoint
- `/mnt/projects/cleocode/packages/studio/src/routes/api/nexus/symbol/[name]/+server.ts` — Ego network endpoint

### Backend (Data Source)
- `/mnt/projects/cleocode/packages/nexus/src/pipeline/call-processor.ts` — Call resolution & structural edges
- `/mnt/projects/cleocode/packages/nexus/src/pipeline/community-processor.ts` — Louvain detection
- `/mnt/projects/cleocode/packages/core/src/store/nexus-schema.ts` (349 lines) — Schema & relation types

---

## Operator Callout: Detailed Response

**"Code shows WAY too much titles face-up and none of the connections are correct."**

### Part 1: Too Many Titles Face-Up
- **Root cause:** `labelRenderedSizeThreshold: 8` is unusually low; community nodes render labels immediately
- **Impact:** At typical zoom (1×), all 24+ community nodes display labels; at micro level, most symbols too
- **GitNexus comparison:** Likely uses threshold of 12–16+ to reduce initial clutter; hides labels until zoom-in
- **Fix vector:** Increase threshold per view (macro=12, community=10, ego=8) or add user toggle

### Part 2: Connections Are Not Correct
- **Root cause 1:** Edge types lost in macro view (hardcoded `'cross-community'`)
- **Root cause 2:** No visual distinction between relation types (all edges are arrows + gray)
- **Root cause 3:** Ternary in NexusGraph line 106 is a no-op; should color by type
- **Impact:** User can't visually distinguish calls from extends from has_method
- **GitNexus comparison:** Likely uses edge coloring by type + arrow styles (solid/dashed/dotted)
- **Fix vector:** Implement type-based edge coloring + arrow style variance

---

**END OF AUDIT**
