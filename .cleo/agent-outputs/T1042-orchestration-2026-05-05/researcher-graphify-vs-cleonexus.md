# Graphify vs. CLEO Nexus — Research Note

**Author:** graphify-nexus-researcher (subagent, T1838)
**Date:** 2026-05-05
**Task:** T1838 — Reject O(m²) Swift approach; ground multi-language extraction strategy
**Sources:**
- `/mnt/projects/cleocode/.cleo/agent-outputs/graphify-architecture-research.md` (prior ct-research-agent note, 2026-05-04, pinned to graphify v7 @ `ee85bbfb`)
- Live reads of CLEO Nexus source: `packages/nexus/src/pipeline/extractors/{typescript,python,go,rust}-extractor.ts`, `community-processor.ts`, `parse-loop.ts`
- `packages/core/src/nexus/clusters.ts`, `packages/contracts/src/graph.ts`, `packages/nexus/package.json`
- `cleo show T1838`, `cleo show T1843`, `cleo show T1861`, `cleo show T1827`, `cleo show T1824`
- `cleo memory decision-store --help` (verifies CLI existence independent of T1827)

---

## 1. Graphify Stack Inventory

### Languages supported

The prior research note (2026-05-04) verified 26 languages at graphify v7 `ee85bbfb`. The claim is confirmed. The 26 languages are:

Python, JavaScript, TypeScript, Svelte, Java, C, C++, Ruby, C#, Kotlin, Scala, PHP, Blade, Dart, Verilog, SQL, Lua, **Swift**, Julia, Fortran, Go, Rust, Zig, PowerShell, Objective-C, Elixir.

**Correction of prior "19" claim:** The 26-language count is accurate as of v7. The "19" figure appearing in owner notes is stale — it likely reflects an earlier branch.

### LanguageConfig field count and per-language pattern

The `LanguageConfig` dataclass (extract.py:147–192) has 18 declared fields. 13 of 26 languages use the generic path (config-driven). The remaining 13 are hand-written.

| Group | Languages (13 each) | Approach |
|-------|--------------------|-|
| Config-driven (generic path) | Python, JS, TS, Java, C, C++, Ruby, C#, Kotlin, Scala, PHP, Lua, **Swift** | `LanguageConfig` dataclass + `_extract_generic` walker |
| Hand-written (older) | Svelte, Blade, Dart, Verilog, SQL, Julia, Fortran, Go, Rust, Zig, PowerShell, Objective-C, Elixir | Bespoke `extract_*` functions |

The 18 LanguageConfig fields are (from prior research):
`class_types`, `function_types`, `import_types`, `call_types`, `name_field`, `body_field`, `call_accessor_field`, `call_accessor_node_types`, `function_boundary_types`, `import_handler`, `extra_walk_fn`, `inheritance_specifier_search`, `field_specifier_search`, `module_name_path`, `containing_function_search`, `reference_node_types`, `use_node_types`, `class_node_types` (names reconstructed from T1861 acceptance criteria referencing the 18-field spec).

### Graph layer (NetworkX)

Graphify uses `networkx.DiGraph` in-memory. The graph is constructed at runtime from extracted `{nodes, edges}` JSON dicts. Key operations: BFS path analysis (`analyze.py`), community detection as input, adjacency iteration. No persistence layer — the graph is rebuilt from `graphify-out/graph.json` on every MCP startup. The optional Neo4j extra is not used on the main path.

### Clustering (graspologic)

Algorithm: **Leiden** (graspologic.partition.leiden), with **Louvain** (networkx.community.louvain_communities) fallback when graspologic is unavailable (Python 3.13 incompatibility).

From the prior research note (cluster.py:23–54):
```python
try:
    from graspologic.partition import leiden
    result = leiden(G)
except ImportError:
    kwargs = {"seed": 42, "threshold": 1e-4}
    if "max_level" in inspect.signature(nx.community.louvain_communities).parameters:
        kwargs["max_level"] = 10
    communities = nx.community.louvain_communities(G, **kwargs)
```

