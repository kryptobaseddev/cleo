# T626 Phase 1 & 2 Decomposition — Living Brain Data Plumbing

> Generated: 2026-04-15
> Source: docs/plans/brain-synaptic-visualization-research.md §5, §7.1, §7.2
> Epic: T626 — EPIC: T-BRAIN-LIVING — Unified 5-substrate Living Brain

---

## Phase 1 Micro-Tasks (Data Plumbing)

### M1 — Normalize `co_retrieved` edge type

**Scope**: Fix the shipped Hebbian strengthener's enum mismatch.

**Files to modify**:
- `packages/core/src/store/brain-schema.ts` — add `'co_retrieved'` to `BRAIN_EDGE_TYPES` enum
- `packages/core/src/memory/brain-lifecycle.ts` — change emitted `edge_type` from `'relates_to'` to `'co_retrieved'` in `strengthenCoRetrievedEdges`
- New migration file under `packages/core/src/store/migrations/` — one-shot `UPDATE brain_page_edges SET edge_type = 'co_retrieved' WHERE edge_type = 'relates_to' AND provenance LIKE 'consolidation:%'`

**Acceptance criteria**:
- `BRAIN_EDGE_TYPES` contains `'co_retrieved'`
- `strengthenCoRetrievedEdges` emits `edge_type = 'co_retrieved'` only
- Migration correctly relabels all existing `relates_to` rows from the co-retrieval provenance
- Drizzle typed layer accepts the edge without casting
- `pnpm biome check --write .` passes
- `pnpm run build` passes
- `pnpm run test` — zero new failures

**Tool budget**: 12
**Dependencies**: none (foundation for M2, M3, M4)

---

### M2 — Wire `session_id` into `logRetrieval`

**Scope**: Add session context to retrieval log so STDP can group and order retrievals. This is the data prerequisite for Phase 5 STDP, but is safe to merge now.

**Files to modify**:
- `packages/core/src/memory/brain-retrieval.ts` — `logRetrieval` at line ~1415: accept an optional `sessionId: string | null` parameter and write it to `brain_retrieval_log.session_id`
- `packages/core/src/store/brain-schema.ts` — confirm `brain_retrieval_log` has `session_id` column; if not, add it with `text('session_id')` (nullable)
- Any callers of `logRetrieval` that have session context available should be updated to pass it

**Acceptance criteria**:
- `logRetrieval` signature accepts `sessionId` without breaking existing callers (optional param, default `null`)
- New retrieval log rows include `session_id` when session is active
- No existing callers broken (audit with `cleo nexus context logRetrieval`)
- Quality gates pass

**Tool budget**: 15
**Dependencies**: M1 (schema is open, can run in parallel with M1 if careful about migration ordering — prefer sequential)

---

### M3 — Backfill decision → task bridge edges

**Scope**: Auto-generate `brain_page_edges(decision → task, applies_to)` for all `brain_decisions` rows that have a non-null `context_task_id`.

**Files to create/modify**:
- `packages/core/src/memory/brain-bridge-edges.ts` — NEW file: `backfillDecisionTaskEdges(db: BrainDb): Promise<number>` — reads `brain_decisions` where `context_task_id IS NOT NULL`, upserts corresponding `brain_page_edges` rows with `edge_type = 'applies_to'`, `provenance = 'backfill:decision-task'`, `weight = 0.5`
- `packages/core/src/memory/brain-lifecycle.ts` — wire `backfillDecisionTaskEdges` into the lifecycle pipeline (step after consolidation, or as a one-time migration hook)
- Migration or CLI command to trigger the backfill for existing data

**Acceptance criteria**:
- For every `brain_decisions` row with non-null `context_task_id`, exactly one `brain_page_edges(decision → task, 'applies_to')` row exists after backfill
- Idempotent: running twice produces no duplicates (upsert on `(from_id, to_id, edge_type)`)
- Quality gates pass

**Tool budget**: 18
**Dependencies**: M1 (needs normalized edge types before writing new edges)

---

### M4 — Backfill observation → file/symbol bridge edges

**Scope**: Auto-generate bridge edges from observations to the files and symbols they reference.

Two sub-cases:
1. `brain_observations.files_modified_json[*]` → `brain_page_edges(observation → file, 'modified_by')`
2. `brain_observations` content regex match against `nexus_nodes` symbol names → `brain_page_edges(observation → symbol, 'references')`

**Files to create/modify**:
- `packages/core/src/memory/brain-bridge-edges.ts` — add `backfillObservationFileEdges(brainDb, nexusDb): Promise<number>` and `backfillObservationSymbolEdges(brainDb, nexusDb): Promise<number>`
- The symbol extraction is a simple regex pass on `brain_observations.content` matching against a pre-loaded set of known symbol names from `nexus_nodes`; no LLM required for MVP
- Wire into the lifecycle pipeline or as a standalone `cleo brain backfill-bridges` sub-command

**Acceptance criteria**:
- All observations with non-empty `files_modified_json` have corresponding `modified_by` edges
- Observations whose content contains an exact symbol name match (from nexus) have corresponding `references` edges
- Cross-DB writes are transactional per observation (no partial edge sets)
- Quality gates pass

**Tool budget**: 22
**Dependencies**: M1 (edge types), M3 (bridge edge patterns established)

---

### M5 — Emit `documents`/`applies_to` into `nexus_relations` on brain write

**Scope**: When brain writes a bridge edge into `brain_page_edges`, also mirror a corresponding row into `nexus_relations` so NEXUS sees brain-origin edges without re-indexing.

