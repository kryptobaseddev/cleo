# System Validation Report — End-to-End Proof

**Date**: 2026-04-12
**Validator**: CLEO System Validator (Claude Sonnet)
**Task**: T523 — BRAIN Integrity + Cleo Memory SDK Epic
**Installed version**: v2026.4.30
**Source version**: T523 MEGA-SESSION complete (unpublished)

---

## Executive Verdict: PARTIAL

The system delivers a working knowledge graph with real data and real persistence. Most claims are true. However, three specific gaps exist between what the source code promises and what the installed CLI delivers.

---

## Challenge 1: Fragmented Memory — "AI struggles with context across sessions"

**STATUS: PARTIALLY SOLVED**

### What works

- `cleo memory find` — FTS5 search across decisions, patterns, learnings, and observations. Returns results immediately. WORKS.
- `cleo memory search-hybrid` — Hybrid search (FTS5 + vector + graph). Returns results with relevance scoring. WORKS.
- `cleo memory timeline` — Chronological anchor context. Returns neighboring entries. WORKS.
- `cleo memory fetch` — Full entry retrieval by ID. WORKS.
- `cleo memory graph-show` — Returns graph node + edges. WORKS for nodes that exist.
- `cleo memory graph-neighbors` — Graph traversal. WORKS (directional — outbound only from tested node).
- `cleo refresh-memory` — Memory bridge file generation. WORKS.

### What is broken or missing

- `cleo memory graph-stats` — COMMAND DOES NOT EXIST. Returns "Unknown command graph-stats".
- `cleo memory trace` — COMMAND DOES NOT EXIST. Returns "Unknown command trace".
- `cleo memory context` — COMMAND DOES NOT EXIST. Returns "Unknown command context".
- `cleo memory related` — COMMAND DOES NOT EXIST. Returns "Unknown command related".

**Evidence**:
```
cleo memory graph-stats --json
# → Unknown command graph-stats

cleo memory trace "decision:D-mntpeeer" --depth 2 --json
# → Unknown command trace

cleo memory context "decision:D-mntpeeer" --json
# → Unknown command context
```

**Actual graph state**: 282 nodes, 229 edges in brain_page_nodes/brain_page_edges. Data is real and persisted.

**Memory bridge gap**: The `.cleo/memory-bridge.md` file was EMPTY (header only, no content) at the start of this session. Last session ended 2026-04-12 with a note showing "ALL 9 WAVES COMPLETE" but the bridge was blank. Auto-refresh on session end is not reliably working. Manual `cleo refresh-memory` fixes it immediately.

---

## Challenge 2: Lost Context — "Relationships and historical context lost"

**STATUS: PARTIALLY SOLVED**

### What works

The graph has real cross-type edges:
- 109 observation→task edges (applies_to)
- 107 pattern→task edges (derived_from)
- 10 sticky→task edges (applies_to)
- 2 observation→session edges (produced_by)

Graph traversal with `cleo memory graph-neighbors` returns neighbors correctly (outbound direction confirmed working).

`cleo memory decision-find "CLI dispatch"` — Returns empty. This is correct: the stored decision title is "Use CLI-only dispatch for all CLEO operations" and the search does not find it via keyword "CLI dispatch". The FTS index did find it via `cleo memory find "CLI dispatch"` and `cleo memory search-hybrid "CLI dispatch"`.

**Evidence**:
```
cleo memory graph-show "test:validation-001"
# → node found, edges: [{ from: test:validation-001, to: decision:D-mntpeeer, type: references }]

cleo memory graph-neighbors "test:validation-001"
# → neighbors: [decision:D-mntpeeer]

sqlite3 brain.db "SELECT from_id, to_id, edge_type FROM brain_page_edges LIMIT 5"
# → observation:O-mndnelcq-0|task:T191|applies_to
# → pattern:P-03b3aa11|task:T524|derived_from
```

### What is broken

`cleo memory related` does not exist (listed above).

`cleo memory graph-neighbors "decision:D-mntpeeer"` returns empty (0 neighbors) when called on the TARGET node. The node HAS an inbound edge (from test:validation-001 with edgeType "references") but `graph-neighbors` only traverses outbound edges. There is no bidirectional traversal in the CLI.