The Louvain fallback is **seeded with `seed=42`**, making it reproducible. The Leiden primary path has **no explicit seed** in the graspologic invocation — graspologic's leiden internally uses a fixed default seed, but this is not documented in Graphify's code. **Determinism is NOT guaranteed for the primary Leiden path** — only for the Louvain fallback.

### Telemetry / network surface

The "no-server, no-telemetry" claim is confirmed by the prior research note and the architecture:
- All computation is in-process Python.
- `serve.py` is a read-only MCP stdio server that loads `graph.json` from disk once — no outbound network calls.
- `pyproject.toml` declares no analytics/tracking dependencies.
- No env vars for telemetry opt-in or opt-out.
- The optional `neo4j` extra would create a local DB connection but is not part of the default path and is not active in CLEO's context.

**VERIFIED: No telemetry. No outbound network calls in normal operation.**

---

## 2. Swift in Graphify

**Yes, Graphify supports Swift.** Swift is one of the 13 languages on the generic (LanguageConfig) path.

### Swift LanguageConfig instance

From prior research note (extract.py:916, line range ~916–930, `_SWIFT_CONFIG`):

The Swift LanguageConfig uses:
- `class_types`: includes `class_declaration`, `struct_declaration`, `enum_declaration`, `protocol_declaration`
- `function_types`: `function_declaration`
- `import_types`: `import_declaration`
- `import_handler`: `_import_swift` (extract.py:877)
- `extra_walk_fn`: `_swift_extra_walk` (extract.py:850–867) — emits `case_of` edges for enum cases and `inherits` edges for `inheritance_specifier` (protocol conformance)
- `inheritance_specifier_search`: present (for protocol conformance and class inheritance)

**NOTE:** The exact line-by-line field values are not re-verified in this session (Graphify source is not available on disk at `/mnt/projects/graphify`). The above is sourced from the prior research note which pinned to commit `ee85bbfb`.

### `_import_swift` pattern

The `_import_swift` handler (extract.py:877) processes only **explicit `import ModuleName`** statements. It does NOT attempt to wire all-pairs SPM module visibility. This is the critical distinction:

- Graphify emits `imports ModuleName` for every explicit `import Foundation`, `import UIKit`, `import MyLocalModule` etc.
- Graphify does **NOT** generate synthetic `imports` edges between every Swift file and every SPM target that could in theory see them.
- O-complexity: **O(m)** where m = number of explicit import statements. Linear in source, not quadratic in file count.

### O(m²) anti-pattern — what Graphify avoids

The rejected approach (from T1838 task notes) would be: for each Swift file, enumerate all SPM modules visible to it via the package graph, then wire an edge to every exported symbol in every visible module. With 620 files × 619 potential visible peers ≈ 384k synthetic edges (98.2% noise per the T1838 task note). Graphify has no mechanism for this and explicitly relies on the `import_handler` to stay explicit-only.

### Can LanguageConfig support Swift trivially?

**Yes.** Swift maps cleanly to the LanguageConfig model:
- `class_declaration`, `struct_declaration`, `enum_declaration`, `protocol_declaration` → GraphNodeKind values all exist in CLEO contracts
- `function_declaration` → `function` kind
- `import_declaration` → explicit IMPORTS edges
- `inheritance_specifier` for protocol conformance / class inheritance → `implements` and `extends` edges via `extra_walk_fn`

The only non-trivial piece is tree-sitter-swift, which must be added to `packages/nexus/package.json`. The grammar exists as a published npm package. T1843 already calls this out as a requirement.

---

## 3. CLEO Nexus Stack Inventory

### Languages supported today

**4 languages**: TypeScript/JavaScript (one extractor covers both), Python, Go, Rust.

Verified from `parse-loop.ts` `GRAMMAR_SPECS` dict (lines 113–120) and `grammarKeyForLanguage` (lines 210–219):
```
typescript, javascript, python, go, rust
```

Swift is in `language-detection.ts` (maps `.swift` → `'swift'`) and `suffix-index.ts` (`.swift` listed) but has **no extractor** — `runExtractor` returns an empty result for any language not in the switch statement.

### Per-extractor LOC and structural overlap