**Files to modify**:
- `packages/core/src/memory/brain-bridge-edges.ts` — after any bridge edge upsert, call a new `mirrorEdgeToNexus(nexusDb, fromNodeId, toNodeId, type, confidence)` helper
- `packages/core/src/store/nexus-schema.ts` — confirm `nexus_relations` schema accepts the write (it does per plan §5 — `documents`/`applies_to` are existing relation types)
- Ensure the `nexus_relations` source field is set to `'brain'` so NEXUS reindex does not overwrite these rows

**Acceptance criteria**:
- After M3 or M4 backfill, corresponding rows appear in `nexus_relations` with `type IN ('documents', 'applies_to', 'references', 'modified_by')`
- Existing NEXUS reindex does NOT delete brain-origin rows (source discriminator in place)
- Quality gates pass

**Tool budget**: 18
**Dependencies**: M3 and M4 (bridge edges must exist before mirroring)

---

## Phase 2 Micro-Tasks (Export & Static Viz)

These are parallelizable once Phase 1 is complete. M6 and M7 can start as soon as M1 is merged (they only need to read data, not write it). M8 needs all five Phase 1 tasks complete so the unified graph includes bridge edges.

### M6 — `cleo brain export --format gexf`

**Scope**: New CLI subcommand that dumps `brain_page_nodes` + `brain_page_edges` (including bridge edges) to Graphology-compatible GEXF XML.

**Files to create/modify**:
- `packages/cleo/src/dispatch/domains/brain.ts` — add `export` operation
- `packages/core/src/memory/brain-export.ts` — NEW: `exportBrainGexf(db: BrainDb): string` — maps node types to GEXF `<node>` elements with attribute bags (type, tier, quality_score, confidence), maps edge types to `<edge>` elements with weight
- GEXF output must include `<attributes>` declarations so Cosmograph/Gephi can read typed attrs

**Acceptance criteria**:
- `cleo brain export --format gexf > brain.gexf` produces valid GEXF 1.3 XML
- Output includes all `brain_page_nodes` and `brain_page_edges` rows
- Node `class` attribute set to one of: `memory|work|code|message|agent|synthesized` (per §5.2)
- Quality gates pass

**Tool budget**: 20
**Dependencies**: M1 complete (needs `co_retrieved` in enum); M3+M4 complete for bridge edges to be present, but MVP can run without them

---

### M7 — `cleo nexus export --format gexf`

**Scope**: New CLI subcommand that dumps `nexus_nodes` + `nexus_relations` for the current project to Graphology-compatible GEXF XML.

**Files to create/modify**:
- `packages/cleo/src/dispatch/domains/nexus.ts` — add `export` operation
- `packages/core/src/nexus/nexus-export.ts` — NEW: `exportNexusGexf(db: NexusDb, projectId: string): string`

**Acceptance criteria**:
- `cleo nexus export --format gexf > nexus.gexf` produces valid GEXF 1.3 XML
- All `nexus_nodes` and `nexus_relations` for the current project included
- Node `kind` preserved as a GEXF attribute
- Quality gates pass

**Tool budget**: 18
**Dependencies**: none beyond M1 (can start immediately after M1 merges)

---

## Build Order

```
M1 (normalize co_retrieved + schema)
  ↓
M2 (session_id in retrieval log) ─────┐
M3 (decision → task bridge edges) ────┤  ← parallel after M1
                                       ↓
                                      M4 (observation → file/symbol edges)
                                       ↓
                                      M5 (mirror to nexus_relations)

Phase 2 (parallel-startable after M1):
M1 → M6 (brain export) ─────┐
M1 → M7 (nexus export) ─────┤  ← parallel
                              ↓
                             M8 (unified export — needs M5 + M6 + M7)
```

---

## Micro-Task Summary Table

| ID | Title | Files Changed | Tool Budget | Depends On |
|----|-------|--------------|-------------|------------|
| M1 | Normalize `co_retrieved` edge type | brain-schema.ts, brain-lifecycle.ts, migration | 12 | — |
| M2 | Wire session_id into logRetrieval | brain-retrieval.ts, brain-schema.ts | 15 | M1 |
| M3 | Backfill decision → task bridge edges | brain-bridge-edges.ts (new), brain-lifecycle.ts | 18 | M1 |
| M4 | Backfill observation → file/symbol edges | brain-bridge-edges.ts (extend), lifecycle | 22 | M1, M3 |
| M5 | Mirror brain bridges into nexus_relations | brain-bridge-edges.ts (extend), nexus-schema.ts | 18 | M3, M4 |
| M6 | `cleo brain export --format gexf` | brain.ts domain, brain-export.ts (new) | 20 | M1 |
| M7 | `cleo nexus export --format gexf` | nexus.ts domain, nexus-export.ts (new) | 18 | M1 |
| **Total** | | | **123** | |

Phase 1 critical path (M1 → M3 → M4 → M5): 70 tools.
Phase 2 can start in parallel after M1, adding 38 tools on separate agents.

---

## Parallelization Map

**Wave 1 (serial)**: M1 only — foundation, no parallelism possible.
**Wave 2 (parallel)**: M2, M3, M6, M7 — all unblock after M1.
**Wave 3 (serial)**: M4 — needs M3 patterns established.
**Wave 4 (serial)**: M5 — needs M4 complete.
**Wave 5 (serial)**: M8 (unified export) — needs M5 + M6 + M7.

Four agents can work concurrently in Wave 2: one on M2, one on M3, one on M6, one on M7.

---

## Out of Scope for Phase 1 + 2

The following are deferred to later phases per the plan:

- STDP schema additions (`last_reinforced_at`, `reinforcement_count`, `plasticity_class`) — Phase 5
- SSE live stream endpoint — Phase 3
- 3D renderer — Phase 6
- Cross-project meta-brain (`nexus_cross_project_edges` table) — Phase 4
- LTD decay pass — Phase 5
- `cleo tasks export --format gexf` and `cleo conduit export --format gexf` — Phase 2 extensions not yet assigned
