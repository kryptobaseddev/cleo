# gitnexus Surface Audit

**Version**: 1.5.3
**Package**: `gitnexus` (npm)
**Author**: Abhigyan Patwari
**License**: PolyForm Noncommercial 1.0.0
**Audited by**: T1043 Explorer
**Date**: 2026-04-20

---

## CLI Surface

All subcommands from `gitnexus --help`:

| Command | Description | Key Flags |
|---------|-------------|-----------|
| `setup` | One-time MCP config for Cursor, Claude Code, OpenCode, Codex | none |
| `analyze [path]` | Full repo index (parses + builds graph) | `--force`, `--embeddings`, `--skills`, `--skip-agents-md`, `--skip-git`, `--verbose` |
| `index [path...]` | Register existing `.gitnexus/` without re-analysis | `--force`, `--allow-non-git` |
| `serve` | Local HTTP API server for web UI | `--port 4747`, `--host`, `--ui` |
| `serve-local` | Local HTTP + bundled web UI | `--port 4747`, `--host` |
| `mcp` | Start MCP server (stdio transport) | none |
| `list` | List all indexed repos from global registry | none |
| `status` | Show index status for current repo | none |
| `clean` | Delete `.gitnexus/` index for current repo | `--force`, `--all` |
| `wiki [path]` | Generate repo wiki from knowledge graph (LLM-driven) | `--force`, `--provider openai/cursor`, `--model`, `--base-url`, `--api-key`, `--concurrency 3`, `--gist`, `--verbose`, `--review` |
| `augment <pattern>` | Enrich a search pattern with graph context (used by hooks) | none |
| `query <search_query>` | Semantic/keyword search for execution flows | `--repo`, `--context`, `--goal`, `--limit 5`, `--content` |
| `context [name]` | 360-degree view of a symbol | `--repo`, `--uid`, `--file`, `--content` |
| `impact <target>` | Blast-radius analysis | `--direction upstream/downstream`, `--repo`, `--depth 3`, `--include-tests` |
| `cypher <query>` | Raw Cypher query against the graph | `--repo` |
| `eval-server` | Lightweight HTTP server for eval (SWE-bench) | `--port 4848`, `--idle-timeout` |
| `group` | Manage cross-repo groups | subcommands below |

### `group` subcommands

| Subcommand | Description |
|------------|-------------|
| `group create <name>` | Create group with template `group.yaml` |
| `group add <group> <path> <registry>` | Add repo to group with hierarchy path |
| `group remove <group> <path>` | Remove repo from group |
| `group list [name]` | List all groups or details of one |
| `group status <name>` | Check index staleness for group repos |
| `group sync <name>` | Build Contract Registry (cross-repo links) |
| `group query <name> <query>` | Hybrid search across all repos in group |
| `group contracts <name>` | Inspect Contract Registry |

---

## Storage Engine and Schema

### File Layout

After `gitnexus analyze`:

```
<repo-root>/
  .gitnexus/
    meta.json          # RepoMeta: repoPath, lastCommit, indexedAt, stats
    lbug/              # LadybugDB native database (property graph)
    wiki/              # Generated wiki .md files + overview.md + module_tree.json
```

```
~/.gitnexus/
  registry.json        # RegistryEntry[]: name, path, storagePath, indexedAt, lastCommit, stats
  config.json          # CLIConfig: apiKey, model, baseUrl, provider, isReasoningModel
  groups/              # Group definitions (group.yaml, contracts.json)
```

### Database Engine

**LadybugDB** (`@ladybugdb/core` v0.15.2) — an in-process property graph database with:
- A native Node.js addon (`lbugjs.node`) — NOT Neo4j, NOT DuckDB, NOT SQLite
- Cypher query language (Kuzu-compatible syntax — gitnexus migrated FROM KuzuDB to LadybugDB)
- HNSW vector index for semantic search (cosine similarity, default 384 dims — `snowflake-arctic-embed-xs`)
- Full-text search (FTS/BM25) via a separate FTS extension
- Connection pool: one `Database`, up to 8 `Connection` objects per repo; idle timeout 5 min

