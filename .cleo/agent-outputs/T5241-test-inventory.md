# T5241 Test File Inventory — Memory/Pipeline/Session Domains

**Generated**: 2026-03-03
**Task**: T5241 — Memory Cutover (memory→brain.db, manifest→pipeline, inject→session)
**Agent**: researcher-tests (Phase 1B)

---

## 1. Overview of Current State

### Current Domain Registry (from `src/dispatch/registry.ts`)

**memory domain** — 22 ops total (15 query + 7 mutate):

Query ops: `show`, `list`, `find`, `pending`, `stats`, `manifest.read`, `contradictions`, `superseded`, `pattern.search`, `pattern.stats`, `learning.search`, `learning.stats`, `brain.search`, `brain.timeline`, `brain.fetch`

Mutate ops: `inject`, `link`, `manifest.append`, `manifest.archive`, `pattern.store`, `learning.store`, `brain.observe`

**pipeline domain** — 17 ops total (5 query + 12 mutate):

Query ops: `stage.validate`, `stage.status`, `stage.history`, `stage.gates`, `stage.prerequisites`

Mutate ops: `stage.record`, `stage.skip`, `stage.reset`, `stage.gate.pass`, `stage.gate.fail`, `release.prepare`, `release.changelog`, `release.commit`, `release.tag`, `release.push`, `release.gates.run`, `release.rollback`

**session domain** — 18 ops total (11 query + 7 mutate):

Query ops: `status`, `list`, `show`, `history`, `decision.log`, `context.drift`, `handoff.show`, `briefing.show`, `debrief.show`, `chain.show`, `find`

Mutate ops: `start`, `end`, `resume`, `suspend`, `gc`, `record.decision`, `record.assumption`

---

## 2. Test File Inventory

### 2A. Brain/Memory Core Tests

#### `src/core/memory/__tests__/brain-retrieval.test.ts` — 24 tests
- **What it tests**: `searchBrainCompact`, `timelineBrain`, `fetchBrainEntries`, `observeBrain` from `brain-retrieval.js`
- **Operation names referenced**: None (tests core functions directly, not MCP ops)
- **Function names**: `searchBrainCompact`, `timelineBrain`, `fetchBrainEntries`, `observeBrain`
- **Domain used**: N/A (unit tests only)
- **Change needed**: NONE — these tests call core functions directly and remain valid after cutover

#### `src/core/memory/__tests__/brain-search.test.ts` — 8 tests
- **What it tests**: FTS5 search functions
- **Operation names referenced**: None (core function tests)
- **Change needed**: NONE — pure unit tests

#### `src/core/memory/__tests__/brain-links.test.ts` — 13 tests
- **What it tests**: `brain_memory_links` table CRUD
- **Operation names referenced**: None
- **Change needed**: NONE

#### `src/core/memory/__tests__/brain-migration.test.ts` — 6 tests
- **What it tests**: claude-mem → brain.db migration
- **Operation names referenced**: None
- **Change needed**: NONE

#### `src/core/memory/__tests__/session-memory.test.ts` — 19 tests
- **What it tests**: `extractMemoryItems`, `persistSessionMemory`, `getSessionMemoryContext`
- **Operation names referenced**: None (core function tests)
- **Function names**: `extractMemoryItems`, `persistSessionMemory`, `getSessionMemoryContext`
- **Change needed**: NONE — tests core functions not MCP ops

---

### 2B. Store-level Brain Tests

#### `src/store/__tests__/brain-accessor.test.ts` — 17 tests
- **What it tests**: CRUD on all 5 brain.db tables
- **Change needed**: NONE

#### `src/store/__tests__/brain-schema.test.ts` — 9 tests
- **What it tests**: Schema definitions and migrations
- **Change needed**: NONE

#### `src/store/__tests__/brain-pageindex.test.ts` — 6 tests
- **What it tests**: PageIndex table (Phase 3)
- **Change needed**: NONE (Phase 3 feature not yet live)

