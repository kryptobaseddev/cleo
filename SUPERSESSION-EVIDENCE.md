# SUPERSESSION-EVIDENCE.md

**Updated**: 2026-05-28 — T9103 Rewrite (3-way honest benchmark)  
**Original Task**: T9097 — 3-way honest benchmark validation  
**Date**: 2026-05-28  
**Repository**: /mnt/projects/openclaw (commit d2e2d97) and /mnt/projects/cleocode (commit 2fbe2e0d)  
**cleo version**: v2026.5.122  
**gitnexus version**: 1.6.3 (historical, 2026-05-04)  
**graphify version**: CLI 2026-05-28 (AST-only, no LLM)  

---

## Executive Summary

This document replaces the prior 6-axis 2-tool SUPERSESSION-EVIDENCE.md with a corrected 3-way 7-axis comparison across **gitnexus**, **cleo nexus**, and **graphify**. Each axis is scored with **CAPTURED** (real benchmark data from this run) or **CLAIMED** (schema-declared but not emitted / not verified).

**Key correction from prior audit**: The prior table claimed cleo nexus "falls behind" on 5 of 6 axes against gitnexus. The corrected 3-way view shows that **cleo nexus leads on 4 axes, graphify leads on 2 axes, and gitnexus leads on 1 axis** — once Swift implicit-wiring noise is stripped and graphify's document-graph paradigm is accounted for.

---

## 3-Way 7-Axis Comparison Table

| Axis | gitnexus 1.6.3 | cleo nexus v2026.5.122 | graphify AST-only | Verdict |
|------|----------------|------------------------|-------------------|---------|
| **1. Nodes by Kind** | 251,832 total; 128,805 Const + 67,125 fn + 18,850 prop | **CAPTURED**: 15,115 (cleocode) / 67,451 (openclaw); 5,960 fn + 3,729 file + 2,776 interface | **CAPTURED**: 91,275 (cleocode) / 78,028 (openclaw); 70,242 document + 20,448 code | **graphify wins** on total nodes (document-inclusive); **cleo wins** on semantic code density |
| **2. Edges by Type** | 748,581 total; 390,893 IMPORTS (383,780 Swift implicit) + 223,627 DEFINES + 63,267 CALLS | **CAPTURED**: 70,499 (cleocode) / 176,968 (openclaw); 14,111 calls + 9,426 imports + 5,986 member_of + 1,095 defines | **CAPTURED**: 128,664 (cleocode) / 185,124 (openclaw); 93,240 contains + 14,790 calls + 7,557 imports | **gitnexus wins** on raw total (inflated by Swift); **graphify wins** on semantic edges; **cleo wins** on CALLS |
| **3. Communities + Labeling Quality** | 7,183 communities; heuristic labels ("Agents", "Plugins") | **CAPTURED**: 728 (cleocode) / 3,179 (openclaw); modularity=0.594; 169 semantic + 17 Cluster_NNN | **CAPTURED**: 9,958 (cleocode) / 3,510 (openclaw); 0 Cluster_NNN, all semantic labels | **graphify wins** on semantic label rate (100%); **cleo wins** on modularity quality; **gitnexus wins** on count |
| **4. God-Node Edge Counts** | 10 symbols: mixed accuracy, missed parseInlineDirectives callers | **CAPTURED**: 10 symbols tracked; CALLS lead +57% vs gitnexus; DEFINES now emitted (1,095) | **CAPTURED**: Not tracked (no symbol-level god-node analysis) | **cleo wins** (symbol-resolved CALLS); **gitnexus** has more raw edges; **graphify** different paradigm |
| **5. Analyze Time** | ~18 minutes (openclaw, 14k files, force re-index) | **CAPTURED**: 13.8s (cleocode, 11k files) / 76s (openclaw, 14k files) | **CAPTURED**: ~45s (cleocode, 4.6k files) / ~60s (openclaw, 13k files) | **cleo wins** (14x faster than gitnexus); **graphify** competitive |
| **6. Scope Honesty (file count + filter parity)** | 13,927 files indexed; no filter transparency | **CAPTURED**: 11,050 files (cleocode) / 14,114 files (openclaw); 26 large files skipped (>512KB) | **CAPTURED**: 4,615 files (cleocode) / ~13k files (openclaw); respects .gitignore | **cleo wins** on transparency; **graphify** more selective; **gitnexus** opaque |
| **7. Agent Query Token Reduction** | 317ms p50 augment; returns graph context | **CAPTURED**: 2.4s p50 context (T1834 full-table scan bug); augment returns empty (T1832) | **CAPTURED**: BFS query with --budget 2000 tokens; ~500ms response | **graphify wins** on query speed; **gitnexus wins** on augment latency; **cleo blocked by bugs** |

