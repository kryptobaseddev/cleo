# T5241 Documentation Inventory: Files Needing Updates

**Generated**: 2026-03-03
**Task**: T5241 (BRAIN/NEXUS cognitive infrastructure)
**Purpose**: Catalog all documentation files containing old operation names or stale references that need updating for the memory-cutover changes.

---

## Summary

The primary change being tracked: BRAIN 3-layer retrieval operations are documented as `memory brain.search`, `memory brain.timeline`, `memory brain.fetch`, and `memory brain.observe`. These may need updating to reflect any name changes, or the docs need to be verified as accurately reflecting the current shipped state.

**Current registry operations** (in `src/dispatch/registry.ts`):
- `memory` domain, operation `brain.search` → MCP call: `cleo_query memory brain.search`
- `memory` domain, operation `brain.timeline` → MCP call: `cleo_query memory brain.timeline`
- `memory` domain, operation `brain.fetch` → MCP call: `cleo_query memory brain.fetch`
- `memory` domain, operation `brain.observe` → MCP call: `cleo_mutate memory brain.observe`

**Operation count discrepancy** (cross-doc inconsistency):
- `AGENTS.md` line 90: `198 operations`; `src/mcp/gateways/query.ts` line says `110 query ops`; `src/mcp/gateways/mutate.ts` line says `88 mutate ops`
- `CLEO-OPERATIONS-REFERENCE.md` lines 24-28: `105 query + 83 mutate = 188 total`
- These two counts conflict and one set needs to be updated to match actual registry

---

## File 1: `.cleo/adrs/ADR-007-domain-consolidation.md`

### Memory Domain Description (line 102)
**Line 102**:
```
| 3 | **memory** | Research manifests, knowledge store, retrieval | Long-term Memory | Cognitive Retrieval | 1 | 12 |
```
**Issue**: Ops count is `12`. With BRAIN operations added (brain.search, brain.timeline, brain.fetch in query; brain.observe in mutate), the ops count needs verification.
**Proposed update**: Verify actual op count in registry for memory domain. Update `12` to the current count.

### BRAIN Base Memory Operations Table (lines ~579-591)
**Current content** (lines 579-591):
```markdown
**Base (Memory) — Primary: `memory`, Secondary: `session`, `tasks`**

| Operation | Domain | Phase | Status |
|-----------|--------|-------|--------|
| Task/session persistence | `tasks.*`, `session.*` | Current | Shipped |
| Research artifacts | `memory.manifest.*` | Current | Shipped |
| Contradiction detection | `memory.contradictions` | Current | Shipped |
| Context persistence | `session.context.*` | 1 | Planned |
| Decision memory (store/recall/search) | `memory.decision.*` | 2 | Planned |
| Pattern memory (store/extract/search) | `memory.pattern.*` | 2 | Planned |
| Learning memory (store/search) | `memory.learning.*` | 3 | Planned |
| Memory consolidation | `memory.consolidate` | 3 | Planned |
| Memory export/import (JSONL portability) | `memory.export`, `memory.import` | 2 | Planned |
```
**Issue**: Missing rows for the SHIPPED BRAIN 3-layer retrieval operations (`memory.brain.search`, `memory.brain.timeline`, `memory.brain.fetch`) and `memory.brain.observe`. These are now shipped but not reflected in this table.
**Proposed new rows to add** (after "Contradiction detection" row):
```markdown
| BRAIN 3-layer retrieval (search) | `memory.brain.search` | Current | **Shipped (T5149/T5151)** |
| BRAIN 3-layer retrieval (timeline) | `memory.brain.timeline` | Current | **Shipped (T5149/T5151)** |
| BRAIN 3-layer retrieval (fetch) | `memory.brain.fetch` | Current | **Shipped (T5149/T5151)** |
| BRAIN observation write | `memory.brain.observe` | Current | **Shipped (T5149/T5151)** |
```

### Pipeline Domain Description (line 104)
**Line 104**:
```
| 5 | **pipeline** | RCSD-IVTR state machine + release execution | Executive Pipeline | Provenance | 2 | ~17 |
```
**Issue**: Description still says "RCSD-IVTR" — should be "RCASD-IVTR" per ADR-014 rename. The `~17` ops count should be verified.
**Proposed update**: Change `RCSD-IVTR` to `RCASD-IVTR`.

### Amend Note to Add
At the end of the ADR, a compliance update note should be added documenting that BRAIN 3-layer retrieval operations were shipped as part of T5149/T5151 and that ADR-007 Section 4.2 Base Memory table was updated accordingly.

