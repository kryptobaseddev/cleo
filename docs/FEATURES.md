# CLEO Features

> Auto-generated from `docs/FEATURES.json`. Run `npm run features:generate`.

- Inventory Version: `2026.3.8`
- Inventory Updated: `2026-03-02T00:00:00Z`
- Generated At: `2026-03-02T20:44:01.721Z`

## Summary

| Metric | Count |
|---|---:|
| Categories | 5 |
| Features | 18 |
| Shipped | 12 |
| In Progress | 1 |
| Planned | 5 |
| Deprecated | 0 |

## Platform Core

- Category Status: `shipped`

| Feature | Status | Task IDs | Details |
|---|---|---|---|
| Shared-Core Architecture | `shipped` | - | CLI and MCP route through shared business logic in src/core |
| MCP Primary Interface | `shipped` | - | 2 MCP tools across 10 domains and 201 canonical operations |
| CLI Backup Interface | `shipped` | - | 86 commands for human and fallback workflows |

## BRAIN Memory System

- Category Status: `in-progress`

| Feature | Status | Task IDs | Details |
|---|---|---|---|
| brain.db Foundation | `shipped` | - | Decisions, patterns, learnings, observations, memory links, schema metadata |
| 3-Layer Retrieval | `shipped` | - | memory find, memory timeline, memory fetch, plus memory observe |
| SQLite-vec Loader | `shipped` | - | Extension loading and vec0 table initialization with graceful fallback |
| Cognitive Infrastructure Closure | `in-progress` | T5241 | End-to-end parity and closure work across BRAIN and NEXUS epics |
| Embedding Generation Pipeline | `planned` | T5158, T5159 | Vector generation and semantic KNN retrieval |
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

## Safety and Validation

- Category Status: `shipped`

| Feature | Status | Task IDs | Details |
|---|---|---|---|
| Four-Layer Anti-Hallucination Validation | `shipped` | - | Schema, semantic, referential, and state-machine enforcement |
| Atomic Write Pattern | `shipped` | - | temp -> validate -> backup -> rename across write paths |
| Append-Only Audit Trail | `shipped` | - | Operation traceability for mutations and lifecycle events |