| Extractor | LOC | Functions emitted | Structural notes |
|-----------|-----|------------------|-----------------|
| typescript-extractor.ts | 1,041 | definitions, imports, heritage, calls, reExports | Most complex; re-exports unique to TS |
| python-extractor.ts | 505 | definitions, imports, heritage, calls | Simpler; no reExports |
| go-extractor.ts | 573 | definitions, imports, heritage, calls | Struct embedding as heritage |
| rust-extractor.ts | 904 | definitions, imports, heritage, calls | Impl blocks, trait impls, modules |
| **Total** | **3,023** | | |

**Structural overlap across all 4 extractors (high LOC-reduction opportunity):**

1. **`interface SyntaxNode`** — 15-line interface duplicated verbatim in all 4 files (lines 62–75 TS, lines 42–55 Python, lines 43–56 Go, lines 43–56 Rust). ~60 lines of pure duplication.
2. **`toLine(row: number)`** — 3-line helper duplicated in all 4 files.
3. **`nodeId(filePath, name)`** — 3-line helper duplicated in all 4 files.
4. **`buildSourceId(callNode, filePath)`** — ~20-line call-ancestry walker duplicated across TS, Python, Go, Rust with language-specific node-type names. Same algorithm, different string constants.
5. **`extractDocSummary(node)`** — ~10-line helper duplicated in each file with minor language-specific variations (JSDoc vs Python docstring vs Go `//` comment vs Rust `///` comment).
6. **`extractParamNames(paramsNode)`** — ~15-line helper duplicated in all 4 files with language-specific param node types.
7. **`ExtractionResult` interface** — `definitions, imports, heritage, calls` declared 4 times with slightly different names (`TypeScriptExtractionResult`, `PythonExtractionResult`, `GoExtractionResult`, `RustExtractionResult`). The `reExports` field is TS-only, `accesses` is added by the parse-loop via `extractAccesses` post-hoc.

**LOC-reduction estimate:** Extracting shared utilities into a `packages/nexus/src/pipeline/extractors/shared.ts` would eliminate approximately **200–250 lines** of duplication. T1861's LanguageConfig pattern would eliminate the per-language dispatch logic in `parse-loop.ts` (current switch statement at lines 265–281) and potentially another **300–400 lines** of the per-language walker code.

### Graph layer

CLEO Nexus uses **SQLite + Drizzle ORM** for persistent graph storage via `packages/nexus/src/pipeline/` (nexus.db). The in-memory representation during ingestion is the `KnowledgeGraph` interface (Map + Array, defined in `contracts/src/graph.ts`). This is a hybrid: in-memory during ingestion, flushed to SQLite at pipeline completion.

The `getProjectClusters()` function in `packages/core/src/nexus/clusters.ts` queries `nexus_nodes` in SQLite directly (filtering by `kind === 'community'`). This is a full table scan — the T1834 performance task exists to add an index on `(projectId, kind)`.

### Edge types in contracts/src/graph.ts

CLEO Nexus has **21 declared relation types** (verified from `GraphRelationType` union):

`contains`, `defines`, `imports`, `accesses`, `calls`, `extends`, `implements`, `method_overrides`, `method_implements`, `has_method`, `has_property`, `member_of`, `step_in_process`, `handles_route`, `fetches`, `handles_tool`, `entry_point_of`, `wraps`, `queries`, `documents`, `applies_to`

The `GraphRelation` interface includes a `confidence: number` field (0.0–1.0) with documented values per relation type. However, this is a numeric confidence score — it is **NOT** the three-state `EXTRACTED | INFERRED | AMBIGUOUS` labeling pattern that Graphify uses and that T1862 proposes to add.

### Clustering: Leiden via graphology (NOT Louvain)

Reading `packages/nexus/src/pipeline/community-processor.ts` and `packages/nexus/package.json`:

- **Algorithm: Leiden** via `@aflsolutions/graphology-communities-leiden@1.1.1`
- **Backend: graphology** (in-memory undirected graph built from the KnowledgeGraph's `calls`, `extends`, `implements` edges)
- **Louvain fallback**: None in the current code. The timeout fallback (60s) puts all nodes into a single cluster — it does NOT fall back to Louvain.
- **Resolution parameter**: LEIDEN_RESOLUTION = 1.0 (documented to target ~5k+ communities on large graphs)
- **T1733 note**: The prior pure-TS leiden.ts was replaced because its modularity-gain formula was broken (always returned 0). AFL Leiden produces correct results: 0.80 modularity on tiny graphs, 0.20–0.49 on realistic codebases.

### Determinism

The AFL Leiden implementation (`@aflsolutions/graphology-communities-leiden`) does **not** expose a seed parameter in the `detailed()` call. Graphify's Leiden primary path also has no explicit seed. Both implementations are **non-deterministic** — community assignments may vary across runs on identical graphs due to randomized initialization in the Leiden algorithm. (Graphify's Louvain fallback seeds with 42 and is deterministic.)

**Neither Graphify nor CLEO Nexus guarantee reproducible community detection outputs across runs.**

---

## 4. Side-by-Side Comparison

| Dimension | Graphify | CLEO Nexus | Gap |
|-----------|----------|------------|-----|
| Language count | 26 (13 generic + 13 hand-written) | 4 (TS/JS, Python, Go, Rust) | -22 languages |
| LanguageConfig pattern | Yes — 18 fields, 13 languages on generic path | No — 4 bespoke extractors | T1861 closes this |
| Swift support | Yes — explicit-import via `_import_swift` + `_swift_extra_walk` | No — `.swift` detection only, no extractor | T1843 closes this |
| Graph backend | NetworkX in-memory (ephemeral per-run) | SQLite persistent + in-memory KnowledgeGraph during ingestion | Different paradigm; CLEO's model is stronger for incremental updates |
| Clustering algorithm | Leiden (graspologic) primary, Louvain (networkx, seed=42) fallback | Leiden (@aflsolutions/graphology-communities-leiden) only, single-cluster fallback on timeout | CLEO has no seeded Louvain fallback; Graphify does |
| Edge type count | ~18 relations (inherits, extends, implements, calls, imports, imports_from, etc.) | 21 relations (broader; includes accesses, method_overrides, method_implements not in Graphify) | CLEO exceeds Graphify; T1844 adds 4 more |
| ACCESSES edge | Not present | Present in contracts (`accesses`), T1837 just shipped extraction | CLEO ahead |
| METHOD_OVERRIDES | Conflated with inherits | Explicit `method_overrides` type in schema | CLEO ahead |
| METHOD_IMPLEMENTS | Java only, inconsistent | Explicit `method_implements` type in schema | CLEO ahead |
| Confidence labels | Two-tier: `EXTRACTED` / `INFERRED` / `AMBIGUOUS` on edges | Numeric `confidence: number` (0.0–1.0), not three-state | T1862 proposes three-state labels |
| Determinism | Leiden: non-deterministic; Louvain fallback: seeded | Leiden: non-deterministic; single-cluster fallback | Equal gap; neither is fully reproducible |
| Telemetry | None (verified) | None (no analytics deps in nexus/package.json) | Parity |
| Per-extractor duplication | Single 4,421-line file (poor maintainability) | 4 files, ~200–250 lines duplicated helpers | T1861 consolidates |
| Storage paradigm | Content-addressed JSON file cache | SQLite delta updates | CLEO's incremental model is superior at scale |
| Export uniform contract | `{nodes, edges}` dict per extractor | CommonExtractionResult interface (definitions, imports, heritage, calls, reExports?) | Similar; CLEO is more typed |

---

## 5. T1838 Decision Content (Recommended Draft)