---

## File 2: `.cleo/adrs/ADR-009-BRAIN-cognitive-architecture.md`

### Section 5.1 — Base (Memory) Operations Table (lines 286-312)

**Current content** (lines 297-312 — the Planned rows):
```markdown
| Context persistence | `session.context.*` | 1 | Planned |
| Decision memory store | `memory.decision.store` | 2 | Planned |
| Decision memory recall | `memory.decision.recall` | 2 | Planned |
| Decision memory search | `memory.decision.search` | 2 | Planned |
| Pattern memory store | `memory.pattern.store` | 2 | **Shipped (T4768)** |
| Pattern memory extract | `memory.pattern.extract` | 2 | Planned |
| Pattern memory search | `memory.pattern.search` | 2 | **Shipped (T4768)** |
| Pattern memory stats | `memory.pattern.stats` | 2 | **Shipped (T4768)** |
| Learning memory store | `memory.learning.store` | 3 | **Shipped (T4769)** |
| Learning memory search | `memory.learning.search` | 3 | **Shipped (T4769)** |
| Learning memory stats | `memory.learning.stats` | 3 | **Shipped (T4769)** |
| Memory consolidation | `memory.consolidate` | 3 | Planned |
| Temporal queries | `memory.search` (with date filters) | 2 | Planned |
| Memory export (JSONL) | `memory.export` | 2 | Planned |
| Memory import (JSONL) | `memory.import` | 2 | Planned |
| Contradiction detection | `memory.contradictions` | Current | Shipped |
```
**Issue**: The 3-layer BRAIN retrieval operations (`memory.brain.search`, `memory.brain.timeline`, `memory.brain.fetch`) and `memory.brain.observe` are NOT in this table despite being shipped in Phase 2 (T5149/T5151). They need rows added.

**Proposed rows to add** (insert before "Context persistence" row — these are Phase 2 shipped):
```markdown
| BRAIN 3-layer search (Step 1) | `memory.brain.search` | 2 | **Shipped (T5151)** |
| BRAIN 3-layer timeline (Step 2) | `memory.brain.timeline` | 2 | **Shipped (T5151)** |
| BRAIN 3-layer fetch (Step 3) | `memory.brain.fetch` | 2 | **Shipped (T5151)** |
| BRAIN observation write | `memory.brain.observe` | 2 | **Shipped (T5151)** |
```

### B-R-A-I-N Runtime References (Section 9.2, lines 522-549)

**Current content** (lines 522-549, Section 9.2 "BRAIN Phase 2: Pattern and Learning Memory"):
```
**Storage Model** (interim):
- Runtime store: JSONL files at `.cleo/memory/patterns.jsonl` and `.cleo/memory/learnings.jsonl`
- Export format: Same JSONL, validated against `schemas/brain-*.schema.json`
- Future: SQLite `brain_patterns` and `brain_learnings` tables per ADR-009 Section 3.2
```
**Issue**: This "interim" storage model is STALE. Brain data has been migrated to SQLite brain.db tables per T5149. The JSONL files are no longer the runtime store.
**Proposed update**: Change to reflect that SQLite brain.db is now the runtime store (not "Future"):
```
**Storage Model** (current):
- Runtime store: SQLite `brain.db` — `brain_patterns` and `brain_learnings` tables (migrated from JSONL in T5149)
- Export format: JSONL, validated against `schemas/brain-*.schema.json`
- Legacy: JSONL files at `.cleo/memory/patterns.jsonl` and `.cleo/memory/learnings.jsonl` (retired)
```

### Section 9.3 Required Follow-Up Tasks (lines 551-565)

**Current content** (lines 551-565):
The table still lists "BRAIN SQLite tables | Migrate brain_decisions/patterns/learnings from JSONL to SQLite | P2 | Pending"

**Issue**: This migration IS DONE (T5149). Status should be updated to Done.
**Proposed update**: Change from `Pending` to `**Done (T5149)**`.

---

## File 3: `docs/specs/VERB-STANDARDS.md`

### `search` Carve-Out for Memory Domain (lines ~810-813)

**Current content** (lines 810-813):
```markdown
**MCP Usage**: `memory.pattern.search`, `memory.learning.search` (MCP uses `search` internally; `recall` is CLI surface only)
```
**Issue**: This MCP usage note is accurate but incomplete — it doesn't mention `memory.brain.search` which also uses the `search` verb. The note should be expanded.
**Proposed update**:
```markdown
**MCP Usage**: `memory.pattern.search`, `memory.learning.search`, `memory.brain.search` (MCP uses `search` internally; `recall` is CLI surface only)
```

