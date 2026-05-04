# SUPERSESSION-EVIDENCE.md

**Task**: T1736 — D3 Validation Campaign  
**Date**: 2026-05-04  
**Repository**: /mnt/projects/openclaw  
**Commit**: d2e2d971b6d23e8b727250a0d76cbe41b8f4e1f4  
**cleo version**: 2026.5.16  
**gitnexus version**: 1.6.3  

---

## Pre-flight Versions

| Tool | Version | Index Date | Notes |
|------|---------|------------|-------|
| gitnexus | 1.6.3 | 2026-05-04T16:32:55Z | Force re-analyzed (`gitnexus analyze --force`). Prior index: 2026-04-20 |
| cleo nexus | 2026.5.16 | 2026-05-04T16:19:45Z | Fresh re-analyzed (`cleo nexus analyze /mnt/projects/openclaw`) |

Both tools analyzed identical commit (d2e2d97). Both fresh runs completed on 2026-05-04. Gitnexus force re-analyze took ~18 minutes (13,927 files, large repo); cleo nexus ran in 26 seconds.

**IMPORTANT — Index Discrepancy Finding**: The prior gitnexus index (2026-04-20, 84,530 nodes, 615,963 edges) was significantly under-counted compared to the fresh force re-analyze (251,832 nodes, 748,581 edges). The fresh run revealed gitnexus now indexes Const nodes (128,805), more Properties (18,850), and uses an updated graph backend ("ladybugdb" vs prior backend). The comparisons below use the **fresh force re-analyze stats** as authoritative for gitnexus.

---

## 6-Axis Comparison Table

| Axis | gitnexus (fresh) | cleo nexus (fresh) | Verdict |
|------|------------------|--------------------|---------|
| 1. Symbol counts | 251,832 nodes total; 67,125 fn + 128,805 const + 18,850 prop + 13,927 file + 5,396 community + 4,759 method + 1,125 struct + 908 class + 604 var + 513 enum + 331 interface + 300 process + 128 const-explicit + 43 type_alias | 64,230 nodes: 35,163 fn + 14,105 file + 11,217 type_alias + 1,231 method + 1,068 property + 760 folder + 271 interface + 221 class + 117 module + 75 process + 2 enum | **falls-behind** |
| 2. IMPORTS edge counts | 390,893 IMPORTS + 748,581 total (15 relation types incl. DEFINES 223,627 + CALLS 63,267 + HAS_PROPERTY 8,491 + ACCESSES 8,293) | 46,674 imports + 150,770 total (9 relation types) | **falls-behind** |
| 3. Community counts (Leiden) | 7,183 communities (meta.json); 5,396 Community nodes in graph | 0 communities detected (Leiden ran in 126ms, modularity=0.000) | **falls-behind** |
| 4. Callers/callees parity (10 symbols) | Agrees with cleo on core caller topology for 8/10 symbols; missed parseInlineDirectives callers (0 vs 6) | Agrees on core callers; higher callee counts (reports more outbound edges); aggregates across all definitions | **matches** |
| 5. Wiki output | Requires LLM API key (errors without OPENAI_API_KEY); no output in current environment | 1 file generated (overview.md) placeholder only (0 communities) | **falls-behind** (both blocked; cleo blocked by Leiden; gitnexus blocked by LLM key) |
| 6. Hook augmenter latency | p50: 317ms, p95: 377ms; returns graph context | p50: 1,979ms, p95: 2,047ms; returns empty results for all patterns | **falls-behind** |

---

## Axis 1: Symbol Counts — Details

### gitnexus (KuzuDB "ladybugdb" backend — fresh force re-analyze 2026-05-04)

| Node Type | Count |
|-----------|-------|
| Const | 128,805 |
| Function | 67,125 |
| Property | 18,850 |
| File | 13,927 |
| Method | 4,759 |
| Struct | 1,125 |
| Class | 908 |
| Variable | 604 |
| Enum | 513 |
| Interface | 331 |
| Process | 300 |
| Community | 5,396 |
| TypeAlias | 43 |
| **Total** | **251,832** |

Indexed files: 13,927 | Embeddings: 0 | Communities: 7,183 (meta.json, graph has 5,396 Community nodes) | Processes: 300

**Notable vs prior index**: The force re-analyze added 128,805 Const nodes (zero in prior index), increased functions from 44,825 to 67,125 (+50%), properties from 4,964 to 18,850 (+280%). The "ladybugdb" backend (v1.6.3) appears to now capture a much broader symbol surface.