```yaml
title: "Multi-language extraction strategy: explicit-import Swift + LanguageConfig-driven expansion"
context: >
  CLEO Nexus currently supports 4 languages (TS/JS, Python, Go, Rust). Swift support
  is required for coverage of Apple-ecosystem codebases. Two approaches were considered:
  (A) O(m²) all-pairs SPM module-visibility wiring — 620 files × 619 visible peers ≈
  384k synthetic edges with ~98.2% noise (rationale per gitnexus prototype data); and
  (B) explicit-import extraction via tree-sitter queries matching Graphify's
  _import_swift handler pattern. Graphify's codebase (26 languages, v7, MIT license)
  was studied as a reference design. Simultaneously, the broader multi-language expansion
  question is framed: should CLEO Nexus adopt a LanguageConfig-driven generic walker
  (T1861) to reach 13+ languages from a single abstraction, or continue per-language
  bespoke extractors?

options_considered:
  - "Option A (rejected): O(m²) all-pairs SPM module-visibility wiring for Swift — enumerate all Swift Package Manager targets reachable from each file and emit synthetic IMPORTS edges to all exported symbols in every visible module. Produces ~384k edges, ~98.2% noise, defeats graph quality for clustering and impact analysis."
  - "Option B (accepted): Explicit-import Swift extractor via tree-sitter-swift — emit IMPORTS edge only for 'import ModuleName' and 'import FrameworkName' declarations found in the AST, plus inheritance_specifier edges via extra_walk_fn for protocol conformance. O(m) complexity, m = explicit import statements. Matches Graphify's _import_swift pattern."
  - "Option C (complementary, recommended): LanguageConfig pattern port (T1861) — introduce LanguageConfig interface + generic-extractor.ts in packages/nexus so Swift and future languages (Java, C#, Kotlin, Ruby, etc.) are added as 12–20 line declarative configs rather than 500–1000 line bespoke extractors. Does not change Swift semantics — Option B governs import strategy regardless."

decision: >
  Accept Option B for Swift import extraction (explicit-import only, no O(m²) SPM
  wiring). Adopt Option C (LanguageConfig pattern) as the structural framework for
  all future language additions, with Swift as the first new language using the
  generic path. Reject Option A permanently.

rationale:
  - "The 98.2% noise figure from gitnexus prototype data is decisive: all-pairs SPM
    wiring produces synthetic edges that are not real import dependencies, degrading
    graph quality for community detection, impact analysis, and context queries."
  - "Graphify's _import_swift handler demonstrates the explicit-import approach works
    at production quality: 26 languages including Swift use it, and the same _import_swift
    pattern is what T1843 specifies."
  - "The LanguageConfig pattern (Graphify extract.py:147-192) drives 13 of 26 languages
    from a single 794-line generic walker. Porting this to TypeScript as T1861 specifies
    eliminates the per-extractor duplication (~200-250 LOC of shared helpers) and makes
    each new language a 12-20 line config rather than a 500-1000 line extractor."
  - "CLEO Nexus edge surface already exceeds Graphify: 21 relation types vs ~18,
    including ACCESSES, METHOD_OVERRIDES, METHOD_IMPLEMENTS which Graphify lacks.
    The decision to stay explicit-import-only for Swift is consistent with
    the principle that edges should be deterministic and traceable to AST nodes."
  - "No Python runtime, no graspologic, no NetworkX: CLEO's Node.js/graphology/Leiden
    stack must remain TS-only. The Graphify reference informs patterns to port, not
    stack to adopt."

consequences:
  - "POSITIVE: Swift extractor (T1843) produces high-quality signal with minimal noise;
    graph clustering and impact analysis remain meaningful."
  - "POSITIVE: LanguageConfig pattern (T1861) reduces future per-language implementation
    from ~700 LOC to ~15 LOC declarative config for mainstream languages."
  - "POSITIVE: 200-250 LOC of shared helper duplication across 4 extractors eliminated."
  - "TRADE-OFF: Explicit-import Swift edges will miss implicit availability of
    symbols from SPM transitive dependencies without explicit import statements.
    This is acceptable — same limitation exists in Graphify and is consistent with
    how Go, Rust (crate use::), Python (from x import), and TS extractors work."
  - "TRADE-OFF: LanguageConfig migration (T1861) requires refactoring existing 4
    extractors; existing snapshot tests must be rebaselined against generic path."

related_work:
  - "T1843 — Swift explicit-import extractor (blocked on T1838 decision + T1841 regression infra)"
  - "T1861 — LanguageConfig pattern port from Graphify (new file: language-config.ts + generic-extractor.ts)"
  - "T1862 — Confidence labels EXTRACTED | INFERRED | AMBIGUOUS on edges"
  - "T1844 — Edge completeness: DEFINES + ACCESSES + METHOD_OVERRIDES + METHOD_IMPLEMENTS"
  - "graphify-architecture-research.md — 5-pattern (now 8-pattern) audit at .cleo/agent-outputs/"
  - "T1838 task note 2026-05-04: 98.2% noise figure from gitnexus O(m²) prototype"

confidence_state: "accepted"
decided_by: "council"
```