#### `src/store/__tests__/brain-vec.test.ts` — 5 tests
- **What it tests**: sqlite-vec integration (Phase 3)
- **Change needed**: NONE (Phase 3 feature not yet live)

---

### 2C. Gateway Tests (HIGH IMPACT — MANY CHANGES NEEDED)

#### `src/mcp/gateways/__tests__/query.test.ts` — 71 tests
- **What it tests**: `cleo_query` gateway parameter validation, operation lists, domain lists
- **Critical assertions that will BREAK after cutover**:
  - Line 33: `'should have 17 query domains (10 canonical + 7 legacy)'` — expects exactly 17 domains
  - Line 68: `'tasks domain should have 15 operations'`
  - Line 73: `'session domain should have 11 operations'`
  - Line 77: `'orchestrate domain should have 9 operations'`
  - Line 80: `'research domain should have all memory operations'` — expects `research` to mirror `memory`
  - Line 83: `'lifecycle domain should have 5 operations'`
  - Lines 303-329: `'Research Domain Operations'` describe block — tests `manifest.read` operation in `research` domain
- **Old operation names referenced**:
  - `'manifest.read'` — expected to be in research ops (line 327)
- **Change needed**:
  - Update domain count if memory domain op count changes
  - Update operation counts for memory domain
  - Update `Research Domain Operations` block to reflect new memory ops (brain.search, brain.timeline, etc.)
  - `manifest.read` moves to pipeline domain — test needs updating
- **Estimated change**: Medium — update 5-8 assertions

#### `src/mcp/gateways/__tests__/mutate.test.ts` — 44 tests
- **What it tests**: `cleo_mutate` gateway parameter validation, operation counts
- **Critical assertions that will BREAK**:
  - Line 28-53: `'should have all 18 domains (10 canonical + 8 legacy)'` — exact domain list assertion
  - Line 56-77: `'should have correct operation counts per domain'`:
    - `MUTATE_OPERATIONS.memory.length === 7` (line 62) — will change if manifest ops move out
    - `MUTATE_OPERATIONS.pipeline.length === 12` (line 63) — will change when manifest ops move in
    - `MUTATE_OPERATIONS.research.length === MUTATE_OPERATIONS.memory.length` (line 69) — research mirrors memory
  - Lines 314-349: `'research domain parameter validation'`:
    - Tests `research.inject` and `research.manifest.append` — these ops will move/rename
    - Line 339: `operation: 'manifest.append'` in `research` domain — should move to `pipeline` domain
- **Old operation names referenced**:
  - `research.inject` → should become `session.context.inject`
  - `research.manifest.append` → should become `pipeline.manifest.append`
- **Change needed**:
  - Update memory operation count (7 → 4 after manifest/inject move out)
  - Update pipeline operation count (12 → 15 after manifest ops move in)
  - Update research domain validation tests to new home domains
  - Update the `research.inject` validation to `session.context.inject`
- **Estimated change**: High — 10+ assertions

#### `src/mcp/gateways/__tests__/query.integration.test.ts` — 29 tests
- **What it tests**: Full query gateway integration via CLI executor
- **Operation names referenced**: Uses domain/operation pairs: `research.list`, `research.stats`, `research.pending`, `research.manifest` (implicitly through session descriptions)
- **Change needed**: LOW — tests use executor and are domain-agnostic; only if domain routing changes

#### `src/mcp/gateways/__tests__/mutate.integration.test.ts` — 31 tests
- **What it tests**: Full mutate gateway integration
- **Operation names referenced**: Standard task/session ops
- **Change needed**: LOW — no memory/pipeline/manifest ops tested directly

---

### 2D. E2E Brain/Memory Tests