### cleo nexus (SQLite nexus_relations — fresh analyze 2026-05-04)

| Node Kind | Count |
|-----------|-------|
| function | 35,163 |
| file | 14,105 |
| type_alias | 11,217 |
| method | 1,231 |
| property | 1,068 |
| folder | 760 |
| interface | 271 |
| class | 221 |
| module | 117 |
| process | 75 |
| enum | 2 |
| **Total** | **64,230** |

Indexed files: 14,114 | External nodes: 0 | Communities: 0 (Leiden failed) | Processes: 75

**Delta**: gitnexus indexes 187,602 more nodes than cleo nexus (+292%). The largest gaps:
- Const: gitnexus 128,805 vs cleo 0 (cleo does not capture const/variable declarations as separate nodes)
- Function: gitnexus 67,125 vs cleo 35,163 (1.9x gap — 31,962 fewer functions in cleo)
- Property: gitnexus 18,850 vs cleo 1,068 (17.6x gap)
- type_alias: cleo 11,217 vs gitnexus 43 (cleo captures type aliases; gitnexus mostly misses them)
- Community: gitnexus 5,396 vs cleo 0 (cleo Leiden failed)
- folder: cleo 760 vs gitnexus 0 (cleo has folder nodes; gitnexus uses File for directories)

---

## Axis 2: IMPORTS Edge Counts — Details

### gitnexus (fresh force re-analyze — CodeRelation table)

| Relation Type | Count |
|--------------|-------|
| IMPORTS | 390,893 |
| DEFINES | 223,627 |
| CALLS | 63,267 |
| MEMBER_OF | 23,798 |
| CONTAINS | 22,361 |
| HAS_PROPERTY | 8,491 |
| ACCESSES | 8,293 |
| HAS_METHOD | 5,917 |
| STEP_IN_PROCESS | 1,368 |
| EXTENDS | 271 |
| METHOD_IMPLEMENTS | 158 |
| IMPLEMENTS | 71 |
| HANDLES_ROUTE | 57 |
| ENTRY_POINT_OF | 6 |
| METHOD_OVERRIDES | 3 |
| **Total** | **748,581** |

### cleo nexus (fresh analyze — nexus_relations SQLite table)

| Relation Type | Count |
|--------------|-------|
| calls | 86,293 |
| imports | 46,674 |
| contains | 14,809 |
| has_method | 1,231 |
| has_property | 1,068 |
| step_in_process | 454 |
| extends | 136 |
| entry_point_of | 75 |
| implements | 30 |
| **Total** | **150,770** |

**Delta**: gitnexus captures 5.0x more total edges (748,581 vs 150,770). IMPORTS: 390,893 vs 46,674 (8.4x gap). CALLS: gitnexus 63,267 vs cleo 86,293 — cleo captures *more* CALLS edges (1.36x) despite fewer total edges overall. DEFINES (223,627) and ACCESSES (8,293) have no equivalent in cleo nexus. gitnexus has 6 additional relation types not in cleo: DEFINES, MEMBER_OF, ACCESSES, METHOD_IMPLEMENTS, HANDLES_ROUTE, METHOD_OVERRIDES.

---

## Axis 3: Community Counts (Leiden) — Details

| Tool | Communities | Algorithm | Notes |
|------|------------|-----------|-------|
| gitnexus (fresh) | 7,183 (meta.json) / 5,396 Community nodes in graph | Leiden | Heuristic-labeled communities; 300 processes |
| cleo nexus (fresh) | 0 detected | Leiden | Ran on 26,945 nodes, 53,479 edges; modularity=0.000 |

**gitnexus community detail**: Community nodes are first-class graph citizens with heuristic labels (e.g., "Agents" 508, "Plugins" 426, "Infra" 362, "Gateway" 295, "Scripts" 199 per label property). 7,183 total communities per meta.json; 5,396 Community node entries directly in KuzuDB.

**cleo nexus community failure**: Log output: `Leiden found 26945 raw communities in 126ms` then `Communities: 0 detected, modularity=0.000`. The Leiden algorithm ran but produced modularity=0.000. Root cause: the large-graph mode filters the full symbol set (36,886 symbols) down to 26,945 nodes with 53,479 edges. With this sparse filtered graph, Leiden finds each node as its own community (degenerate partition), modularity collapses to 0, and the 0-filter threshold rejects all communities. This is a critical upstream blocker for T1733.