Old `.gitnexus/kuzu` directories are auto-cleaned during `analyze` with a `needsReindex` flag.

### Schema

All nodes stored in **separate typed tables**; all relationships stored in a **single `CodeRelation` table** with a `type` string property (not typed edge tables). This is intentional to allow LLM-writable Cypher without needing to know every FROM/TO pair.

**Node tables**:

| Table | Key Properties |
|-------|----------------|
| `File` | id, name, filePath, content |
| `Folder` | id, name, filePath |
| `Function` | id, name, filePath, startLine, endLine, isExported, content, description |
| `Class` | id, name, filePath, startLine, endLine, isExported, content, description |
| `Interface` | same as Class |
| `Method` | + parameterCount, returnType |
| `CodeElement` | generic fallback |
| `Community` | id, label, heuristicLabel, keywords[], description, enrichedBy, cohesion, symbolCount |
| `Process` | id, label, heuristicLabel, processType, stepCount, communities[], entryPointId, terminalId |
| `Route` | id, name, filePath, responseKeys[], errorKeys[], middleware[] |
| `Tool` | id, name, filePath, description |
| `Section` | id, name, filePath, startLine, endLine, level, content, description |
| Multi-lang | `Struct`, `Enum`, `Macro`, `Typedef`, `Union`, `Namespace`, `Trait`, `Impl`, `TypeAlias`, `Const`, `Static`, `Property`, `Record`, `Delegate`, `Annotation`, `Constructor`, `Template`, `Module` |
| `Embedding` | nodeId, embedding FLOAT[384] (HNSW-indexed) |

**Relationship table** (`CodeRelation`):

```cypher
(src)-[:CodeRelation {type: 'CALLS', confidence: DOUBLE, reason: STRING, step: INT32}]->(dst)
```

Edge types: `CONTAINS`, `CALLS`, `INHERITS`, `METHOD_OVERRIDES`, `METHOD_IMPLEMENTS`, `IMPORTS`, `USES`, `DEFINES`, `DECORATES`, `IMPLEMENTS`, `EXTENDS`, `HAS_METHOD`, `HAS_PROPERTY`, `ACCESSES`, `MEMBER_OF`, `STEP_IN_PROCESS`, `HANDLES_ROUTE`, `FETCHES`, `HANDLES_TOOL`, `ENTRY_POINT_OF`, `WRAPS`, `QUERIES`

**Supported languages**: JavaScript, TypeScript, Python, Java, C, C++, C#, Go, Ruby, Rust, PHP, Kotlin, Swift, Dart, Vue (SFC), COBOL (regex-only)

---

## Query Primitives

### `cypher <query>`

Direct Cypher query against LadybugDB. Returns `{markdown, row_count}`. Not Neo4j — uses LadybugDB's Cypher dialect (Kuzu-compatible). All edges filter via `{type: 'EDGE_TYPE'}` property on `CodeRelation`.

Example:
```cypher
MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b:Function {name: "validateUser"}) RETURN a.name, a.filePath
```

### `query <search_query>`

Hybrid semantic + keyword search returning **execution flows** (Process nodes), not raw symbol lists.

Pipeline:
1. BM25 keyword search over FTS index (file-level)
2. Semantic embedding search via HNSW vector index (when `--embeddings` was enabled during `analyze`)
3. Results merged with **Reciprocal Rank Fusion** (RRF, k=60) — the same algorithm as Elasticsearch/Pinecone
4. Top process nodes returned with their STEP_IN_PROCESS member symbols

Options: `--limit 5`, `--context <task-description>`, `--goal <what-to-find>`, `--content` (include source)

### `context [name]`