#### `src/mcp/__tests__/e2e/brain-operations.test.ts` — 31 tests
- **What it tests**: Engine functions directly (`orchestrateBootstrap`, `taskComplexityEstimate`, `validateCoherenceCheck`, `sessionRecordDecision`, `systemInjectGenerate`)
- **Operation names referenced**: None (tests engine functions directly, not MCP ops)
- **Change needed**: NONE — tests engine functions, not MCP domain/operation routing

#### `src/mcp/__tests__/e2e/research-workflow.test.ts` — 6 tests
- **What it tests**: Research workflow via CLI executor
- **Old operation names referenced**:
  - `domain: 'research', operation: 'list'` — stays as alias
  - `domain: 'research', operation: 'stats'` — stays as alias
  - `domain: 'research', operation: 'link'` — stays as alias
  - `domain: 'research', operation: 'archive'` — currently goes to memory domain; will move to pipeline
  - `domain: 'research', operation: 'pending'` — stays in memory domain
- **Change needed**: MEDIUM — 1-2 tests if archive moves to pipeline

#### `tests/e2e/brain-memory-e2e.test.ts` — 37 tests
- **What it tests**: Full brain.db lifecycle E2E: observation, search, timeline, fetch, token efficiency, cross-linking, session memory, FTS5 quality
- **Operation names referenced**: None (tests core functions via direct import)
- **Change needed**: NONE

#### `tests/integration/session-memory.integration.test.ts` — 10 tests
- **What it tests**: Session end → brain.db persistence, session start/resume → memory context
- **Operation names referenced**: None (tests core functions directly)
- **Change needed**: NONE

#### `tests/e2e/rcasd-pipeline-e2e.test.ts` — 26 tests
- **What it tests**: Full RCASD pipeline E2E with SQLite, stage progression
- **Operation names referenced**: None (tests `pipelineModule` directly)
- **Change needed**: NONE

---

### 2E. Pipeline/Lifecycle Tests

#### `src/dispatch/middleware/__tests__/pipeline.test.ts` — 3 tests
- **What it tests**: Middleware `compose()` function (NOT the lifecycle pipeline)
- **Operation names referenced**: None — tests dispatch middleware composition
- **Change needed**: NONE — unrelated to memory cutover

#### `src/core/__tests__/rcsd-pipeline-e2e.test.ts` — 17 tests
- **What it tests**: RCSD/RCASD pipeline stage definitions, RCASD-INDEX
- **Operation names referenced**: None (core function tests)
- **Change needed**: NONE

#### `src/core/lifecycle/__tests__/pipeline.integration.test.ts` — 48 tests
- **What it tests**: Full RCASD lifecycle pipeline (state machine, transitions, gates)
- **Operation names referenced**: None (uses `pipelineModule` directly)
- **Change needed**: NONE

---

### 2F. Session Tests

#### `src/core/sessions/__tests__/sessions.test.ts` — 12 tests
- **What it tests**: Core session CRUD operations
- **Operation names referenced**: None (core function tests)
- **Change needed**: NONE

#### `src/core/sessions/__tests__/session-cleanup.test.ts` — (not counted)
- **Change needed**: Check for any `session.context.inject` references

#### `src/core/sessions/__tests__/session-edge-cases.test.ts` — (not counted)
- **Change needed**: Check for any inject operation references

#### `src/dispatch/engines/__tests__/session-handoff-fix.test.ts`
- **Change needed**: Likely NONE — tests handoff fix

#### `src/dispatch/engines/__tests__/session-safety.test.ts`
- **Change needed**: Likely NONE — tests session safety

#### `src/mcp/__tests__/e2e/session-workflow.test.ts` — (in tests/e2e/)
- Tests session workflow — check for inject operation references

---

### 2G. Validation/Manifest Tests

#### `src/core/validation/__tests__/manifest.test.ts`
- **What it tests**: Manifest validation schema
- **Change needed**: LOW — likely tests manifest schema, not MCP ops

#### `src/core/skills/__tests__/manifests.test.ts`
- **What it tests**: Skills manifests (not research manifests)
- **Change needed**: NONE — different manifest system

---