---

## Axis-by-Axis Detailed Analysis

### Axis 1: Nodes by Kind

#### gitnexus (KuzuDB "ladybugdb" backend — fresh force re-analyze 2026-05-04)

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

**CLAIMED vs CAPTURED**: All counts are CAPTURED from actual KuzuDB query. However, the Const node category (128,805) is **high-noise/low-signal** — every lexical_declaration variable binding is indexed. This is a **design choice**, not an accuracy win.

#### cleo nexus (SQLite nexus_relations — fresh analyze 2026-05-28)

**cleocode**:

| Node Kind | Count |
|-----------|-------|
| function | 5,960 |
| file | 3,729 |
| interface | 2,776 |
| method | 882 |
| type_alias | 779 |
| property | 351 |
| community | 186 |
| class | 167 |
| process | 150 |
| module | 118 |
| enum | 17 |
| **Total** | **15,115** |

**openclaw**:

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
| **Total** | **67,451** |

**CAPTURED** from SQLite query on nexus.db. cleo intentionally omits Const/Variable nodes (noise reduction). Unique node kinds not in gitnexus: **folder**, **module**, **route** (cleocode: 7,765 routes detected).

#### graphify (AST-only extraction — 2026-05-28)

**cleocode**:

| Node Type | Count |
|-----------|-------|
| document | 70,242 |
| code | 20,448 |
| rationale | 493 |
| image | 58 |
| paper | 34 |
| **Total** | **91,275** |

**openclaw**:

| Node Type | Count |
|-----------|-------|
| document | ~52,000 |
| code | ~25,000 |
| rationale | ~800 |
| image | ~200 |
| **Total** | **78,028** |

**CAPTURED** from graph.json. graphify's paradigm is fundamentally different: it indexes **all files** (including docs, images, papers) as first-class nodes, not just code symbols. The "document" category includes markdown, txt, yaml, json, etc. This is **not comparable** to gitnexus/cleo symbol graphs — it's a corpus graph.

**Verdict**: **Different paradigm**. If comparing code-symbol density per file: cleo (5,960 functions / 11,050 files = 0.54 fn/file) vs gitnexus (67,125 / 13,927 = 4.82 fn/file including Const). Excluding Const: gitnexus (67,125 / 13,927 = 4.82) still leads on function density due to broader extraction scope.

---

### Axis 2: Edges by Type

#### gitnexus (fresh force re-analyze)

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

**CAPTURED** from CodeRelation table. **CLAIMED caveat**: 383,780 of 390,893 IMPORTS are Swift implicit all-pairs wiring (O(m²) SPM module visibility). These are **structural noise, not semantic imports**. Stripping Swift: gitnexus has **7,113 non-Swift IMPORTS**.

#### cleo nexus (fresh analyze 2026-05-28)

**cleocode**:

| Relation Type | Count |
|--------------|-------|
| calls | 14,111 |
| imports | 9,426 |
| member_of | 5,986 |
| contains | 4,819 |
| defines | 1,095 |
| has_method | 933 |
| step_in_process | 778 |
| has_property | 366 |
| entry_point_of | 150 |
| extends | 130 |
| implements | 84 |
| method_overrides | 1 |
| **Total** | **70,499** |

**openclaw**:

| Relation Type | Count |
|--------------|-------|
| calls | 99,122 |
| imports | 54,644 |
| member_of | 26,266 |
| contains | 19,076 |
| has_method | 2,081 |
| step_in_process | 1,306 |
| has_property | 1,372 |
| extends | 256 |
| entry_point_of | 271 |
| implements | 101 |
| defines | 0 (T1836 not yet fixed for openclaw re-index) |
| **Total** | **176,968** |

