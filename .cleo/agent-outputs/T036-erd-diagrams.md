# T036 — ERD Diagrams

**Epic**: T029 (Schema Architecture Review)
**Date**: 2026-03-21
**Status**: Complete
**Agent**: claude-sonnet-4-6

---

## Summary

Generated Mermaid ERD diagrams for all three CLEO databases from live schema source files. Three output files were created in `docs/architecture/`.

---

## Output Files

| File | Contents |
|------|----------|
| `docs/architecture/erd-tasks-db.md` | Full ERD for tasks.db (25 tables, all FKs annotated) |
| `docs/architecture/erd-brain-db.md` | Full ERD for brain.db (9 tables, cross-DB refs documented) |
| `docs/architecture/erd-combined.md` | Combined architecture overview: all three DBs, cross-DB reference map, cardinality summary, nexus.db standalone ERD |

---

## Databases Covered

### tasks.db — 25 Tables

Organized into six logical clusters:

| Cluster | Tables |
|---------|--------|
| Core task hierarchy | `tasks`, `task_dependencies`, `task_relations`, `sessions`, `task_work_history` |
| Lifecycle pipeline | `lifecycle_pipelines`, `lifecycle_stages`, `lifecycle_gate_results`, `lifecycle_evidence`, `lifecycle_transitions` |
| Manifest/provenance | `manifest_entries`, `pipeline_manifest`, `release_manifests` |
| Architecture decisions | `architecture_decisions`, `adr_task_links`, `adr_relations` |
| Agent runtime | `agent_instances`, `agent_error_log`, `warp_chains`, `warp_chain_instances` |
| Telemetry/governance | `audit_log`, `token_usage`, `external_task_links`, `status_registry`, `schema_meta` |

FK count: 37 hard FKs (Drizzle-declared) + 7 soft FKs (application-enforced or cross-DB).

### brain.db — 9 Tables

| Table | Purpose |
|-------|---------|
| `brain_decisions` | Architectural/technical decision records with cross-DB task context |
| `brain_patterns` | Workflow pattern extraction from task history |
| `brain_learnings` | Actionable insights |
| `brain_observations` | General-purpose observations (claude-mem compatible) |
| `brain_sticky_notes` | Ephemeral quick-capture |
| `brain_memory_links` | Polymorphic cross-reference: brain entities → tasks.db tasks |
| `brain_page_nodes` | Graph nodes (task, doc, file, concept) |
| `brain_page_edges` | Directed edges between graph nodes |
| `brain_schema_meta` | Schema version KV store |

5 cross-DB soft FKs from brain.db → tasks.db documented.

### nexus.db — 3 Tables

| Table | Purpose |
|-------|---------|
| `project_registry` | Global cross-project registry |
| `nexus_audit_log` | Cross-project operation audit |
| `nexus_schema_meta` | Schema version KV store |

No hard FKs within nexus.db (audit log is intentionally soft FK to project_registry for survival on deregistration).

---

## Relationship Cardinality Highlights

- **tasks → tasks** (parent_id): recursive 1:N tree, SET NULL on delete
- **sessions → sessions** (previous/next chain): doubly-linked list, 1:1 opt
- **architecture_decisions → architecture_decisions** (supersedes/amends): 1:N self-ref, SET NULL
- **brain_memory_links**: polymorphic N:1 — `(memory_type, memory_id)` resolves to one of four brain entity tables
- **pipeline_manifest.brain_obs_id**: bidirectional cross-DB reference (tasks.db → brain.db)

---

## Source Files Consulted

- `packages/core/src/store/tasks-schema.ts`
- `packages/core/src/store/brain-schema.ts`
- `packages/core/src/agents/agent-schema.ts`
- `packages/core/src/store/chain-schema.ts`
- `packages/core/src/store/nexus-schema.ts`
- `.cleo/agent-outputs/T030-soft-fk-audit.md` (soft FK inventory)
- `.cleo/agent-outputs/T031-index-analysis.md` (index and query patterns)