**Evidence**:
```
cleo memory graph-neighbors "decision:D-mntpeeer" --json
# → {"neighbors":[],"total":0}
# ← Despite having an inbound edge from test:validation-001
```

The existing decision node `D-mntpeeer` has **zero edges** — it was created before the edge infrastructure was built. It is isolated in the graph.

---

## Challenge 3: Static Learning — "Require retraining to incorporate new knowledge"

**STATUS: NOT SOLVED for live sessions (installed v2026.4.30)**

### What works

- `cleo memory observe` stores observations immediately. WORKS.
- `cleo memory decision-store` stores decisions immediately. WORKS.
- Graph nodes can be manually added with `cleo memory graph-add`. WORKS.
- The backfill mechanism (`cleo brain maintenance` + dedicated backfill scripts) created the existing 282 graph nodes. WORKS.
- Quality scoring columns exist on all typed tables (brain_observations, brain_patterns, brain_learnings, brain_decisions). Schema present.

### What is broken

**Auto-population of graph nodes from observe/decision-store does NOT fire in the installed v2026.4.30.**

Root cause confirmed via source code analysis:

1. The source code (`packages/core/src/memory/brain-retrieval.ts`, lines 664-697) calls `upsertGraphNode()` after every `observeBrain()` call. This code is gated on `shouldAutoPopulateGraph()` which checks `brain.autoCapture`.

2. **The installed v2026.4.30 bundle does NOT contain `upsertGraphNode` at all.** The function is absent from `/home/keatonhoskins/.npm-global/lib/node_modules/@cleocode/cleo-os/node_modules/@cleocode/cleo/dist/cli/index.js`.

3. The installed bundle has the OLD brain_page_nodes schema with only 4 node types: `["task", "doc", "file", "concept"]` — NOT the expanded types from T528 (observation, pattern, learning, decision, session, sticky).

4. The installed bundle has the OLD edge types: `["depends_on", "relates_to", "implements", "documents"]` — NOT the new types (applies_to, derived_from, produced_by, references).

5. `brain.autoCapture` was NOT set in config (defaults to false in source, defaults to true in config schema). Setting it to true via `cleo config set brain.autoCapture true` does not help because the installed CLI lacks the code.

**Evidence**:
```bash
# Config set and confirmed:
cleo config set brain.autoCapture true
cat .cleo/config.json | grep -A2 '"brain"'
# → "brain": { "autoCapture": true }

# Observe command:
cleo memory observe "Test auto-populate" --title "Test" --json
# → {"id":"O-mnwf5bw2-0", "createdAt": "2026-04-12 23:52:44"}

# Check graph:
cleo memory graph-show "observation:O-mnwf5bw2-0" --json
# → E_NOT_FOUND: Node 'observation:O-mnwf5bw2-0' not found

# In installed bundle:
grep -c "upsertGraphNode" .npm-global/lib/.../cleo/dist/cli/index.js
# → 0
```

**Quality scoring**: The `quality_score` column exists in all typed tables but ALL values are NULL. Zero observations, patterns, or learnings have been quality-scored.

**Evidence**:
```sql
SELECT COUNT(*), COUNT(quality_score) FROM brain_observations;
# → 47|0  (47 rows, 0 have quality scores)
SELECT COUNT(*), COUNT(quality_score) FROM brain_patterns;
# → 193|0
SELECT COUNT(*), COUNT(quality_score) FROM brain_learnings;
# → 15|0
```

---

## Challenge 4: Code Intelligence — "AI agents miss code, break chains, ship blind"

**STATUS: PARTIALLY SOLVED**

### What works

- **GitNexus** (`npx gitnexus`): index exists with 20,989 nodes, 42,223 edges, 300 execution flows. The `npx gitnexus query "concept" --repo cleocode` and `npx gitnexus context "symbolName" --repo cleocode` commands work and return real data.
- **GitNexus context**: Successfully returns incoming calls, outgoing calls, and process participation for functions like `observeBrain`.
- `cleo map` — Returns full project structure, stack, dependencies, conventions. WORKS.
- `cleo nexus status` — Returns cross-project registry with 18,683 projects. WORKS.

### What is broken