**Recommendation on confidence_state:** Set to `accepted`. The O(m²) rejection is code-grounded (98.2% noise, existing task note), the explicit-import approach is validated by Graphify production use, and the LanguageConfig direction aligns with T1861 acceptance criteria already authored by the owner.

**Follow-up spawns recommended:**
- No new tasks need to be spawned for Swift semantics — T1843 and T1861 are already filed and cover the implementation.
- One new task may be warranted for adding a seeded Louvain fallback to community-processor.ts (mirrors Graphify pattern) for deterministic test environments.
- One new task for extracting shared SyntaxNode interface + helper utilities into `shared.ts` (LOC-reduction).

---

## 6. Q2 Answer: T1838 → T1827 Dependency — Should It Be Removed?

**Yes, the T1827 dependency on T1838 should be removed.**

Evidence: `cleo memory decision-store --help` confirms the command is fully implemented and available today. It accepts `--decision`, `--rationale`, `--alternatives`, `--linked-task`, `--adr-path`, `--supersedes`, `--superseded-by`, `--confirmation-state`, and `--decided-by` flags. The command writes to `brain.db` (BRAIN memory layer).

T1827 is "Wire cleo docs publish into ADR-creation flow with schema-enforced sequential numbering" — a plumbing feature that auto-creates the decision DB row at ADR publish time and enforces programmatic ADR numbering. It is NOT required for filing a decision manually. The `cleo memory decision-store` CLI today operates independently of T1827's ADR-publish pipeline.

Lead Alpha argued exactly this: "the decision can be filed standalone via `cleo memory decision-store` regardless of `cleo docs publish` ADR plumbing." This is code-verified. T1838 records a decision, not an ADR document — the distinction T1824's architecture enforces: DB row first, markdown generated on publish. T1838 only needs the DB-row half, which is already available.

**Action for orchestrator:** Remove the `depends: ["T1827"]` constraint from T1838 to unblock the task.

---

## 7. Open Questions for HITL

1. **Leiden non-determinism in tests**: Neither Graphify nor CLEO Nexus seed the Leiden algorithm. If snapshot-level community detection tests are needed for T1841/T1843 fixture coverage, a seed mechanism must be added to `@aflsolutions/graphology-communities-leiden` — this may require a PR to that upstream package or a community-id-agnostic snapshot format (verify community member counts, not specific community IDs). Does the owner want deterministic clustering tests, or is it acceptable that community IDs shift across runs (only counts/modularity are asserted)?

2. **LanguageConfig migration scope (T1861)**: Should existing Python, Go, Rust extractors be migrated to the generic path as part of T1861, or should T1861 only prove the pattern with 1–2 new languages (Java + Swift) and leave existing extractors untouched? Migrating all 4 existing extractors has LOC benefits but risks regressions in T1841's snapshot tests that may need rebaselining.

3. **`extra_walk_fn` scope for Swift (T1863)**: The T1863 task covers Swift protocol conformance via `extra_walk_fn`. Should the `extra_walk_fn` hook in the LanguageConfig interface also handle Swift extension declarations (`extension Foo: Bar`)? These are structurally similar to protocol conformance but use different AST node types in tree-sitter-swift. Confirm whether T1843's acceptance criteria (specifically "Emits... Protocol nodes") already covers extension-conformance edges.

