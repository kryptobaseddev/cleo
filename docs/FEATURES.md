# CLEO Features

> Auto-generated from `docs/FEATURES.json`. Run `npm run features:generate`.

- Inventory Version: `2026.3.8`
- Inventory Updated: `2026-03-02T00:00:00Z`
- Generated At: `2026-03-06T05:54:42.680Z`

## Summary

| Metric | Count |
|---|---:|
| Categories | 6 |
| Features | 22 |
| Shipped | 12 |
| In Progress | 1 |
| Planned | 9 |
| Deprecated | 0 |

## Platform Core

- Category Status: `shipped`

| Feature | Status | Task IDs | Details |
|---|---|---|---|
| Shared-Core Architecture | `shipped` | - | CLI and MCP route through shared business logic in src/core |
| MCP Primary Interface | `shipped` | - | 2 MCP tools across 10 domains and 256 canonical operations |
| CLI Backup Interface | `shipped` | - | 86 commands for human and fallback workflows |

## BRAIN Memory System

- Category Status: `in-progress`

| Feature | Status | Task IDs | Details |
|---|---|---|---|
| brain.db Foundation | `shipped` | - | Decisions, patterns, learnings, observations, memory links, schema metadata |
| 3-Layer Retrieval | `shipped` | - | memory find, memory timeline, memory fetch, plus memory observe |
| SQLite-vec Loader | `shipped` | - | Extension loading and vec0 table initialization with graceful fallback |
| Cognitive Infrastructure Closure | `in-progress` | T5241 | End-to-end parity and closure work across BRAIN and NEXUS epics |
| Embedding Generation Pipeline | `planned` | T5158, T5159 | Embedding generation and vector similarity retrieval as Living BRAIN substrate |
| Reasoning + Session Integration | `planned` | T5153 | Causal/similarity reasoning and richer session memory integration |
| Full claude-mem Retirement | `planned` | T5145 | Native hook-driven automation replacing plugin dependency |

## NEXUS Cross-Project Network

- Category Status: `in-progress`

| Feature | Status | Task IDs | Details |
|---|---|---|---|
| NEXUS Dispatch Domain | `shipped` | - | 12 operations wired in dispatch registry and domain handler |
| JSON Registry Backend | `shipped` | - | Current project registry and permission management implementation |
| Dedicated nexus.db | `planned` | - | Migration target for durable global graph and network storage |

## PageIndex Graph

- Category Status: `in-progress`

| Feature | Status | Task IDs | Details |
|---|---|---|---|
| Graph Table Schema | `shipped` | T5160 | brain_page_nodes and brain_page_edges tables with indexes and migration |
| Graph Traversal API | `planned` | T5161 | BFS/DFS traversal, relation filters, recency and latest-version queries |

## Autonomous Runtime

- Category Status: `planned`

| Feature | Status | Task IDs | Details |
|---|---|---|---|
| Agent-Runtime Foundation | `planned` | T5519, T5573, T5574, T5575 | Foundation service for worker lifecycle, leases, identity, self-propulsion, and patrol motion |
| Live Workshop Surface | `planned` | T5520, T5521, T5524 | The Hearth, Circle of Ten, and Conduit mapped onto the ten canonical domains |
| Quality and Convergence | `planned` | T5525, T5526, T5529 | The Sweep, Refinery, and The Proving for patrol quality, integration readiness, and runtime validation |
| Living BRAIN Runtime | `planned` | T5527, T5528, T5158, T5159 | Looming Engine and Living BRAIN runtime behavior, with T5158/T5159 providing embedding and vector substrate rather than the runtime epic |

## Safety and Validation

- Category Status: `shipped`

| Feature | Status | Task IDs | Details |
|---|---|---|---|
| Four-Layer Anti-Hallucination Validation | `shipped` | - | Schema, semantic, referential, and state-machine enforcement |
| Atomic Write Pattern | `shipped` | - | temp -> validate -> backup -> rename across write paths |
| Append-Only Audit Trail | `shipped` | - | Operation traceability for mutations and lifecycle events |