## 3. Integration Setup (Shared Test Infrastructure)

#### `src/mcp/__tests__/integration-setup.ts`
- **References**: `brain.search`, `brain.timeline`, `brain.fetch`, `brain.observe` (via imports/types)
- **Contains**: `createManifestEntry` helper — used in mutate integration tests
- **Change needed**: LOW — update `createManifestEntry` to use `pipeline.manifest.append` if needed

---

## 4. Critical Assertion Counts (Registry Count Tests)

These tests assert **exact numeric counts** of operations and WILL BREAK if counts change:

| Test File | Assertion | Current Value | Will Change? |
|-----------|-----------|---------------|-------------|
| `mutate.test.ts:62` | `MUTATE_OPERATIONS.memory.length` | 7 | YES — reduce to 4 if inject+manifest.append+manifest.archive move out |
| `mutate.test.ts:63` | `MUTATE_OPERATIONS.pipeline.length` | 12 | YES — increase to 15 if manifest ops move in |
| `mutate.test.ts:69` | `research.length == memory.length` | derived | YES — research alias mirrors memory |
| `query.test.ts:69` | `tasks domain should have 15 ops` | 15 | NO |
| `query.test.ts:73` | `session domain should have 11 ops` | 11 | YES if context.inject added |
| `query.test.ts:33` | `17 query domains` | 17 | Only if domain list changes |
| `query.test.ts:80` | `research == memory` (derived) | derived | YES — research alias mirrors memory |

---

## 5. New Tests Required (Phase 4B)

### 5A. Memory Domain — brain.db backed

Tests verifying memory ops now return brain.db data (NOT manifest data):

```
memory.find returns brain.db search results
memory.show returns brain.db entry (not manifest entry)
memory.timeline returns brain.db context
memory.fetch returns brain.db full entries
memory.stats returns brain.db stats
memory.observe creates observation in brain.db
memory.decision.find queries brain decisions
memory.decision.store saves brain decision
```

### 5B. Pipeline Domain — manifest operations

Tests verifying manifest ops now live under pipeline domain:

```
pipeline.manifest.show — show manifest entry
pipeline.manifest.list — list manifest entries
pipeline.manifest.find — find manifest entries
pipeline.manifest.pending — pending entries
pipeline.manifest.stats — manifest statistics
pipeline.manifest.append — append to manifest
pipeline.manifest.archive — archive old entries
```

### 5C. Session Domain — context.inject

```
session.context.inject — inject protocol into context
```

### 5D. Regression Tests — Old Names Return E_INVALID_OPERATION

```
memory.manifest.read → E_INVALID_OPERATION
memory.manifest.append → E_INVALID_OPERATION
memory.manifest.archive → E_INVALID_OPERATION
memory.inject → E_INVALID_OPERATION (moved to session.context.inject)
research.manifest.append → E_INVALID_OPERATION (if legacy alias removed)
research.inject → E_INVALID_OPERATION (if legacy alias removed)
```

---

## 6. Test Count Summary

### Current counts (affected test files only):

| File | Tests | Change Scope |
|------|-------|-------------|
| `query.test.ts` | 71 | HIGH — update 5-8 assertions |
| `mutate.test.ts` | 44 | HIGH — update 10+ assertions |
| `brain-retrieval.test.ts` | 24 | NONE |
| `brain-operations.test.ts` | 31 | NONE |
| `session-memory.test.ts` | 19 | NONE |
| `brain-memory-e2e.test.ts` | 37 | NONE |
| `research-workflow.test.ts` | 6 | LOW — 1-2 tests |
| `query.integration.test.ts` | 29 | LOW |
| `mutate.integration.test.ts` | 31 | LOW |
| `session-memory.integration.test.ts` | 10 | NONE |
| `pipeline.integration.test.ts` | 48 | NONE |
| `rcasd-pipeline-e2e.test.ts` | 26 | NONE |
| All others | ~150 | NONE |