### BRAIN Memory Operations Quick Reference (lines 936-941)

**Current content** (lines 935-941):
```markdown
#### BRAIN Memory Operations

```
store       Append-only memory write (patterns, learnings)
recall      Semantic memory retrieval (CLI alias for search)
stats       Aggregate memory statistics
```
```
**Issue**: Missing `brain.search`, `brain.timeline`, `brain.fetch`, and `brain.observe` from the quick reference. These are shipped operations.
**Proposed update**: Add a sub-section or extend the existing list:
```markdown
#### BRAIN Memory Operations

```
store          Append-only memory write (patterns, learnings)
recall         Semantic memory retrieval (CLI alias for search)
stats          Aggregate memory statistics
brain.search   3-layer retrieval step 1: compact index with IDs + titles
brain.timeline 3-layer retrieval step 2: chronological context around anchor
brain.fetch    3-layer retrieval step 3: full details for filtered IDs
brain.observe  Save observation to brain.db (mutate gateway)
```
```

---

## File 4: `docs/specs/CLEO-BRAIN-SPECIFICATION.md`

### Three-Layer Retrieval Section (lines 190-194)

**Current content** (lines 190-194):
```markdown
1. **Search** (`memory brain.search`) — Returns a compact index with IDs and titles (~50-100 tokens per result)
2. **Timeline** (`memory brain.timeline`) — Shows chronological context around interesting results
3. **Fetch** (`memory brain.fetch`) — Retrieves full details ONLY for pre-filtered IDs (~500-1000 tokens each)

The agent manages its own token budget by deciding what to fetch based on relevance. Saving new observations uses `memory brain.observe` via the mutate gateway.
```
**Issue**: The format `memory brain.search` uses a space between `memory` and `brain.search`. This is the MCP call format (`cleo_query memory brain.search`). This is correct and consistent with how CLEO MCP calls work. No change needed unless operation names are being renamed.

**If operation names ARE changing** (e.g., `brain.search` → `brain.find`):
- Line 191: `memory brain.search` → `memory brain.find`
- Line 192: `memory brain.timeline` → `memory brain.timeline` (if unchanged)
- Line 193: `memory brain.fetch` → `memory brain.fetch` (if unchanged)
- Line 194: `memory brain.observe` → `memory brain.observe` (if unchanged)

**Current State vs Target section** (line 220):
```markdown
**Shipped**: `brain.db` (5 tables: decisions, patterns, learnings, observations, memory_links), FTS5 full-text search, 3-layer retrieval (memory.brain.search / timeline / fetch), memory.brain.observe, 22 MCP operations, 5,122 observations migrated from claude-mem, ADR cognitive search, session handoffs, contradiction detection, vectorless RAG, 3713+ tests
```
**Issue**: References `22 MCP operations` — needs verification against current registry count for memory domain.
**Also**: `3713+ tests` may be outdated — current test count should be verified.

---

## File 5: `docs/specs/CLEO-OPERATIONS-REFERENCE.md`

### Header / Status (lines 1-28)

**Current content** (lines 24-28):
```markdown
## Operation Counts

| Gateway | Operations | Domains |
|---------|-----------|---------|
| cleo_query | 105 | 10 |
| cleo_mutate | 83 | 10 |
| **Total** | **188** | **10** |
```
**Issue**: Conflicts with AGENTS.md (`198 operations: 110 query + 88 mutate`) and `README.md` (`198 operations (110 query + 88 mutate)`). One set of numbers is wrong.
- The operations reference says 188 (105+83)
- AGENTS.md and README.md say 198 (110+88)

**What to do**: Add a SUPERSEDED notice at the top if this document is being replaced, OR verify the actual count in `src/dispatch/registry.ts` and update to match.

**Proposed SUPERSEDED notice** (add at top if applicable):
```markdown
> **NOTE**: This document may be out of date. Verify operation counts against `src/dispatch/registry.ts` (source of truth).
> Current discrepancy: This doc shows 188 ops (105+83); AGENTS.md shows 198 ops (110+88).
```

---

## File 6: `docs/concepts/vision.md`

### Lines ~190-194 — Three-Layer Retrieval References