360-degree symbol view via a set of Cypher lookups:
- Incoming refs: CALLS, IMPORTS, EXTENDS, IMPLEMENTS, METHOD_OVERRIDES, DECORATES, HAS_METHOD, HAS_PROPERTY, ACCESSES (read/write tagged)
- Outgoing refs: same edge types in reverse
- Process participation: STEP_IN_PROCESS edges to Process nodes
- Handles disambiguation — returns candidate list if multiple symbols share the same name

Can be addressed by `--uid` (zero-ambiguity) from prior results.

### `impact <target>`

Blast-radius BFS traversal:
- **Direction**: `upstream` (what depends on this — "will break") or `downstream` (what this depends on)
- **Default edge types**: CALLS, IMPORTS, EXTENDS, IMPLEMENTS (ACCESSES excluded by default)
- **Max depth**: 3 (configurable via `--depth`)
- **Algorithm**: iterative BFS with a `visited` set; one batched Cypher query per depth level using `WHERE n.id IN [...]`
- **Confidence**: uses stored edge confidence; falls back to per-type floor (e.g. CALLS=1.0, IMPORTS=0.9)
- **Java/JVM fix**: Class/Interface nodes seed the BFS frontier with their Constructor nodes and owning File node to correctly traverse JVM-style edge topology
- Output grouped by depth: d=1 "WILL BREAK", d=2 "LIKELY AFFECTED", d=3 "MAY NEED TESTING"
- Risk levels: LOW / MEDIUM / HIGH / CRITICAL based on affected count and process coverage

### `augment <pattern>`

Lightweight BM25-only enrichment (no embeddings). Used by hooks to provide graph context alongside Grep/Glob/Bash calls.

Pipeline:
1. BM25 search for pattern (top 5 file hits)
2. Symbol lookup in those files via Cypher
3. Batch-fetch callers, callees, process participation, and community cohesion
4. Rank by cohesion (internal signal, not exposed)
5. Output formatted text block to **stderr** (not stdout — LadybugDB captures stdout at OS level during init)

Performance target: <500ms cold start, <200ms warm.

---

## Integration Surface

### MCP Server (`gitnexus mcp`)

Runs on stdio transport. Serves **all indexed repos** from `~/.gitnexus/registry.json`.

**MCP Tools** (15 total):

| Tool | Description |
|------|-------------|
| `list_repos` | Discover all indexed repos with stats |
| `query` | Hybrid search — returns process-grouped execution flows |
| `cypher` | Raw Cypher query |
| `context` | 360-degree symbol view |
| `detect_changes` | Git-diff impact (maps changed lines → processes) |
| `rename` | Multi-file coordinated rename (graph + text search, confidence-tagged) |
| `impact` | Blast radius BFS |
| `route_map` | API route → handler → consumer mapping |
| `tool_map` | MCP/RPC tool definitions in the codebase |
| `shape_check` | Route response shape vs consumer property access mismatch detection |
| `api_impact` | Pre-change report combining route_map + shape_check + impact |
| `group_list` | List configured cross-repo groups |
| `group_sync` | Rebuild Contract Registry for a group |
| `group_contracts` | Inspect Contract Registry cross-links |
| `group_query` | Hybrid search across all repos in a group (RRF merged) |
| `group_status` | Index staleness per repo in group |

**MCP Resources** (URI templates):