**Total current tests in affected files**: ~535
**Tests requiring changes**: ~50 (in query.test.ts and mutate.test.ts primarily)
**New tests to add**: ~18 (Phase 4B)
**Net change**: +18 new tests, ~50 modified assertions

---

## 7. Files NOT in Scope

These test files do NOT need changes:
- All `src/core/memory/__tests__/brain-*.test.ts` — pure unit tests on core functions
- All `src/store/__tests__/brain-*.test.ts` — pure unit tests
- `src/dispatch/middleware/__tests__/pipeline.test.ts` — middleware, not domain pipeline
- `src/core/__tests__/rcsd-pipeline-e2e.test.ts` — RCASD stage definitions
- `src/core/lifecycle/__tests__/pipeline.integration.test.ts` — lifecycle pipeline
- `src/core/sessions/__tests__/*.test.ts` — core session tests
- `tests/e2e/brain-memory-e2e.test.ts` — core function E2E
- `tests/integration/session-memory.integration.test.ts` — core function integration

---

## 8. Key Files for Implementers (Phase 4A/4B)

### Files to MODIFY (test updates):
1. `/mnt/projects/claude-todo/src/mcp/gateways/__tests__/query.test.ts` — domain/op count assertions
2. `/mnt/projects/claude-todo/src/mcp/gateways/__tests__/mutate.test.ts` — domain/op count + research validation tests
3. `/mnt/projects/claude-todo/src/mcp/__tests__/e2e/research-workflow.test.ts` — archive op domain

### Files to CREATE (new tests):
1. `src/dispatch/domains/__tests__/memory-brain.test.ts` — new memory domain brain.db ops
2. `src/dispatch/domains/__tests__/pipeline-manifest.test.ts` — new pipeline manifest ops
3. `src/dispatch/domains/__tests__/session-inject.test.ts` — new session context.inject op
4. `src/mcp/gateways/__tests__/memory-cutover-regression.test.ts` — old names return E_INVALID_OPERATION

---

## 9. Implementation Notes for Phase 4A Implementer

### query.test.ts updates:
- The `Research Domain Operations` block (lines 303-329) currently tests that research ops include `manifest.read`. After cutover, research is a legacy alias for memory, which NO LONGER has `manifest.read`. Update this block to reflect new memory ops (`brain.search`, `brain.timeline`, `brain.fetch`).
- Session domain count changes from 11 to 12 if `context.inject` is added as a query op (or stays 11 if it's mutate only — verify with implementer).

### mutate.test.ts updates:
- The `research domain parameter validation` block tests `research.inject` and `research.manifest.append`. After cutover:
  - `inject` → `session.context.inject` (add new validation block in session section)
  - `manifest.append` → `pipeline.manifest.append` (add new validation block in pipeline section)
  - The `research` domain validation block can either: (a) be removed, (b) be updated to expect these to fail with E_INVALID_OPERATION, or (c) be kept if research alias is preserved

### Count arithmetic:
- **memory query ops**: Was 15. Remove `manifest.read`, `contradictions`, `superseded`, `pattern.search`, `pattern.stats`, `learning.search`, `learning.stats` if full cutover → becomes `show`(brain), `list`(brain), `find`(brain), `pending`(brain), `stats`(brain), `brain.search`, `brain.timeline`, `brain.fetch` = 8 ops
- **memory mutate ops**: Was 7. Remove `inject`, `manifest.append`, `manifest.archive`, `pattern.store`, `learning.store` → becomes `link`, `brain.observe`, `decision.store` = 3 ops
- **pipeline query ops**: Add `manifest.show`, `manifest.list`, `manifest.find`, `manifest.pending`, `manifest.stats` = +5 → 10 total
- **pipeline mutate ops**: Add `manifest.append`, `manifest.archive` = +2 → 14 total
- **session mutate ops**: Add `context.inject` = +1 → 8 total

---

*This inventory is complete as of 2026-03-03. All file paths are absolute.*