**Current content** (lines 186-194):
```markdown
### Three-Layer Retrieval [SHIPPED]

BRAIN implements a progressive retrieval workflow (inspired by claude-mem) that achieves ~10x token savings over traditional RAG:

1. **Search** (`memory brain.search`) — Returns a compact index with IDs and titles (~50-100 tokens per result)
2. **Timeline** (`memory brain.timeline`) — Shows chronological context around interesting results
3. **Fetch** (`memory brain.fetch`) — Retrieves full details ONLY for pre-filtered IDs (~500-1000 tokens each)

The agent manages its own token budget by deciding what to fetch based on relevance. Saving new observations uses `memory brain.observe` via the mutate gateway.
```
**Issue**: Same format as CLEO-BRAIN-SPECIFICATION.md. If operation names change, these 4 references need updating.

### Line ~220 — Shipped Ops

**Current content** (line 220):
```markdown
**Shipped**: `brain.db` (5 tables: decisions, patterns, learnings, observations, memory_links), FTS5 full-text search, 3-layer retrieval (memory.brain.search / timeline / fetch), memory.brain.observe, 22 MCP operations, 5,122 observations migrated from claude-mem, ADR cognitive search, session handoffs, contradiction detection, vectorless RAG, 3713+ tests
```
**Issue**: Same as CLEO-BRAIN-SPECIFICATION.md. The `22 MCP operations` count needs verification; `3713+ tests` may be outdated.

---

## File 7: `~/.cleo/templates/CLEO-INJECTION.md`

### Memory Protocol Section (lines 75-97)

**Current content** (lines 75-97):
```markdown
## Memory Protocol

CLEO includes a native BRAIN memory system. Use the 3-layer retrieval pattern for token-efficient access:

| Step | Operation | Gateway | ~Tokens | Purpose |
|------|-----------|---------|---------|---------|
| 1 | `memory brain.search` | query | 50/hit | Search index (IDs + titles) |
| 2 | `memory brain.timeline` | query | 200-500 | Context around an anchor ID |
| 3 | `memory brain.fetch` | query | 500/entry | Full details for filtered IDs |
| Save | `memory brain.observe` | mutate | — | Save observation to brain.db |

**Workflow**: Search first (cheap) → filter interesting IDs → fetch only what you need.

**Example**:
```
cleo_query memory brain.search {query: "authentication"}
cleo_query memory brain.fetch {ids: ["O-abc123"]}
cleo_mutate memory brain.observe {text: "Found auth uses JWT", title: "Auth discovery"}
```

**Anti-patterns:**
- Fetching all entries without searching first (expensive)
- Skipping brain.search and going straight to brain.fetch
```
**Issue**: This is the most frequently-read file (injected into every agent session). If operations are renamed, this MUST be updated first and correctly. If they remain as-is, no change needed.

**Key references** (if names change, update ALL of these):
- Line 81: `memory brain.search`
- Line 82: `memory brain.timeline`
- Line 83: `memory brain.fetch`
- Line 84: `memory brain.observe`
- Line 90 (example): `cleo_query memory brain.search {query: "authentication"}`
- Line 91 (example): `cleo_query memory brain.fetch {ids: ["O-abc123"]}`
- Line 92 (example): `cleo_mutate memory brain.observe {text: "Found auth uses JWT", title: "Auth discovery"}`
- Line 97: `brain.search` (anti-pattern reference)
- Line 98: `brain.fetch` (anti-pattern reference)

---

## File 8: `README.md`

### Line 101 — Current State

**Current content** (line 101):
```markdown
| **Shipped** | TypeScript CLI + MCP server, SQLite storage (`tasks.db` + `brain.db`), atomic operations, four-layer anti-hallucination, RCASD-IVTR+C lifecycle gates, session management, 3-layer BRAIN retrieval (`brain.search/timeline/fetch`), BRAIN observe writes, NEXUS dispatch domain wiring (12 operations), LAFS envelopes |
```
**Issue**: If operation names change from `brain.search/timeline/fetch` to new names, update the parenthetical. Also `12 operations` for NEXUS wiring needs verification.

### Line 165 — Operation Counts

**Current content** (line 165):
```markdown
10 canonical domains, 198 operations (110 query + 88 mutate) across tasks, sessions, memory, check, pipeline, orchestration, tools, admin, nexus, and sharing.
```
**Issue**: `198 operations (110 query + 88 mutate)` conflicts with `CLEO-OPERATIONS-REFERENCE.md` which shows `188 (105+83)`. One source is wrong. Must be reconciled against actual registry.

---

## File 9: `AGENTS.md`

### Line 90 — Operation Counts

**Current content** (line 90):
```markdown
- **MCP is PRIMARY**: 2 tools, 198 operations across 10 canonical domains (~1,800 tokens)
```
**Issue**: 198 may be wrong. Must be verified against registry.