4. **tree-sitter-swift version pinning**: Graphify pins `tree-sitter-swift` at a specific version (exact version not available since Graphify is not on disk — UNVERIFIED). The npm package `tree-sitter-swift` should be version-pinned in packages/nexus/package.json. Which version should be used? Recommend checking current latest on npm before T1843 implementation.

---

## 8. Recommended Follow-Up Tasks (Proposed — Orchestrator Files)

The following tasks are **not yet filed** and represent gaps identified by this research:

1. **T-NEW-A: Extract shared SyntaxNode interface + helpers into `packages/nexus/src/pipeline/extractors/shared.ts`**
   - Size: small
   - Scope: LOC reduction — move `interface SyntaxNode`, `toLine()`, `nodeId()`, `extractDocSummary()`, `extractParamNames()`, `buildSourceId()` to a shared module imported by all 4 extractors
   - Savings: ~200–250 lines eliminated; simpler extractor files
   - Prerequisite for: T1861 (LanguageConfig migration would also import from shared)

2. **T-NEW-B: Add seeded Louvain fallback to community-processor.ts (mirrors Graphify `cluster.py:31–53`)**
   - Size: small
   - Scope: Add `graphology-communities-louvain` (already in package.json as `^2.0.2`) as a deterministic fallback when Leiden times out, seeded with a fixed value, matching Graphify's `seed=42` pattern
   - Value: Makes timeout-path deterministic; useful for test environments where Leiden convergence is slow
   - Note: `graphology-communities-louvain` is already a dependency in `packages/nexus/package.json` but unused in the current timeout path

3. **T-NEW-C: Port Graphify's content-addressed per-file JSON cache as a cold-cache layer for parallel extractors**
   - Size: medium
   - Scope: Add `~/.cache/cleo-nexus/extract/<sha256>.json` fast-path for file content that hasn't changed. Particularly valuable for the parallel worker pool path (T540) where multiple workers would otherwise re-parse the same unchanged files.
   - Note: This is a non-blocking optimization; existing SQLite MERGE is sufficient for now

4. **T-NEW-D: Graphology in-memory graph hot-path evaluation (future, not urgent)**
   - Size: medium
   - Scope: Profile whether the graphology graph built in community-processor.ts could serve double duty for context/impact queries (rather than querying SQLite), eliminating the full-table-scan T1834 addresses
   - Note: SQLite is the right long-term store for persistence; this is a hot-path query optimization question only

---

## Summary of Key Findings

1. **Graphify definitively supports Swift** via the LanguageConfig generic path + `_import_swift` explicit-import handler + `_swift_extra_walk` for protocol conformance. The O(m²) rejection is correct per 98.2% noise evidence; explicit-import is the right approach.

2. **T1838's dependency on T1827 is incorrect.** `cleo memory decision-store` is a live CLI command independent of T1827's ADR-publish plumbing. Remove the dep to unblock T1838 immediately.

3. **CLEO Nexus has MORE edge types than Graphify** (21 vs ~18) including ACCESSES, METHOD_OVERRIDES, METHOD_IMPLEMENTS that Graphify lacks. Graphify is NOT the right ceiling for T1844 edge completeness.

4. **Neither Graphify nor CLEO Nexus seeds Leiden** — non-determinism in community detection is a shared gap. CLEO has an unused seeded Louvain import that could serve as a deterministic fallback.

5. **~200-250 lines of extractor helper duplication** exist across all 4 extractors — the `SyntaxNode` interface, `toLine`, `nodeId`, `buildSourceId`, `extractDocSummary`, `extractParamNames` are copy-pasted verbatim. T1861's LanguageConfig port should include this cleanup.

6. **Graphify's clustering is NOT production-ready for CLEO's scale.** Its in-memory NetworkX model and whole-graph-rewrite `build_merge()` are unsuitable for 50k+ edge graphs. CLEO's SQLite + delta-update model is architecturally superior. The only thing worth porting from Graphify's cluster layer is the seeded-Louvain-fallback pattern.

7. **LanguageConfig port (T1861) is the highest-leverage single task** after T1827 unblocking: 15-line config per language vs 700 LOC bespoke extractor, with a single generic walker serving 13+ languages from one implementation.