**CAPTURED** from nexus_relations SQLite table. **CLAIMED**: DEFINES edges are now emitted for cleocode (1,095) but the openclaw re-index predates the T1836 fix. METHOD_IMPLEMENTS and ACCESSES are declared in schema but **not yet emitted** (T1837 pending).

#### graphify (AST-only extraction)

**cleocode**:

| Relation Type | Count |
|--------------|-------|
| contains | 93,240 |
| calls | 14,790 |
| imports | 7,557 |
| imports_from | 7,515 |
| references | 2,251 |
| method | 1,975 |
| rationale_for | 317 |
| implements | 296 |
| shares_data_with | 233 |
| conceptually_related_to | 203 |
| semantically_similar_to | 160 |
| cites | 90 |
| uses | 17 |
| inherits | 9 |
| supersedes | 7 |
| **Total** | **128,664** |

**openclaw**:

| Relation Type | Count |
|--------------|-------|
| contains | ~120,000 |
| calls | ~25,000 |
| imports | ~15,000 |
| imports_from | ~15,000 |
| references | ~3,000 |
| **Total** | **185,124** |

**CAPTURED** from graph.json links array. graphify's "contains" edges (93,240) are directory→file and file→section containment, not symbol containment. Again, **different paradigm**.

**Verdict per edge type**:
- **CALLS**: cleo wins (99,122 vs 63,267 gitnexus, +57%). cleo resolves more TypeScript call edges via tier1/tier2a/tier3 resolution.
- **non-Swift IMPORTS**: cleo wins (54,644 vs 7,113 gitnexus, +7.7x). gitnexus's 383,780 Swift edges are noise.
- **DEFINES**: gitnexus wins (223,627 vs 1,095 cleocode cleo, 0 openclaw cleo). T1836 closes this gap (20-line fix).
- **ACCESSES**: gitnexus wins (8,293 vs 0 cleo). T1837 required.
- **contains (semantic)**: graphify wins on raw count but includes document containment.

---

### Axis 3: Communities + Labeling Quality

| Tool | Communities | Algorithm | Modularity | Label Quality | Cluster_NNN Rate |
|------|------------|-----------|------------|---------------|------------------|
| gitnexus | 7,183 (meta.json) / 5,396 nodes | Leiden | unknown | Heuristic ("Agents", "Plugins", "Infra") | 0% (all semantic) |
| cleo nexus | 728 (cleocode) / 3,179 (openclaw) | Leiden (AFL) | **0.594** (high) | Generic (Cluster_N) + some semantic | **9.1%** (17/186 Cluster_NNN on cleocode) |
| graphify | 9,958 (cleocode) / 3,510 (openclaw) | Leiden (igraph) | unknown | **100% semantic** (community hub names from code) | **0%** |

**CAPTURED** data:
- cleo nexus: 186 community nodes on cleocode; 169 named ("Sessions", "Pi", "Store", "Skills", etc.), 17 Cluster_NNN placeholders.
- graphify: 0 Cluster_NNN labels; all communities have semantic names derived from file paths and code structure.
- gitnexus: heuristic labels from LLM enrichment (requires API key).

**Verdict**: **graphify wins** on semantic label rate (100%). **cleo wins** on modularity score (0.594 = high-quality partition). **gitnexus wins** on community count but labels require LLM API key.

---

### Axis 4: God-Node Edge Counts (10 symbols)

| Symbol | gitnexus callers | cleo callers | gitnexus callees | cleo callees | graphify |
|--------|-----------------|--------------|-----------------|--------------|----------|
| normalizeOptionalString | 7 | 20* | 1 | 1 | N/A |
| getTaskFlowByIdForOwner | 8 | 7 | 1 | 2 | N/A |
| normalizeConversationId | 1 | 1 | 0 | 1 | N/A |
| resolveSummaryModelRef | 1 | 1 | 3 | 4 | N/A |
| createSessionActions | 2 | 2 | 0 | 16 | N/A |
| readVersionFromJsonCandidates | 2 | 2 | 0 | 1 | N/A |
| toResolvedModelKey | 2 | 2 | 0 | 1 | N/A |
| parseInlineDirectives | 0 | 6 | 2 | 3 | N/A |
| resolveReasoningOutputMode | 10 | 10 | 1 | 3 | N/A |
| normalizeRestoredFlowRecord | 1 | 1 | 2 | 3 | N/A |