### Lines 322-323 — Key Files Section

**Current content** (lines 322-323):
```markdown
- `src/mcp/gateways/query.ts` - 110 query operations (CANONICAL operation registry)
- `src/mcp/gateways/mutate.ts` - 88 mutate operations (CANONICAL operation registry)
```
**Issue**: These counts (110+88=198) conflict with CLEO-OPERATIONS-REFERENCE.md (105+83=188). Must be reconciled.

---

## File 10: `docs/ROADMAP.md`

### Line 9 — Memory Brain References

**Current content** (line 9):
```markdown
- BRAIN foundation in `.cleo/brain.db` with retrieval (`memory brain.search`, `memory brain.timeline`, `memory brain.fetch`) and write (`memory brain.observe`).
```
**Issue**: References all 4 BRAIN operations by name. If names change, update all 4 here.

---

## File 11: `docs/FEATURES.md`

### Line 37 — 3-Layer Retrieval Row

**Current content** (line 37):
```markdown
| 3-Layer Retrieval | `shipped` | - | memory brain.search, memory brain.timeline, memory brain.fetch, plus brain.observe |
```
**Issue**: References all 4 operations. If names change, update all 4 here.

---

## File 12: `docs/FEATURES.json`

### Line 50 — Details Field

**Current content** (line 50):
```json
"details": "memory brain.search, memory brain.timeline, memory brain.fetch, plus brain.observe"
```
**Issue**: Same as FEATURES.md (FEATURES.md is auto-generated from FEATURES.json). If names change, update FEATURES.json — FEATURES.md will regenerate.

---

## Cross-Cutting Issue: Operation Count Discrepancy

There are two conflicting counts that appear across multiple files:

| Source | Query Ops | Mutate Ops | Total |
|--------|-----------|------------|-------|
| `CLEO-OPERATIONS-REFERENCE.md` | 105 | 83 | **188** |
| `AGENTS.md` (line 90) | — | — | 198 |
| `AGENTS.md` (lines 322-323) | 110 | 88 | **198** |
| `README.md` (line 165) | 110 | 88 | **198** |

**Root cause**: The CLEO-OPERATIONS-REFERENCE.md was last verified 2026-03-02 but uses 105+83=188. AGENTS.md and README.md use 110+88=198. The actual `src/dispatch/registry.ts` is the source of truth.

**Files needing count reconciliation**:
1. `CLEO-OPERATIONS-REFERENCE.md` — lines 24-28
2. `AGENTS.md` — lines 90, 322-323
3. `README.md` — line 165

---

## Priority Matrix

| File | Urgency | Reason |
|------|---------|--------|
| `~/.cleo/templates/CLEO-INJECTION.md` | CRITICAL | Injected into every agent session — must be accurate |
| `docs/specs/CLEO-OPERATIONS-REFERENCE.md` | HIGH | Source-of-truth for operations — op count discrepancy |
| `AGENTS.md` | HIGH | Read by agents on every project entry — stale counts |
| `README.md` | HIGH | Public-facing — stale counts |
| `docs/specs/CLEO-BRAIN-SPECIFICATION.md` | MEDIUM | Stale storage model ref in lines 92-94 |
| `docs/concepts/vision.md` | MEDIUM | If op names change, update retrieval references |
| `.cleo/adrs/ADR-009-BRAIN-cognitive-architecture.md` | MEDIUM | Missing BRAIN 3-layer ops in Section 5.1; stale JSONL storage model in Section 9.2 |
| `.cleo/adrs/ADR-007-domain-consolidation.md` | LOW | Missing BRAIN ops in Section 4.2; RCSD→RCASD fix |
| `docs/specs/VERB-STANDARDS.md` | LOW | Minor addition to BRAIN Memory Operations quick ref |
| `docs/ROADMAP.md` | LOW | Update if op names change |
| `docs/FEATURES.md` | LOW | Auto-generated from FEATURES.json — update JSON source |
| `docs/FEATURES.json` | LOW | Update if op names change |

---

## Files That Do NOT Exist

- `docs/FEATURES.md` — EXISTS at `/mnt/projects/claude-todo/docs/FEATURES.md`
- `docs/FEATURES.json` — EXISTS at `/mnt/projects/claude-todo/docs/FEATURES.json`
- `docs/ROADMAP.md` — EXISTS at `/mnt/projects/claude-todo/docs/ROADMAP.md`

All files listed in the task brief exist on disk.