- `cleo nexus analyze` — COMMAND DOES NOT EXIST. The challenge test script references this command but it does not exist in CLEO. The equivalent is `npx gitnexus analyze`.
- `cleo nexus clusters` — COMMAND DOES NOT EXIST. No such subcommand on `cleo nexus`.
- `cleo nexus flows` — COMMAND DOES NOT EXIST. No such subcommand on `cleo nexus`.
- `cleo code outline/search/unfold` — ALL FAIL because tree-sitter is not installed. Error: "tree-sitter is not installed. Code analysis features require tree-sitter grammar packages."
- GitNexus index is **stale** (indexed at commit `fcfa69c`, current commit `2adb78e`). Per CLAUDE.md: "run `npx gitnexus analyze` in terminal first."
- GitNexus requires `--repo cleocode` parameter because multiple repos are indexed (`cleocode`, `gitnexus`, `llmtxt`). Without `--repo`, all commands fail with error.

**Evidence**:
```bash
cleo nexus analyze packages/contracts --json
# → Usage: [no analyze subcommand shown]

cleo code outline /path/to/file.ts
# → Error: tree-sitter is not installed.

npx gitnexus query "memory brain" --repo cleocode
# → Returns real execution flow data with 30+ processes

npx gitnexus context "observeBrain" --repo cleocode
# → Returns 8 incoming callers, outgoing callees, process participation
```

---

## Challenge 5: Continuous Learning / Knowledge Graph

**STATUS: PARTIALLY SOLVED**

### What works

The graph IS interconnected, not flat:
- 229 total edges connecting 282 nodes
- observation→task links (109 edges)
- pattern→task links (107 edges)
- Cross-session links exist

`cleo memory find` and `cleo memory search-hybrid` both work for text-based retrieval.

### What is broken

- The knowledge graph was populated by a **one-time backfill**, not by continuous auto-population during normal operations.
- The 4 observations created in this validation session have NO graph nodes (auto-populate is not working in installed CLI).
- The 1 decision created in this session (`D-mnwf0gmn`) has NO graph node.
- Quality scoring is uniformly NULL — the quality scoring computation exists in source but the installed CLI does not populate quality_score fields.
- `cleo memory decision-find "CLI dispatch"` returns empty (0 results) — decision search uses a different FTS path than `memory find`.

---

## Commands That Work

| Command | Status |
|---------|--------|
| `cleo memory find <query>` | WORKS |
| `cleo memory search-hybrid <query>` | WORKS |
| `cleo memory observe <text>` | WORKS (stores, no graph node) |
| `cleo memory decision-store --decision --rationale` | WORKS (stores, no graph node) |
| `cleo memory timeline <id>` | WORKS |
| `cleo memory fetch <id>` | WORKS |
| `cleo memory graph-show <node-id>` | WORKS |
| `cleo memory graph-neighbors <node-id>` | WORKS (outbound only) |
| `cleo memory graph-add --nodeId --nodeType --label` | WORKS |
| `cleo memory graph-add --from --to --edgeType` | WORKS |
| `cleo memory graph-remove` | UNTESTED |
| `cleo memory reason-why` | UNTESTED |
| `cleo memory reason-similar` | UNTESTED |
| `cleo memory link` | UNTESTED |
| `cleo memory stats` | WORKS (returns patterns/learnings, large output) |
| `cleo refresh-memory` | WORKS |
| `cleo map` | WORKS |
| `cleo nexus status` | WORKS |
| `cleo nexus graph` | WORKS (cross-project dep graph) |
| `npx gitnexus query --repo cleocode` | WORKS (stale index) |
| `npx gitnexus context --repo cleocode` | WORKS (stale index) |

## Commands That Fail

| Command | Failure Mode |
|---------|--------------|
| `cleo memory graph-stats` | Unknown command — not implemented in CLI |
| `cleo memory trace` | Unknown command — not implemented in CLI |
| `cleo memory context` | Unknown command — not implemented in CLI (conflicts with `cleo context`) |
| `cleo memory related` | Unknown command — not implemented in CLI |
| `cleo nexus analyze` | Unknown subcommand — not in cleo nexus |
| `cleo nexus clusters` | Unknown subcommand — not in cleo nexus |
| `cleo nexus flows` | Unknown subcommand — not in cleo nexus |
| `cleo code outline/search/unfold` | tree-sitter not installed |
| `cleo focus set` | Unknown command — replaced by `cleo start <taskId>` |
| `npx gitnexus query` (no --repo) | Fails when multiple repos are indexed |