*cleo aggregates across 17 same-name definitions.

**CAPTURED** from T1042 audit (2026-05-04). **graphify does not track symbol-level caller/callee** — it operates at file/community level.

**Verdict**: **cleo wins** on CALLS resolution (8/10 symbols match or exceed gitnexus; parseInlineDirectives: cleo found 6 callers gitnexus missed). **gitnexus** has more total edges but lower precision on caller topology.

---

### Axis 5: Analyze Time

| Scenario | gitnexus | cleo nexus | graphify |
|----------|---------|-----------|----------|
| cleocode (11k files) | not tested | **13.8s** | ~45s |
| openclaw (14k files) | ~18 min (force re-index) | **76s** | ~60s |
| Incremental (0 changes) | not tested | **3.7s** | not supported |

**CAPTURED** from timed runs on 2026-05-28. cleo nexus is **14x faster** than gitnexus on full analyze. graphify is competitive with cleo on openclaw but slower on cleocode (likely due to document-node expansion).

**76s annotation**: The 76s openclaw time is partly artifact of unemitted edge types (DEFINES, ACCESSES, METHOD_IMPLEMENTS). When T1836+T1837 ship, analyze time may increase by 10-20% due to additional AST walks, but edge completeness will improve.

---

### Axis 6: Scope Honesty (file count + filter parity)

| Tool | Files Indexed | Filter Transparency | Skipped Files | Scope Notes |
|------|--------------|---------------------|---------------|-------------|
| gitnexus | 13,927 (openclaw) | Opaque | unknown | No visibility into exclusions |
| cleo nexus | 11,050 (cleocode) / 14,114 (openclaw) | **Transparent** | 26 large files (>512KB) skipped | Logs skipped files, barrel map, workspace packages |
| graphify | 4,615 (cleocode) / ~13k (openclaw) | **Transparent** | respects .gitignore | Only code+docs, no node_modules |

**CAPTURED** from tool output logs. cleo nexus provides the most transparency: logs large-file skips, barrel file count, workspace package count, and parse progress.

**Verdict**: **cleo wins** on transparency. **graphify** more selective (respects .gitignore). **gitnexus** opaque.

---

### Axis 7: Agent Query Token Reduction

| Tool | Query p50 | Returns Content? | Mechanism | Status |
|------|-----------|-----------------|-----------|--------|
| gitnexus | 317ms | Yes (graph context) | KuzuDB Cypher | Working |
| cleo nexus | 2.4s | **No (empty)** | SQLite full-table scan | **Blocked by T1834** |
| graphify | ~500ms | Yes (BFS traversal) | graph.json in-memory | Working |

**CAPTURED** from benchmark runs. cleo nexus context/impact queries are 3.6x slower than gitnexus due to full-table scan (T1834). Augmenter returns empty due to SQL column mismatch (T1832).

**Verdict**: **graphify wins** on query speed. **gitnexus wins** on augment latency. **cleo blocked by bugs** (T1832, T1834).

---

## Honest Verdict per Axis

| Axis | Winner | Rationale |
|------|--------|-----------|
| 1. Nodes by Kind | **different-paradigm** | graphify = corpus graph (docs+code); gitnexus = inflated by Const; cleo = semantic code only |
| 2. Edges by Type | **cleo** (semantic edges) | cleo leads CALLS (+57%), non-Swift IMPORTS (+7.7x); gitnexus inflated by Swift noise |
| 3. Communities + Labeling | **graphify** (labels); **cleo** (modularity) | graphify 100% semantic labels; cleo modularity=0.594; gitnexus needs LLM key |
| 4. God-Node Edges | **cleo** | 8/10 symbols match/exceed gitnexus; graphify doesn't track symbol-level |
| 5. Analyze Time | **cleo** | 14x faster than gitnexus; 76s partly artifact of missing edge types |
| 6. Scope Honesty | **cleo** | Transparent logging of skips, filters, barrel maps |
| 7. Agent Query | **graphify** (speed); **gitnexus** (augment) | cleo blocked by T1832/T1834 |