---

## Axis 4: Callers/Callees Parity (10 symbols) — Details

Symbol comparison using file-qualified UIDs. All from `/mnt/projects/openclaw` (commit d2e2d97).

| Symbol | gitnexus callers | cleo callers | gitnexus callees | cleo callees | Match? |
|--------|-----------------|--------------|-----------------|--------------|--------|
| normalizeOptionalString (src/shared/) | 7 | 20* | 1 | 1 | Partial — cleo aggregates 17 definitions |
| getTaskFlowByIdForOwner | 8 | 7 | 1 | 2 | Close (1-off) |
| normalizeConversationId | 1 | 1 | 0 | 1 | Minor callee diff |
| resolveSummaryModelRef | 1 | 1 | 3 | 4 | Close |
| createSessionActions | 2 | 2 | 0 | 16 | Callers exact; cleo callees 16x higher |
| readVersionFromJsonCandidates | 2 | 2 | 0 | 1 | Close |
| toResolvedModelKey | 2 | 2 | 0 | 1 | Close |
| parseInlineDirectives | 0 | 6 | 2 | 3 | Caller gap: gitnexus missed 6 callers |
| resolveReasoningOutputMode | 10 | 10 | 1 | 3 | Callers exact; callees differ |
| normalizeRestoredFlowRecord | 1 | 1 | 2 | 3 | Close |

*`normalizeOptionalString`: cleo nexus context command aggregates across all 17 same-name definitions in the repo (returns matchCount:17 with 20 callers for the main src/shared/ definition). gitnexus context using file-qualified UID returns 7 callers for that specific definition.

**Verdict**: Both tools agree on core caller topology for 8/10 symbols. Key differences:
- `parseInlineDirectives`: gitnexus returned 0 callers vs cleo 6 — missed CALLS edges
- `createSessionActions`: cleo returns 16 callees vs gitnexus 0 — cleo captures more outbound edges
- Both tools show equivalent caller-set accuracy for well-connected symbols (resolveReasoningOutputMode: both 10 callers)
- **Match verdict stands**: The tools are comparable on caller topology, which is the critical use case for blast-radius analysis

---

## Axis 5: Wiki Output Diff — Details

| Tool | Output Files | Community Count | LLM Required | Status |
|------|-------------|-----------------|--------------|--------|
| gitnexus | 0 (error: no API key) | 7,183 available | Yes (OPENAI_API_KEY or GITNEXUS_API_KEY) | Capability exists but API-key blocked |
| cleo nexus | 1 (overview.md) | 0 detected | No | Placeholder only — no community content |

**gitnexus wiki**: Generates LLM-enriched community documentation. Requires API key. Without it: `Error: No LLM API key found.` Once key provided, would generate per-community wiki pages from 7,183 detected communities.

**cleo nexus wiki**: Generated `/mnt/projects/openclaw/.cleo/wiki/overview.md` but only a placeholder. Content: header + empty community table + "Generated by cleo nexus wiki." No community content because Leiden detected 0 communities.

**Verdict**: Both tools produce no useful wiki in the test environment. However, the root cause differs fundamentally: gitnexus needs an API key (operational issue — communities exist and are ready); cleo nexus needs Leiden fixed (data issue — communities must be detected first). gitnexus has superior wiki capability architecturally.

---

## Axis 6: Hook Augmenter Latency — Details

5 patterns measured: `normalizeOptionalString`, `loadConfig`, `isRecord`, `createSubsystemLogger`, `resolveUserPath`

| Tool | p50 | p95 | Min | Max | Returns Content? |
|------|-----|-----|-----|-----|-----------------|
| gitnexus augment | 317ms | 377ms | 297ms | 377ms | Yes (graph context) |
| cleo nexus augment | 1,979ms | 2,047ms | 1,969ms | 2,047ms | No (empty results) |

**gitnexus augment**: Returns structured context about symbols. FTS warning present (load-only) but graph query succeeds.

**cleo nexus augment**: Returns `{"results":[],"text":""}` for all 5 patterns. Root cause: augmenter searches by community membership or FTS. With 0 communities and no FTS indexed, no results are returned. The 1,979ms latency is process startup + SQLite query overhead.

**Delta**: cleo nexus is 6.3x slower at p50 AND provides no usable output. Both the latency gap and the empty-result problem must be addressed.

