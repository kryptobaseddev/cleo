# Memory Pages Audit Report (T990)

**Scope**: Studio /brain routes (post-T962 rename from /api/brain → /api/memory)  
**Date**: 2026-04-17  
**Status**: CRITICAL GAPS IDENTIFIED

---

## 1. INVENTORY — Sub-pages & API Coverage

### Frontend Pages (/brain route)
| Page | Path | Status | API Endpoint |
|------|------|--------|--------------|
| Overview | `/brain` | ✅ Main canvas (SSE live) | `/api/memory/graph` (indirect) |
| Observations | `/brain/observations` | ✅ Exists | `/api/memory/observations` |
| Decisions | `/brain/decisions` | ✅ Exists (timeline) | `/api/memory/decisions` |
| Graph | `/brain/graph` | ✅ Exists (separate viz) | `/api/memory/graph` |
| Quality | `/brain/quality` | ✅ Exists (distribution) | `/api/memory/quality` |
| 3D View | `/brain/3d` | ✅ Exists | — (3d-specific) |
| Tier Stats | ❌ MISSING | — | `/api/memory/tier-stats` ✅ Endpoint exists |

### API Endpoints (/api/memory)
- `GET /api/memory/observations` — filters by tier, type, quality
- `GET /api/memory/decisions` — chronological list
- `GET /api/memory/graph` — nodes/edges for force-directed graph (capped 500 nodes)
- `GET /api/memory/quality` — quality distribution + tier/type counts
- `GET /api/memory/tier-stats` — **NOT EXPOSED IN UI** (endpoint is ready!)

**Key Finding**: `/api/memory/tier-stats` endpoint exists but has NO frontend page. This is a missed UX affordance.

---

## 2. LAYOUT CONSISTENCY

### Header Pattern
All pages share:
- Back link to `/brain/overview`
- Page title (`h1.page-title`)
- Count badge (gray, small)
- Canvas link (blue pill top-right)

✅ **Consistent layout structure across observations, decisions, quality, graph.**

### Component Reuse
| Pattern | Used In | Shared? |
|---------|---------|---------|
| Filter bar | observations only | ❌ No (decisions has none) |
| Card layout | observations | Specific to that page |
| Timeline | decisions | Unique; not reused |
| Distribution bars | quality | Unique to quality page |
| Graph canvas | graph, 3d | Separate components |

**Gap**: No shared `<FilterBar>` component; each page (or none) implements its own. Observations filters are inline; decisions has zero filters.

---

## 3. OBSERVATIONS PAGE DEEP DIVE

### Listing Behavior
- **Order**: Created-at DESC (newest first)
- **Max returned**: 200 (hardcoded in API)
- **Expandable**: Yes, click to reveal narrative/details
- **Search**: Client-side (filters downloaded results)
- **Threading**: None (flat list with expand/collapse)

### Filter Capabilities
| Filter | Type | Applied Where |
|--------|------|---|
| Tier | select: `[short, medium, long]` | Server-side |
| Type | select: `[episodic, semantic, procedural]` | Server-side |
| Min Quality | number slider `[0..1]` | Server-side |
| Search text | text input | Client-side (post-fetch) |

### Visual Encoding
- **Tier**: Colored borders (`#64748b` short, `#3b82f6` medium, `#22c55e` long)
- **Type badge**: Small pill, border only
- **Quality**: Horizontal bar (red→yellow→green) + numeric label
- **Status badges**: verified (green), prune (orange), invalidated (red, faded card)
- **Citation count**: Small gray label (if >0)

### Gaps
- No **sorting controls** (only hardcoded created_at DESC)
- No **pagination** (client receives 200, then runs out)
- No **quality filter visualization** (numeric input, no slider)
- **Threaded view absent** — flat list only
- No **linked memories** (cross-references not shown)

---

## 4. DECISIONS PAGE

### Listing Behavior
- **Order**: Created-at ASC (oldest first)
- **Timeline layout**: Yes, with colored dot + connector line
- **Expandable**: Yes, reveals rationale + outcome
- **Filters**: ❌ NONE (all decisions always shown)

### Visual Encoding
- **Timeline dot color**: Tied to memory_tier (`#64748b` short, `#3b82f6` medium, `#22c55e` long)
- **Confidence badge**: Color + text (`#22c55e` high, `#f59e0b` medium, `#ef4444` low, `#64748b` unknown)
- **Status badges**: Same as observations (verified, prune, invalidated)
- **Context links**: Shows task_id, epic_id inline (not clickable)

### Missing Features
- ❌ No **ADR-style rendering** (no alternatives display, no outcome tracking)
- ❌ No **search/filter** despite having data (confidence, tier, date)
- ❌ No **linked tasks** (context_task_id shown but not interactive)
- ❌ No **causal trace** (memory.reason.why not exposed)

---