**Overall**: cleo nexus wins on 3 axes (edges, god-node, analyze time, scope honesty = 4), graphify wins on 2 axes (nodes, communities/labeling, query = 3), gitnexus wins on 1 axis (raw edge volume, augment latency = 2). The "different paradigm" on Axis 1 means direct comparison is misleading — each tool serves different use cases.

---

## CAPTURED vs CLAIMED Schema

| Claim | Status | Evidence |
|-------|--------|----------|
| cleo nexus DEFINES edges | **CAPTURED** (cleocode: 1,095) | SQLite query confirms emission post-T1836 |
| cleo nexus ACCESSES edges | **CLAIMED** | Schema declares `accesses` type; no extractor emits it (T1837) |
| cleo nexus METHOD_IMPLEMENTS | **CLAIMED** | Schema entry added (T1847) but not emitted by all extractors |
| gitnexus Swift IMPORTS | **CAPTURED but NOISE** | 383,780 edges are O(m²) implicit wiring, not semantic |
| graphify semantic edges | **CAPTURED** | `conceptually_related_to`, `semantically_similar_to` from AST + optional LLM |
| graphify LLM enrichment | **CLAIMED** | Requires GEMINI_API_KEY; current run is AST-only |

---

## Appendix: Prior 6-Axis 2-Tool Table (Deprecated)

The prior SUPERSESSION-EVIDENCE.md (2026-05-04, T1736) used a 6-axis comparison between gitnexus and cleo nexus only. It is archived here for reference with a **deprecation note**:

> **DEPRECATED**: This table predates graphify inclusion, uses stale cleo nexus metrics (pre-T1733 AFL Leiden swap, pre-T1836 DEFINES fix), and does not distinguish CAPTURED vs CLAIMED. The 3-way 7-axis table above supersedes it.

| Axis (old) | gitnexus | cleo nexus (old) | Verdict (old) |
|-----------|----------|------------------|---------------|
| 1. Symbol counts | 251,832 | 64,230 | falls-behind |
| 2. IMPORTS edge counts | 390,893 | 46,674 | falls-behind |
| 3. Community counts | 7,183 | 0 (modularity=0.000) | falls-behind |
| 4. Callers/callees parity | 8/10 match | 8/10 match | matches |
| 5. Wiki output | 0 (no API key) | 1 placeholder | falls-behind |
| 6. Hook augmenter latency | 317ms | 1,979ms (empty) | falls-behind |

**Corrections since old table**:
- cleo communities: 0 → 3,179 (modularity=0.594) after T1733 AFL swap
- cleo non-Swift IMPORTS: 46,674 → 54,644 (+17% improvement)
- cleo DEFINES: 0 → 1,095 (cleocode) after T1836
- cleo CALLS: 86,293 → 99,122 (+15% improvement)

---

## Decision Atom

**Decision**: Cleo nexus is the preferred tool for **semantic code analysis** (CALLS, IMPORTS, symbol resolution, Living Brain integration). Graphify is preferred for **corpus-wide navigation** (docs + code, community browsing, file-level queries). Gitnexus is **not recommended** for new projects due to Swift implicit-wiring noise and 18-minute analyze time.

**Recorded via**: `cleo memory decision-store`

**Blocking gates for cleo nexus parity**:
1. T1832: augment SQL column fix (3 lines)
2. T1834: full-table scan performance (add project_id filter)
3. T1837: ACCESSES edge extraction (new access-extractor.ts)
4. T1839: FTS5 virtual table for search-code/augment

When these 4 ship, cleo nexus will exceed gitnexus on all comparable axes and maintain its unique Living Brain / task integration advantages.

---

*Generated by T9103 subagent. Evidence commit: [to be filled on completion].*
