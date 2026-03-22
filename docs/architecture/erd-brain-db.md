# brain.db — Entity Relationship Diagram

**Database**: `.cleo/brain.db`
**Schema source**: `packages/core/src/store/brain-schema.ts`
**Generated**: 2026-03-21
**Epic**: T029 (Schema Architecture Review) / Task: T036

---

## ERD

```mermaid
erDiagram

  %% =========================================================
  %% COGNITIVE CORE
  %% =========================================================

  brain_decisions {
    text id PK
    text type
    text decision
    text rationale
    text confidence
    text outcome
    text alternatives_json
    text context_epic_id
    text context_task_id
    text context_phase
    text created_at
    text updated_at
  }

  brain_patterns {
    text id PK
    text type
    text pattern
    text context
    integer frequency
    real success_rate
    text impact
    text anti_pattern
    text mitigation
    text examples_json
    text extracted_at
    text updated_at
  }

  brain_learnings {
    text id PK
    text insight
    text source
    real confidence
    integer actionable
    text application
    text applicable_types_json
    text created_at
    text updated_at
  }

  brain_observations {
    text id PK
    text type
    text title
    text subtitle
    text narrative
    text facts_json
    text concepts_json
    text project
    text files_read_json
    text files_modified_json
    text source_session_id
    text source_type
    text content_hash
    integer discovery_tokens
    text created_at
    text updated_at
  }

  brain_sticky_notes {
    text id PK
    text content
    text created_at
    text updated_at
    text tags_json
    text status
    text converted_to_json
    text color
    text priority
    text source_type
  }

  %% =========================================================
  %% MEMORY LINKS (cross-reference within brain.db)
  %% =========================================================

  brain_memory_links {
    text memory_type PK
    text memory_id PK
    text task_id PK
    text link_type PK
    text created_at
  }

  %% brain_memory_links links any brain entity (decision/pattern/learning/observation)
  %% to a task in tasks.db via memory_type + memory_id composite reference.
  %% No intra-brain FK — memory_id is a polymorphic ref to one of the four entity tables.

  %% =========================================================
  %% PAGE GRAPH (cross-document linking)
  %% =========================================================

  brain_page_nodes {
    text id PK
    text node_type
    text label
    text metadata_json
    text created_at
  }

  brain_page_edges {
    text from_id PK-FK
    text to_id PK-FK
    text edge_type PK
    real weight
    text created_at
  }

  brain_page_nodes ||--o{ brain_page_edges : "from_id (no DB FK)"
  brain_page_nodes ||--o{ brain_page_edges : "to_id (no DB FK)"

  %% =========================================================
  %% SCHEMA METADATA
  %% =========================================================

  brain_schema_meta {
    text key PK
    text value
  }
```

---

## Cross-Database References (brain.db → tasks.db)

brain.db contains no intra-database foreign keys to tasks.db — SQLite cannot enforce FKs across database connections. All cross-DB references are soft FKs enforced at the application layer.

| Column | References (tasks.db) | Cardinality | Audit ID |
|--------|----------------------|-------------|----------|
| `brain_decisions.context_epic_id` | `tasks.id` (type='epic') | N:1 opt | XFKB-001 |
| `brain_decisions.context_task_id` | `tasks.id` | N:1 opt | XFKB-002 |
| `brain_memory_links.task_id` | `tasks.id` | N:1 required | XFKB-003 |
| `brain_observations.source_session_id` | `sessions.id` | N:1 opt | XFKB-004 |
| `brain_page_nodes.id` (where `node_type='task'`) | `tasks.id` (format `task:<id>`) | 1:1 opt | XFKB-005 |

---

## Table Inventory

| Table | Notes |
|-------|-------|
| `brain_decisions` | Architectural, technical, and process decision records |
| `brain_patterns` | Workflow/blocker/success patterns extracted from task history |
| `brain_learnings` | Actionable insights with confidence scoring |
| `brain_observations` | General observations (replaces claude-mem format) |
| `brain_sticky_notes` | Ephemeral quick-capture notes before formal classification |
| `brain_memory_links` | Polymorphic cross-reference: any brain entity → tasks.db task |
| `brain_page_nodes` | Graph nodes: tasks, docs, files, concepts |
| `brain_page_edges` | Directed edges between graph nodes |
| `brain_schema_meta` | Schema version key-value store |

**Total tables**: 9

---

## Intra-brain Relationships

brain.db has **no hard foreign keys** between its own tables. The only structural link is the page graph:

- `brain_page_edges.from_id` and `brain_page_edges.to_id` reference `brain_page_nodes.id` conceptually but without a DB-level constraint.
- `brain_memory_links` uses a polymorphic pattern: `(memory_type, memory_id)` identifies a row in one of `brain_decisions`, `brain_patterns`, `brain_learnings`, or `brain_observations` depending on the `memory_type` value.

### Memory Link Polymorphism

```
brain_memory_links.memory_type  →  resolved table
─────────────────────────────────────────────────
'decision'                      →  brain_decisions.id
'pattern'                       →  brain_patterns.id
'learning'                      →  brain_learnings.id
'observation'                   →  brain_observations.id
```

This polymorphic join cannot be expressed as a standard FK constraint. Referential integrity is enforced by the application layer only.