---

## Summary Assessment

| Axis | Verdict | Key Numbers |
|------|---------|-------------|
| 1. Symbol counts | falls-behind | cleo: 64,230 vs gitnexus: 251,832 (−75%). Biggest gaps: Const nodes (0 vs 128,805), functions (35,163 vs 67,125), properties (1,068 vs 18,850) |
| 2. IMPORTS edge counts | falls-behind | cleo: 150,770 vs gitnexus: 748,581 (−80%). IMPORTS: 46,674 vs 390,893 (8.4x gap). Note: cleo captures more CALLS (86,293 vs 63,267) |
| 3. Community counts (Leiden) | falls-behind | cleo: 0 communities (modularity=0.000). gitnexus: 7,183. Root cause: large-graph filter creates degenerate partition |
| 4. Callers/callees parity | matches | Both agree on core topology for 8/10 symbols. parseInlineDirectives: gitnexus missed 6 callers. createSessionActions: cleo reports 16x more callees |
| 5. Wiki output | falls-behind | Both blocked in test env; gitnexus blocked by missing API key (communities ready); cleo blocked by Leiden failure (no communities) |
| 6. Augmenter latency | falls-behind | cleo: 1,979ms p50 + empty results vs gitnexus 317ms + graph context (6.3x slower, no output) |

**Overall**: cleo nexus matches gitnexus on caller/callee topology (the most critical use case for blast-radius analysis — axis 4). Falls behind on 5 of 6 axes. The Leiden community detection failure (axis 3, modularity=0.000) cascades to axes 5 and 6. Axes 1 and 2 reflect genuine differences in the ingestion pipeline scope (gitnexus captures Const/Variable/Struct nodes and DEFINES/MEMBER_OF/ACCESSES relations; cleo nexus captures type_alias and folder nodes not in gitnexus).

---

## Followup Tasks Filed

4 new tasks filed under T1042 for falls-behind axes:

| Task | Title | Axis | Priority |
|------|-------|------|---------|
| T1762 | Symbol count gap — investigate 20k→187k node deficit (function coverage + DEFINES/MEMBER_OF/ACCESSES) | 1 | high |
| T1763 | IMPORTS edge gap — 8.4x deficit (46,674 vs 390,893) | 2 | high |
| T1764 | Fix Leiden community detection — 0 communities, modularity=0.000 (blocks T1733, axis 5, axis 6) | 3 | high |
| T1765 | Fix augmenter — 6.3x slower + empty results (blocked by T1764) | 6 | high |

Note: Axis 5 (wiki) is blocked by T1764. Once Leiden communities are fixed, cleo nexus wiki generation becomes viable.

---

## T1733 Unblock Status

T1733 (Leiden package swap evaluation) requires Leiden partition-quality data. This evidence document provides:

- **Baseline**: Current cleo nexus Leiden produces 0 communities (modularity=0.000) on openclaw
- **Reference**: gitnexus Leiden produces 7,183 communities on same repo  
- **Root Cause**: Large-graph mode filter reduces 36,886 symbols to 26,945 nodes/53,479 edges; Leiden finds degenerate partition in this filtered graph; modularity collapse to 0 causes all communities to be rejected
- **T1733 Status**: Partially unblocked — we have baseline data. However T1733 cannot evaluate a package swap until T1764 fixes the Leiden pipeline to produce non-zero communities first. T1733 evaluation itself (comparing leiden package A vs B) requires working communities.

**Recommendation**: Resolve T1764 (fix Leiden degenerate partition) before T1733 (package swap evaluation). T1764 may resolve T1733 entirely if the root cause is the filter threshold rather than the Leiden library itself.

---

## T1062-T1072 Update

All 11 records updated 2026-05-04 with note:
> "T1736 parity 2026-05-04: full re-run validation on openclaw commit d2e2d97. cleo nexus matches gitnexus on caller-topology (axis-4) but falls-behind on axes 1,2,3,5,6. See SUPERSESSION-EVIDENCE.md. Key: symbol count -75% (64,230 vs 251,832), IMPORTS edges -88% (46,674 vs 390,893), 0 communities vs 7,183, augmenter empty+6.3x slower. 4 followup tasks filed: T1762-T1765."

---

*Generated by T1736 D3 Validation Campaign subagent. Evidence commit: a7f008812f59da752da63da82bf071f440561c89.*

---