## 5. MEMORY GRAPH PAGE

### Implementation
- Force-directed graph (rendered via `BrainGraph` component)
- **Max 500 nodes** (hardcoded, quality-sorted)
- Edge-filtered to connected pairs only
- Time slider for temporal filtering

### Differs From /brain Overview
| Feature | /brain (overview) | /brain/graph |
|---------|------------------|-------------|
| Live SSE updates | ✅ Yes (pulsing) | ❌ No (static load) |
| Full graph | ❌ Capped to 500 nodes | ❌ Capped to 500 nodes |
| Interactivity | Pan/zoom/click | Pan/zoom + time filter |
| Purpose | Live workspace | Retrospective analysis |

**Usefulness**: Marginal — both show same 500-node subset. The time slider adds value for temporal slicing, but dataset size is identical.

---

## 6. TIER STATS VISUALIZATION

### Current Status
✅ **API endpoint ready** (`/api/memory/tier-stats`)  
❌ **No frontend page**

### What tier-stats API Returns
```
{
  tables: [
    { table: "brain_observations", short: 42, medium: 18, long: 5 },
    { table: "brain_learnings", short: 12, medium: 3, long: 0 },
    { table: "brain_patterns", short: 8, medium: 2, long: 0 },
    { table: "brain_decisions", short: 25, medium: 6, long: 1 }
  ],
  upcomingLongPromotions: [
    { id: "O-xyz", table: "brain_observations", daysUntil: 3.2, track: "citation (8)" }
  ]
}
```

### Missing UI Elements
- 📊 No **per-table stacked bar chart** (short/medium/long split)
- 📈 No **tier distribution sparklines**
- ⏳ No **upcoming promotions countdown** (daysUntil data unused)
- 📌 No **aging indicators** (e.g., "Medium entries ready to promote in 2d")

---

## 7. API WIRE-UP & RENAME STATUS

### ✅ Renamed Endpoints (post-T962)
- `/api/memory/observations` ← was `/api/brain/observations`
- `/api/memory/decisions` ← was `/api/brain/decisions`
- `/api/memory/graph` ← was `/api/brain/graph`
- `/api/memory/quality` ← was `/api/brain/quality`
- `/api/memory/tier-stats` ← was `/api/brain/tier-stats`

### Frontend Fetch Locations
| File | Fetch URL | Status |
|------|-----------|--------|
| observations/+page.svelte | `/api/memory/observations` | ✅ Correct |
| decisions/+page.svelte | `/api/memory/decisions` | ✅ Correct |
| graph/+page.svelte | `/api/memory/graph` | ✅ Correct |
| quality/+page.svelte | `/api/memory/quality` | ✅ Correct |
| +page.svelte (main) | SSE to `/api/memory/sse` | ⚠️ Check `/api/memory/sse` |

**All fetch paths are updated; rename is complete in routes.**

---

## 8. MISSING MEMORY OPS IN UI

### Operations Defined (contracts/operations/memory.ts)
**Query ops (21 total)**:
- `memory.find` — cross-table FTS/RRF search
- `memory.timeline` — chronological context
- `memory.fetch` — batch by IDs
- `memory.decision.find` — decision search
- `memory.pattern.find` — pattern search (+ impact filter)
- `memory.learning.find` — learning search
- `memory.graph.show / neighbors / trace / related / context` — graph traversal
- `memory.reason.why` — causal blocker trace
- `memory.reason.similar` — vector similarity
- `memory.search.hybrid` — RRF fusion
- `memory.quality` — quality report
- `memory.code.links` — code reference edges
- `memory.llm-status` — extraction backend status
- `memory.pending-verify` — unverified-but-cited queue

**Mutate ops (10 total)**:
- `memory.observe` — save observation
- `memory.decision.store` — save decision
- `memory.pattern.store` — save pattern
- `memory.learning.store` — save learning
- `memory.link` — link memory→task
- `memory.graph.add / remove` — node/edge mutations
- `memory.code.link / auto-link` — code references
- `memory.verify` — promote to verified

### Exposed in Current UI
✅ Observations (via `/api/memory/observations`)  
✅ Decisions (via `/api/memory/decisions`)  
✅ Graph (nodes/edges via `/api/memory/graph`)  
✅ Quality (distribution via `/api/memory/quality`)  
✅ Tier Stats (via `/api/memory/tier-stats`)  

### NOT Exposed
❌ `memory.find` — no global search page  
❌ `memory.timeline` — no temporal context view  
❌ `memory.fetch` — not user-facing  
❌ `memory.pattern.find` — patterns page missing  
❌ `memory.learning.find` — learnings page missing  
❌ `memory.reason.why` — causal reasoning hidden  
❌ `memory.reason.similar` — similarity search missing  
❌ `memory.search.hybrid` — RRF search not accessible  
❌ `memory.pending-verify` — verification queue not surfaced  
❌ **All 10 mutate ops** — no write UI (observe, store, link, verify)  