| URI | Content |
|-----|---------|
| `gitnexus://repos` | All indexed repos list (YAML) |
| `gitnexus://setup` | AGENTS.md content for all repos |
| `gitnexus://repo/{name}/context` | Stats, staleness, available tools |
| `gitnexus://repo/{name}/clusters` | All Leiden communities |
| `gitnexus://repo/{name}/cluster/{name}` | Community detail |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{name}` | Step-by-step process trace |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher queries |

**MCP Prompts** (2):
- `detect_impact` — guided pre-commit change analysis workflow
- `generate_map` — architecture documentation with Mermaid diagrams

### Eval Server (`gitnexus eval-server`)

Lightweight HTTP server (default port 4848) designed for SWE-bench evaluation inside Docker.

- Keeps LadybugDB warm in memory — near-instant tool calls
- Endpoint: `POST /tool/:name` — accepts JSON args, returns **LLM-friendly text** (not raw JSON)
- Supported tools: `query`, `context`, `impact`, `cypher`, `detect_changes`, `list_repos`
- Output includes "Next step hints" to guide tool-chaining (query → context → impact → fix)
- Health: `GET /health` → `{status: "ok", repos: [...]}`
- Shutdown: `POST /shutdown`
- Signals ready via `GITNEXUS_EVAL_SERVER_READY:<port>` on fd 1
- `--idle-timeout <seconds>` for auto-shutdown

### Hook Augmentation (`hooks/claude/`)

Three hook files for Claude Code:

1. **`gitnexus-hook.cjs`** (PreToolUse + PostToolUse):
   - PreToolUse: intercepts `Grep`, `Glob`, and `Bash` (grep/rg) tool calls
   - Extracts search pattern, calls `gitnexus augment <pattern>`, injects result as `additionalContext`
   - PostToolUse: detects stale index after git mutations (commit, merge, rebase, pull) and notifies agent to re-index
   - Written as CJS to avoid ESM/native module stdout-capture issues

2. **`pre-tool-use.sh`** (POSIX shell fallback):
   - Equivalent logic to gitnexus-hook.cjs but in bash
   - Walks up 5 directory levels to detect `.gitnexus/` presence before augmenting

3. **`session-start.sh`**:
   - Fires on session startup
   - Injects a brief context block into Claude's context describing available MCP tools
   - Note: broken on Windows (Claude Code bug) — session context is injected via CLAUDE.md/skills instead

`gitnexus analyze` automatically installs hooks into `~/.claude/` and writes a `[gitnexus]` section into `AGENTS.md`/`CLAUDE.md` at the repo root. The `--skip-agents-md` flag suppresses this.

---

## Wiki Generator

`gitnexus wiki [path]` generates an LLM-authored documentation wiki from the knowledge graph.

### Pipeline

Phase 0: Validate prerequisites (index exists, LLM config present)
Phase 1: **Module grouping** — one LLM call with all file+symbol data to produce a `module_tree.json` (hierarchical module structure). `--review` flag pauses here for user inspection.
Phase 2: **Module pages** — one LLM call per module (bottom-up), parallelized (`--concurrency 3`). Each page receives: file list, exported symbols, intra-module call edges, inter-module call edges, process participation.
Phase 3: **Overview page** — one LLM call with inter-module edges summary.

### Output Location

All files written to `.gitnexus/wiki/`:
```
.gitnexus/wiki/
  overview.md          # Top-level architecture summary
  <module-slug>.md     # One page per detected module
  module_tree.json     # Editable module grouping (preserved for incremental re-gen)
  first_module_tree.json  # Snapshot of original grouping
  index.html           # Browsable HTML viewer (generated alongside .md files)
```

Incremental updates: git diff maps changed files → affected modules → only those modules are regenerated.

### LLM Support

- `--provider openai` (default): OpenAI-compatible API (OpenRouter, Azure, custom base URL)
- `--provider cursor`: Uses Cursor's built-in LLM (no API key needed, tunneled through Cursor CLI)
- Default model: `minimax/minimax-m2.5`
- `--reasoning-model` flag: strips `temperature`, uses `max_completion_tokens` (for o1/o3/o4-mini)
- `--gist`: publishes wiki as a public GitHub Gist after generation

### Graph Queries Used

- `MATCH (f:File)-[:CodeRelation {type: 'DEFINES'}]->(n) WHERE n.isExported = true` — file exports
- Intra-module CALLS edges grouped by source/target file
- Inter-module CALLS edges for cross-boundary connections
- Process participation via STEP_IN_PROCESS

### Skill Generation

`analyze --skills` generates `SKILL.md` files per detected Leiden community in `.gitnexus/skills/`. Each skill describes one functional area: key files, entry points, execution flows, cross-community connections. These are injected into AGENTS.md/CLAUDE.md for agent context.

---

## Cross-Index (group)

### Purpose

Groups allow cross-repo impact analysis by building a **Contract Registry** that links API contracts (HTTP routes, gRPC, message topics, shared libs) across multiple indexed repositories.

### Storage

Groups stored in `~/.gitnexus/groups/<name>/`:
```
group.yaml           # GroupConfig: repos map, manifest links, detect/matching config
contracts.json       # ContractRegistry: extracted contracts + cross-links
```

### GroupConfig structure

```yaml
version: 1
name: my-group
repos:
  services/auth: auth-service-registry-name
  services/api: api-gateway-registry-name