---

## Critical Gaps Needing Immediate Fixing

### Gap 1: Auto-population not in installed CLI (P0)

The T523 MEGA-SESSION built `upsertGraphNode` into the source, but the published v2026.4.30 npm package does NOT include it. Every `cleo memory observe` and `cleo memory decision-store` call silently fails to create graph nodes.

**Fix**: Publish a new npm package version that includes the T523 code. Run `npx gitnexus analyze` or `cleo brain backfill` after upgrade to backfill any gaps.

### Gap 2: Missing CLI commands for graph traversal (P1)

`cleo memory trace`, `cleo memory context`, `cleo memory related`, and `cleo memory graph-stats` were designed and their LEARNING entries exist in brain.db (L-d7d79b50: "Wave F-1: Brain graph traversal CLI commands"), but they are NOT wired into the installed CLI.

**Fix**: Publish the CLI with these subcommands implemented.

### Gap 3: Quality scoring never populated (P1)

The `quality_score` column exists in all typed tables but ALL values are NULL. The `computeObservationQuality` function exists in source but the installed CLI does not call it.

**Fix**: Include quality scoring in the published build and backfill existing rows.

### Gap 4: Memory bridge auto-refresh unreliable (P2)

The memory bridge was empty at session start despite a session ending on 2026-04-12. `cleo refresh-memory` works manually. The auto-refresh trigger (session end) is not firing reliably.

**Fix**: Debug the session end hook that triggers `refreshMemoryBridge`.

### Gap 5: GitNexus index is stale and requires --repo flag (P2)

The GitNexus index was last analyzed at commit `fcfa69c` (2026-04-10). The current commit is `2adb78e`. The CLAUDE.md warns about this but the stale state means code intelligence results may be inaccurate.

Additionally, all `npx gitnexus` commands fail without `--repo cleocode` when multiple repos are indexed.

**Fix**: Run `npx gitnexus analyze --repo cleocode` to refresh. Update CLAUDE.md to document the `--repo` requirement.

### Gap 6: Schema mismatch between installed CLI and local DB (P1)

The installed CLI has the OLD brain_page_nodes schema (4 node types, 4 edge types). The local DB has the EXPANDED schema (11+ node types, new edge types). The installed CLI's `cleo memory graph-*` commands work because they use raw SQL, not the Drizzle schema enum. But if the CLI tries to write a node with type "observation" through the Drizzle layer, it would fail schema validation.

**Fix**: Ensure the published package matches the DB schema, or remove enum constraints from the Drizzle schema.

---

## What the Owner Needs to Know

1. **The graph is real but was built by backfill, not live auto-population.** 282 nodes and 229 edges exist and are traversable. But every observation, decision, and pattern stored since the MEGA-SESSION completed on 2026-04-12 has NO graph node. The backfill created the initial graph; the installed CLI cannot maintain it.

2. **The installed v2026.4.30 is missing the T523 work.** The MEGA-SESSION completed 29 waves of implementation and marked T523 done, but the installed CLI package was published before those waves were complete. The source at `/mnt/projects/cleocode` has the full implementation; the installed `cleo` binary does not.

3. **Four CLI commands that were designed and even have LEARNING entries in brain.db do not exist**: `memory trace`, `memory context`, `memory related`, `memory graph-stats`.

4. **Quality scoring (a T523 acceptance criterion) has 0% population rate.** The column exists, the code exists, but no values have been written.

5. **The memory-bridge auto-refresh is broken.** Agents loading context at session start will find an empty or stale bridge unless they manually run `cleo refresh-memory`.

6. **GitNexus requires `--repo cleocode` flag** or it errors out. The CLAUDE.md skills do not document this requirement.

7. **`cleo memory decision-find` has lower recall than `cleo memory find`.** The decision-find command returns 0 results for "CLI dispatch" while `memory find` returns the correct decision. Agents using `decision-find` will miss results.

---

*Generated by system validator on 2026-04-12. All findings backed by exact command output.*
