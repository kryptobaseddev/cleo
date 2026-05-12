# Graphify Architecture Research

**Author:** ct-research-agent
**Date:** 2026-05-04
**Subject:** Deep technical study of [graphify](https://github.com/safishamsi/graphify) (a.k.a. PyPI `graphifyy`) — competitor / reference design for `cleo nexus`
**Source pinned at:** branch `v7`, HEAD `ee85bbfb` (2026-05-04 18:00 UTC), version `0.7.5`
**License:** MIT
**Filing context:** T1840 multi-language extractors, T1843 Swift extractor, T1844 edge completeness

---

## Executive Summary

1. **Graphify ships 26 languages from a single 4,421-line file** (`graphify/extract.py`) using a *config-driven* extractor pattern (`LanguageConfig` dataclass, lines 147–192). Each language is ~15 lines of declarative AST-node-type sets plus an optional 30–80 line import handler. **This is the highest-leverage idea in the codebase** — directly applicable to T1840.
2. **It is *not* server-less by virtue of architecture — it is artifact-based.** The pipeline writes one immutable `graph.json` to `graphify-out/` and the optional MCP `serve.py` reads that JSON into a NetworkX graph in memory on each invocation. There is no SQLite, no daemon, no incremental graph store.
3. **Graspologic Leiden is imported in-process with a Louvain (`networkx.community.louvain_communities`) fallback** (`cluster.py:31–53`) — gated by Python 3.13 compatibility (`pyproject.toml` declares `graspologic; python_version < '3.13'`). The fallback uses `inspect.signature` to detect `max_level` to avoid hangs on large sparse graphs. **This dual-path pattern is worth copying** — gives us a quality/portability tradeoff knob.
4. **Graphify emits only ~15 distinct edge relations**, and its set is *narrower* than what cleo nexus already targets. It has `defines`, `contains`, `calls`, `imports`, `imports_from`, `dynamic_import`, `inherits`, `implements`, `extends`, `uses`, `uses_component`, `uses_static_prop`, `references_constant`, `binds_method`, `bound_to`, `listened_by`, `rationale_for`, `case_of`. It has **no** dedicated `ACCESSES` / `METHOD_OVERRIDES` edges; method override is collapsed into `inherits`. **This is a gap, not a model — T1844 should *exceed* their edge surface, not match it.**
5. **Storage is a content-addressed JSON file cache keyed by SHA256 of file content** (`graphify-out/cache/ast/<sha>.json` and `.../semantic/<sha>.json` — `cache.py`). No database. No incremental graph merge in the storage layer; merging is a runtime concern in `build.py::build_merge()`. **For cleo nexus this validates our SQLite choice but offers a cheap fallback for cold-cache parsing.**

---

## Languages Supported (verified)

Source: `pyproject.toml` (lines 14–40) + every `extract_*` function in `extract.py`.

The README claim is "26 languages." The user's brief said "19" — that figure is stale. Here is the verified table, with extractor function line numbers from `extract.py`. LOC reflects line range from one `extract_*` function to the next; the bulk of work happens in `_extract_generic` at line 933.

| Language     | tree-sitter grammar          | `extract_*` fn line | Style                            | LanguageConfig | Import handler | Notes |
|--------------|------------------------------|---------------------|----------------------------------|---------------:|----------------|-------|
| Python       | `tree-sitter-python`         | 1726                | Generic + `_PYTHON_CONFIG`       | line 677       | `_import_python` (l.222) | Resolves relative imports up parent dirs |
| JavaScript   | `tree-sitter-javascript`     | 1734                | Generic + `_JS_CONFIG`           | line 690       | `_import_js` (l.267)     | Reads `tsconfig.json` path aliases |
| TypeScript   | `tree-sitter-typescript`     | 1734                | Generic + `_TS_CONFIG`           | line 703       | `_import_js`             | Same handler as JS |
| Svelte       | (custom parser)              | 1740                | Hand-written                     | —              | (inline)                  | ~70 LOC special-case |
| Java         | `tree-sitter-java`           | 1813                | Generic + `_JAVA_CONFIG`         | line 717       | `_import_java` (l.422)   | `extends`/`implements` edges |
| C            | `tree-sitter-c`              | 1818                | Generic + `_C_CONFIG`            | line 729       | `_import_c` (l.461)      | `resolve_function_name_fn` for declarator unwrap |
| C++          | `tree-sitter-cpp`            | 1823                | Generic + `_CPP_CONFIG`          | line 743       | `_import_c`              | Same C handler |
| Ruby         | `tree-sitter-ruby`           | 1828                | Generic + `_RUBY_CONFIG`         | line 757       | (no handler)             | |
| C#           | `tree-sitter-c-sharp`        | 1833                | Generic + `_CSHARP_CONFIG`       | line 770       | `_import_csharp` (l.481) | namespace walk via `extra_walk_fn` |
| Kotlin       | `tree-sitter-kotlin`         | 1838                | Generic + `_KOTLIN_CONFIG`       | line 784       | `_import_kotlin` (l.501) | |
| Scala        | `tree-sitter-scala`          | 1843                | Generic + `_SCALA_CONFIG`        | line 803       | `_import_scala` (l.537)  | |
| PHP          | `tree-sitter-php`            | 1848                | Generic + `_PHP_CONFIG`          | line 818       | `_import_php` (l.557)    | |
| Blade        | (PHP variant)                | 1853                | Hand-written                     | —              | —                         | ~50 LOC |
| Dart         | (custom)                     | 1900                | Hand-written                     | —              | —                         | ~50 LOC |
| Verilog      | `tree-sitter-verilog`        | 1953                | Hand-written                     | —              | —                         | Module/instance domain |
| SQL          | `tree-sitter-sql` (optional) | 2057                | Hand-written                     | —              | —                         | Schema graph (table/col/fk) |
| Lua          | `tree-sitter-lua`            | 2188                | Generic + `_LUA_CONFIG`          | line 860       | `_import_lua` (l.839)    | |
| Swift        | `tree-sitter-swift`          | 2193                | Generic + `_SWIFT_CONFIG`        | line 916       | `_import_swift` (l.877)  | `inheritance_specifier` → `inherits` |
| Julia        | `tree-sitter-julia`          | 2200                | Hand-written (~240 LOC)          | —              | —                         | |
| Fortran      | `tree-sitter-fortran`        | 2441                | Hand-written (~170 LOC)          | —              | —                         | |
| Go           | `tree-sitter-go`             | 2613                | Hand-written (~220 LOC)          | —              | —                         | Not generic — predates `LanguageConfig` |
| Rust         | `tree-sitter-rust`           | 2834                | Hand-written (~185 LOC)          | —              | —                         | |
| Zig          | `tree-sitter-zig`            | 3019                | Hand-written (~170 LOC)          | —              | —                         | |
| PowerShell   | `tree-sitter-powershell`     | 3189                | Hand-written (~400 LOC)          | —              | —                         | Cmdlet-aware |
| Objective-C  | `tree-sitter-objc`           | 3588                | Hand-written (~200 LOC)          | —              | —                         | |
| Elixir       | `tree-sitter-elixir`         | 3790                | Hand-written (~600 LOC)          | —              | —                         | OTP-aware |

**Pattern observation:** 13 of 26 languages share a single 794-line generic walker (`_extract_generic`, line 933) parametrized by a `LanguageConfig` dataclass. The remaining 13 are hand-written predecessors — clear evolutionary pressure toward the config-driven approach. Newer mainstream languages (Java, C/C++, C#, Kotlin, Scala, PHP, Lua, Swift) all use the generic path; older / weirder languages (Go, Rust, Elixir, PowerShell, Verilog, SQL) remain hand-written.

---

## Architecture (ASCII)

```
                     ┌────────────────────────────────────────────┐
                     │  CLI: graphify .   →   __main__.py         │
                     └────────────────────┬───────────────────────┘
                                          │
        ┌─────────────────┐    ┌──────────▼───────────┐    ┌──────────────────┐
        │  detect.py      │───▶│   extract.py         │───▶│   build.py       │
        │  (file types,   │    │   single 4,421-line  │    │  build_from_json │
        │   shebangs,     │    │   dispatcher;        │    │  → networkx.Graph│
        │   extension     │    │   per-lang extract_* │    │  + build_merge() │
        │   sets)         │    │   → {nodes, edges}   │    │  for incremental │
        └─────────────────┘    └──────────┬───────────┘    └─────────┬────────┘
                                          │ JSON dict                 │ nx.Graph
                                          ▼                           ▼
                               ┌─────────────────────┐    ┌─────────────────────┐
                               │ cache.py            │    │ cluster.py          │
                               │ graphify-out/cache/ │    │ graspologic.leiden  │
                               │   ast/<sha256>.json │    │   (try)             │
                               │   semantic/<sha>.j  │    │ → networkx.louvain  │
                               │ (per-file content   │    │   (fallback)        │
                               │  addressed)         │    │ + cohesion split    │
                               └─────────────────────┘    └─────────┬───────────┘
                                                                    │
                                ┌───────────────────────────────────┼───────────┐
                                ▼                ▼                  ▼           ▼
                          analyze.py       report.py           export.py    serve.py
                          (god nodes,      GRAPH_REPORT.md     graph.html   MCP stdio
                           paths)                              graph.json   (read-only)
                                                               graph.svg
```

**Key architectural facts:**

- **One process, no daemon.** `graphify .` runs end-to-end and exits. The MCP `serve.py` is a *read-only* stdio server that loads `graph.json` once into a NetworkX object (`serve.py::_load_graph` uses `json_graph.node_link_graph`).
- **Communication = plain Python dicts.** `ARCHITECTURE.md` quote: *"plain Python dicts and NetworkX graphs with no shared state."* No IPC, no threads, no async outside the MCP server boundary.
- **Storage = filesystem.** `graphify-out/` (override via `GRAPHIFY_OUT` env) holds the cache and the three artifacts (`graph.html`, `graph.json`, `GRAPH_REPORT.md`). Optional `neo4j` extra exists but is not part of the default path.
- **Incremental updates** happen via `build.py::build_merge()` — load existing graph, merge new chunks, prune deleted source files. **This is a graph-level merge, not a DB-level one** — entire graph is rewritten on save.

---

## Edge Types Emitted (verified by grep)

Extracted via `grep -oE '"relation": "[a-z_]+"'` over the entire `extract.py`:

```
binds_method            calls            contains          defines
dynamic_import          imports          imports_from      includes
listened_by             rationale_for    references_constant
uses                    uses_component   uses_static_prop  bound_to
```

Plus relations injected by hand-rolled extractors not caught by that grep:
`inherits` (Python l.1336–1360, Swift l.1371–1392), `extends`, `implements` (Java l.1427–1448), `case_of` (Swift enum cases l.867), `method` (l.1485–1488).

**What's missing vs cleo nexus T1844:**

| cleo nexus target          | Graphify equivalent                            | Gap |
|----------------------------|------------------------------------------------|-----|
| `DEFINES`                  | `contains` + `defines`                         | Naming only |
| `ACCESSES` (field/var read)| **none** — calls only resolve method names     | ❌ Real gap |
| `METHOD_OVERRIDES`         | conflated with `inherits` on the class         | ❌ Real gap |
| `METHOD_IMPLEMENTS`        | `implements` (Java) but not Swift/Kotlin       | ❌ Inconsistent |
| `IMPORTS`                  | `imports`, `imports_from`, `dynamic_import`    | ✅ More granular than us |
| `CALLS`                    | `calls`                                        | ✅ |

**Conclusion for T1844:** Graphify is **not the right benchmark** for edge completeness. It is missing two of the four edges T1844 is chartered to add. We should build past it, not toward it.

---

## Worth Stealing — 8 specific patterns

Each item below is grounded in a file/line citation from `safishamsi/graphify@v7` (HEAD `ee85bbfb`).

### 1. Config-driven extractor dataclass — **`extract.py:147–192`** (HIGH VALUE, T1840)

The `LanguageConfig` dataclass declares 18 fields per language: `class_types`, `function_types`, `import_types`, `call_types`, `name_field`, `body_field`, `call_accessor_field`, `call_accessor_node_types`, `function_boundary_types`, `import_handler`, `extra_walk_fn`, etc. Each new language is **a 12–20 line declarative block** (see `_PYTHON_CONFIG` at line 677 — 11 lines including blank lines) that drives the 794-line `_extract_generic` walker. **Action:** replicate this in TS as `packages/nexus/src/extractors/language-config.ts`. Filing as task under T1840.

### 2. `import_handler` callback escape hatch — **`extract.py:189`, called in generic walker**

The dataclass exposes `import_handler: Callable | None`, which short-circuits generic import logic when the language has special semantics (relative paths, tsconfig aliases, namespace handling). `_import_js` (line 267) reads `tsconfig.json` path aliases via `_load_tsconfig_aliases()` — non-trivial logic that doesn't belong in a generic walker. **Action:** mirror this pattern with TS function-typed config fields. Avoids the "every language is special, kill the generic" trap.

### 3. `extra_walk_fn` post-pass for language quirks — **`extract.py:191`**

Used by JS for arrow functions (lexical declarations whose value is `arrow_function`, `extract.py:1520–1543`), C# for namespace traversal, Swift for enum cases (`_swift_extra_walk` at line 850–867 emits `case_of` edges). **Action:** this is exactly the hook we need for Swift (T1843) — protocol conformance and extension declarations don't fit the generic class/function model.

### 4. Two-tier confidence labeling on every edge — **README + extract code throughout**

Every edge carries `"confidence": "EXTRACTED"` (deterministic AST), and other code paths emit `"INFERRED"` or `"AMBIGUOUS"`. The cluster/analyze layers can downweight low-confidence edges. **Action:** add `confidence: 'extracted' | 'inferred' | 'ambiguous'` to our edge contract in `packages/contracts/src/`. Not in T1844 today, but should be — proposal to file as sub-task.

### 5. Graspologic Leiden with Louvain fallback + version probing — **`cluster.py:23–54`**

```python
try:
    from graspologic.partition import leiden
    with _suppress_output():       # ANSI escape suppression for PowerShell
        result = leiden(G)
    return result
except ImportError:
    pass

kwargs = {"seed": 42, "threshold": 1e-4}
if "max_level" in inspect.signature(nx.community.louvain_communities).parameters:
    kwargs["max_level"] = 10        # avoids hang on large sparse graphs
communities = nx.community.louvain_communities(G, **kwargs)
```

**Three reusable patterns:** (a) optional native dep with graceful fallback, (b) runtime introspection of dependency API surface to handle version drift, (c) stdout/stderr suppression around chatty native libraries. **Action for cleo nexus:** keep AFL JS Leiden; **don't** add Python+graspologic to the dependency surface. We are TS/Node-only — adding Python runtime would violate our constraint. But the **fallback pattern** itself (try-quality-fail-to-portable) is worth porting to our edge weighting code.

### 6. Content-addressed per-file JSON cache — **`cache.py` (241 LOC)**

```
graphify-out/cache/
  ast/<sha256-of-file-content>.json
  semantic/<sha256>.json
```

Each cache entry is `{nodes: [...], edges: [...]}` for one source file. Markdown files hash body only (excluding YAML frontmatter) so metadata-only changes don't bust cache. **Action:** when our SQLite extractor cache grows, this filesystem fallback is dead simple to add — `~/.cache/cleo-nexus/extract/<sha>.json`. Useful for cross-process parallel extractors that don't want to fight over a single SQLite writer.

### 7. Pipeline as pure function chain — **`ARCHITECTURE.md` quote**

> *"detect() → extract() → build_graph() → cluster() → analyze() → report() → export()"* … *"plain Python dicts and NetworkX graphs with no shared state"*

Every stage is a pure transform of a dict-shaped value. No queues, no ORM, no shared mutable state. **Action:** this is what `packages/nexus/src/pipeline.ts` should look like — keep stages composable & testable in isolation.

### 8. Extract returns `{nodes, edges}` dict literally — **uniform extractor contract**

Every `extract_*` function returns the same shape: `{"nodes": [...], "edges": [...]}`. Even Svelte (line 1740) and SQL (line 2057) hand-written extractors hit this contract. Allows the build stage to be language-agnostic. **Action:** enforce this contract in `packages/contracts/src/nexus/extractor.ts` as the single shape every extractor MUST return. We currently let extractors return slightly different shapes — would help T1840.

---

## Pitfalls — what NOT to copy

1. **Single 4,421-line `extract.py`.** Maintainability is poor; per-language tests live by extension probing. We should split: one TS file per `LanguageConfig`, one shared `generic-walker.ts`. Same pattern, better surface.
2. **Python runtime + graspologic dep.** Hard 3.13 ceiling, native compile, ~250 MB install footprint. Our TS-monorepo constraint forbids this — **AFL JS Leiden stays.** No graspologic adoption, no PyO3 bridge.
3. **Whole-graph rewrite per `build_merge` call.** Graphify regenerates `graph.json` end-to-end — fine at 100k nodes, fatal at 1M. cleo nexus already exceeds 50k relationships (see project notes — 26,606 symbols / 50,335 relationships). **Stay on SQLite + delta updates.**
4. **No `ACCESSES` / `METHOD_OVERRIDES` edges.** T1844 must exceed Graphify's edge surface; do not use them as the ceiling.
5. **MCP `serve.py` re-loads JSON on every startup.** Fine for one-off agent queries, but cleo nexus's interactive use would be slow at scale. Our long-lived gitnexus daemon stays.
6. **No incremental indexing semantics inside the graph store** — Graphify's "incremental" is a graph-level merge of two whole graphs, not a per-symbol patch. We already do better via SQLite MERGE statements.
7. **Optional `neo4j` extra exists but is unused on the main path** — Graphify de facto admits the graph DB isn't worth it for their working set; we should be honest that *our* ~50k-edge graph is also fine in SQLite for now and not over-architect a graph DB layer.

---

## Recommendations for T1840 / T1844

File these as new tasks (sized `medium` unless noted):

1. **T1840-A "LanguageConfig dataclass" (small)** — port Graphify's `LanguageConfig` to `packages/nexus/src/extractors/language-config.ts`. Implement `_extract_generic` equivalent. Migrate Python and TypeScript extractors to use it as proof-of-concept.
2. **T1840-B "Confidence-labeled edges" (small)** — add `confidence: 'extracted' | 'inferred' | 'ambiguous'` to the edge contract. Update existing 4 extractors to emit `extracted` for all current edges. Unblocks future heuristic edges.
3. **T1843-A "Swift extra_walk_fn for protocol conformance" (medium)** — adopt Graphify's `_swift_extra_walk` pattern (`extract.py:850–867`) for Swift's `inheritance_specifier` and extension declarations. Emit `METHOD_IMPLEMENTS` edges that Graphify lacks.
4. **T1844-A "Add ACCESSES edge across all 4 current languages" (medium, exceeds Graphify)** — Graphify has no `accesses`. Spec the edge type, walk `assignment_target` / `member_expression` reads, emit per language. This is a **differentiating feature**, not a parity feature.
5. **T1844-B "Decouple METHOD_OVERRIDES from inherits" (small)** — Graphify conflates these. We split: `inherits` for class hierarchy, `method_overrides` for the specific method-pair link. Clearer semantics for impact analysis.

**Explicitly NOT recommended:** adopting graspologic, switching to NetworkX in-process model, or moving to filesystem-only cache as primary store. Keep AFL JS Leiden, keep SQLite, keep our daemon model.

---

## Sources & citations

- Repo: <https://github.com/safishamsi/graphify>
- Branch: `v7` @ commit `ee85bbfbfd91ec33df3327a7070a29a5b7ec1dc0` (2026-05-04 18:00 UTC)
- Files inspected (raw):
  - `graphify/extract.py` (4,421 lines) — `LanguageConfig:147`, `_extract_generic:933`, all `_*_CONFIG:677-916`, all `extract_*:1726-3790`
  - `graphify/build.py` (262 lines) — `build_from_json`, `build_merge`
  - `graphify/cluster.py` (150 lines) — `_partition:23`, `cluster:62`
  - `graphify/detect.py` (833 lines) — file-type classification, no language-→-grammar map
  - `graphify/cache.py` (241 lines) — content-addressed JSON cache
  - `graphify/serve.py` (488 lines) — MCP stdio read-only server
  - `pyproject.toml` — 26 tree-sitter grammars, optional `graspologic; python_version < '3.13'`
  - `ARCHITECTURE.md` — pipeline shape and "no shared state" doctrine
  - `README.md` — language coverage claims, output artifacts

**Word count:** ~1,950 (target 1,500–2,500 ✓)