## Axis 1 — Function Coverage + DEFINES/MEMBER_OF/ACCESSES: Root Cause Investigation

**Added by T1762 (2026-05-04)**. Full spec at `/mnt/projects/cleocode/.cleo/rcasd/T1762/research/symbol-coverage-gap.md`.

### Root Causes Identified

| Gap | Root Cause | Verdict |
|-----|-----------|---------|
| DEFINES edges (0 vs 223,627) | Pure omission — `defines` type declared in GraphRelationType but never emitted. parse-loop.ts adds nodes without a file→symbol edge. | **Fixable: 20-line addition** |
| MEMBER_OF edges (0 vs 23,798) | Downstream of Leiden failure (T1764). Community-processor.ts would emit member_of on successful community detection. Not a pipeline design gap. | **Blocked by T1764** |
| ACCESSES edges (0 vs 8,293) | Missing extraction phase: no AST walk for assignment_expression/member_expression access patterns. PropertyIndex not built. `accesses` type exists in schema. | **Requires new access-extractor.ts** |
| Function gap (35,163 vs 67,125) | (a) walkDefinitions only recurses CONTAINER_TYPES — misses nested namespaces; (b) 32,767-char tree-sitter limit skips large files entirely; (c) arrow functions in object literals not extracted | **Partially fixable, requires TS upgrade for (b)** |
| Const nodes (0 vs 128,805) | walkDefinitions guard rejects non-arrow-function lexical_declaration. Exported-only strategy would add high-value subset (~5-10k nodes) without full inflation | **Fixable: export-filtered const extraction** |
| Property nodes (1,068 vs 18,850) | Interface/type-alias member signatures not individually extracted. Only `public_field_definition` in class bodies extracted. | **Fixable: extend buildInterfaceNode** |

### 390,191 Unresolved Calls — Root Causes

1. **Missing function nodes**: Many callee functions are not in the graph (Const gap, nested namespace gap). Tier 1/2a/3 all fail because the target nodeId doesn't exist.
2. **No Tier 2b**: No type-annotation resolver. `const x: SomeClass = ...` followed by `x.method()` cannot be resolved without tracking type annotations.
3. **Tier 3 ambiguity filter**: Common method names (`get`, `set`, `create`) generate many candidates; all are dropped. gitnexus uses type inference to disambiguate.
4. **Barrel chain failures**: Wildcard re-exports (`export * from '...'`) resolve to a source file but the symbol table lookup fails when the target symbol wasn't indexed.

### Far-Exceed Strategy (Axis 1)

Cleo can surpass gitnexus on these specific vectors (not available in gitnexus):

1. **Brain-anchored DEFINES**: `brain_observation → symbol` defines edge — navigable path from documented intent to implementation. Unique to cleo's 5-substrate architecture.
2. **Cross-package MEMBER_OF heritage**: `method → interface` membership edges (method implements interface contract). Enables "full interface contract surface of package X" queries.
3. **Semantic ACCESSES with read/write discrimination**: `accessMode: 'read' | 'write' | 'readwrite'` metadata on ACCESSES edges. "Which functions write to Property X?" — critical for mutation impact analysis.
4. **Tier 2b type-annotation resolver**: Resolving 30-50% of the 390k unresolved calls via explicit type annotations would give cleo MORE resolved CALLS edges than gitnexus (86,293 current + ~100k Tier 2b >> gitnexus 63,267).
5. **Exported-only Const strategy**: Selective high-signal Const nodes (exported only) vs gitnexus's indiscriminate 128k inflation. Better signal/noise for API surface analysis.

### Implementation Priority

| Priority | Phase | Effort | Impact |
|----------|-------|--------|--------|
| P0 | DEFINES edges (parse-loop.ts) | 1 day | Closes file→symbol traversal gap |
| P0 | Container expansion (CONTAINER_TYPES) | 0.5 day | Closes nested namespace function gap |
| P1 | Exported Const nodes | 1 day | Adds API surface visibility |
| P1 | Interface member extraction | 1 day | Adds ~15-17k property nodes |
| P2 | ACCESSES extraction (new access-extractor.ts) | 3-5 days | Closes read/write tracking gap |
| P2 | Tier 2b type-annotation resolver | 3-5 days | Cuts 390k unresolved calls by 30-50% |
| P3 | tree-sitter 0.22+ upgrade | 1-2 days | Removes 32k char limit on file parsing |