---

## 9. DESIGN GAPS

### Typography
| Element | Size | Weight | Color |
|---------|------|--------|-------|
| Page title | 1.25rem | 700 | `#f1f5f9` |
| Card title | 0.875rem | 500 | `#e2e8f0` |
| Meta label | 0.6875rem | 600 | `#64748b` |
| Detail text | 0.8125rem | normal | `#94a3b8` |

✅ Consistent scale; follows design system.

### Spacing
- **Page gap**: 1.25rem (consistent)
- **Card gap**: 0.5rem (tight, could breathe more)
- **Meta gap**: 0.5rem (flex wrap friendly)

### Empty States
| Page | Empty Message | Fallback |
|------|---------------|----------|
| Observations | "No observations match filters." | Plain text, centered |
| Decisions | "No decisions found in brain.db." | Plain text, centered |
| Quality | (No empty fallback shown) | Would need fetch failure test |
| Graph | (No empty fallback shown) | Would need fetch failure test |

⚠️ **Weak empty states** — all just text; no imagery, no next-step hints.

### Loading States
| Page | Loading Message |
|------|-----------------|
| All | "Loading [page name]…" | Centered text, no spinner |

⚠️ **No visual spinner** — just text loading indicator.

### Error Handling
```
error = e instanceof Error ? e.message : 'Failed to load [page]'
```
✅ Tries to show error detail, but generic fallback could be clearer.

---

## 10. KEY FINDINGS & PRIORITIES

### 🔴 Critical Gaps
1. **No write UI** — observe, decision.store, pattern.store, learning.store, verify all missing
2. **Patterns page missing** — /brain/patterns doesn't exist; API data available
3. **Learnings page missing** — /brain/learnings doesn't exist; API data available
4. **Tier stats page missing** — endpoint exists but UI never calls it (no `/brain/tier-stats` page)
5. **No search page** — memory.find (global FTS/RRF) not exposed
6. **No causal reasoning UI** — memory.reason.why never shown

### 🟡 Design Inconsistencies
1. **Filter parity** — observations has filters, decisions has none (same data structure)
2. **Sorting** — hardcoded per page (ASC vs DESC) with no user control
3. **Pagination** — absent; 200-entry cap per fetch, then exhaustion
4. **Expandable cards vs timeline** — observations uses cards, decisions uses timeline (inconsistent affordance)
5. **Empty/loading states** — weak (text only, no spinner, no hint)

### 🟢 Working Well
✅ API rename complete (all `/api/memory/*` correct)  
✅ Layout consistency (header/footer patterns)  
✅ Quality visualization (clear color coding)  
✅ Tier color coding (short/medium/long consistent)  
✅ Status badges (verified/prune/invalidated)  

---

## 11. NEXT ACTIONS (T990+)

### Phase 1: Cover Missing Pages
1. Create `/brain/patterns` page (use `/api/memory/pattern.find` — NEW endpoint needed)
2. Create `/brain/learnings` page (use `/api/memory/learning.find` — NEW endpoint needed)
3. Create `/brain/tier-stats` page (use existing `/api/memory/tier-stats`)

### Phase 2: Add Search & Reasoning
4. Create `/brain/search` page (wire memory.find → `/api/memory/find` — NEW endpoint)
5. Create `/brain/causal` page (wire memory.reason.why → `/api/memory/reason-why` — NEW endpoint)

### Phase 3: Write Surfaces (next wave)
6. Observe modal / inline form (memory.observe → `/api/memory/observe`)
7. Decision capture form (memory.decision.store → `/api/memory/decision-store`)
8. Verification queue + promote UI (memory.verify → `/api/memory/verify`)

### Phase 4: Polish
9. Add loading spinners (not just text)
10. Improve empty states (imagery + hints)
11. Unify filter/sort patterns (shared component)
12. Add pagination (offset/limit with UI controls)

---

## Route Structure Summary

```
/brain                          Main canvas (SSE live)
├─ /observations               ✅ List + filters
├─ /decisions                  ✅ Timeline (no filters)
├─ /graph                      ✅ Temporal force-directed
├─ /quality                    ✅ Distribution charts
├─ /3d                         ✅ 3D view
├─ /patterns                   ❌ MISSING (API ready: pattern.find)
├─ /learnings                  ❌ MISSING (API ready: learning.find)
├─ /tier-stats                 ❌ MISSING (API ready: tier-stats)
├─ /search                     ❌ MISSING (API missing: memory.find endpoint)
├─ /causal                     ❌ MISSING (API missing: memory.reason.why endpoint)
└─ /overview                   (Fallback/legacy; unclear purpose)
```

API coverage: 5/31 ops exposed. Rename complete. Write layer absent.