links:
  - from: services/auth
    to: services/api
    type: http
    contract: POST /api/auth/login
    role: provider
detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: false
matching:
  bm25_threshold: 0.5
  embedding_threshold: 0.85
  max_candidates_per_step: 20
```

### Contract Registry (`group sync`)

`gitnexus group sync <name>` builds `contracts.json`:

1. For each repo in the group, extracts contracts:
   - `HttpRouteExtractor`: finds Route nodes → HTTP contracts
   - `GrpcExtractor`: finds gRPC service definitions
   - `TopicExtractor`: finds message topic publish/subscribe
2. Runs cross-matching cascade:
   - Exact match (route path strings)
   - Manifest links (explicit `links:` in group.yaml)
   - BM25 match (configurable threshold)
   - Embedding match (if `embedding_fallback: true`)
3. Writes `crossLinks[]` with `matchType` (exact/manifest/bm25/embedding) and `confidence`

### Cross-Repo Impact (group query)

`gitnexus group query <name> <query>` runs the `query` tool in each member repo independently, then merges results via RRF.

The MCP `group_query` tool does the same: per-repo hybrid search, RRF merge across repos.

---

## Strengths Observed

1. **LadybugDB + single CodeRelation table**: the decision to use one polymorphic edge table with a `type` property (rather than typed edge tables) makes Cypher queries written by LLMs significantly simpler — no need to know the exact FROM/TO type combination, just filter on `{type: 'CALLS'}`.

2. **Execution Flow (Process) abstraction**: gitnexus does not just return raw symbol hits — it pre-computes execution flows (entry-point → terminal call chains), ranks results as Process nodes, and returns symbols grouped by flow. This is architecturally superior for agent task understanding vs. raw file/symbol search.

3. **Hook-based passive augmentation**: the `PreToolUse` hook transparently enriches every Grep/Glob/Bash call with caller/callee/flow context without requiring the agent to call an explicit tool. This is zero-friction codebase awareness injection.

4. **BFS impact with confidence floors**: the impact BFS uses per-relation-type confidence floors (CALLS=1.0, IMPORTS=0.9) plus stored edge confidence, and groups results by depth (d=1/2/3) with human-readable risk labels. The JVM class/constructor seed expansion is a concrete correctness fix rather than a heuristic.

5. **Route + Tool schema nodes**: first-class `Route` and `Tool` node tables capture API endpoint structure (responseKeys, middleware) and MCP tool definitions directly in the graph, enabling `route_map`, `shape_check`, `api_impact`, and `tool_map` — capabilities absent from most code-intelligence tools.

6. **Cross-repo Contract Registry**: the `group sync` mechanism extracts HTTP/gRPC/topic contracts from each repo's graph and cross-links them with a cascade matching strategy (exact → manifest → BM25 → embedding), enabling true multi-repo blast-radius analysis — a capability not provided by single-repo graph tools.

7. **eval-server for SWE-bench/agent evaluation**: the lightweight HTTP server with LLM-friendly text formatters and next-step hints is explicitly designed for agent evaluation harnesses, making gitnexus a drop-in intelligence layer for automated benchmarks without MCP overhead.
