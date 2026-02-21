# ADR-006: Canonical SQLite Storage Architecture

**Date**: 2026-02-21
**Status**: accepted
**Supersedes**: ADR-001, ADR-002

## 1. Explicit Canonical Decision

This ADR defines the 100% complete, definitive, and canonical data storage architecture for all CLEO operations. 

All operational data, state machines, relational graphs, audit logs, and **Architecture Decision Records (ADRs)** MUST be stored in SQLite databases using `drizzle-orm` for strict end-to-end type safety.

JSON and JSONL are STRICTLY PROHIBITED for any data that requires concurrent writes, multi-agent access, relational querying, historical lifecycle tracking, or transactional state transitions. JSON is EXCLUSIVELY RESERVED for human-editable, git-tracked configuration files (`config.json`, `project-info.json`).

There are exactly two SQLite databases in the CLEO ecosystem:
1. **The Global Registry (`~/.cleo/cleo-nexus.db`)**: Manages cross-project Nexus tooling, global token usage, global agent registry, and system-wide configurations.
2. **The Project Store (`<project_root>/.cleo/cleo.db`)**: Manages project-specific tasks, the RCSD->IVTR lifecycle pipeline, architecture decisions (ADRs), and local project evidence.

## 2. Technical Justification & Facts

1. **Concurrency**: Multiple autonomous agents reading and writing JSON/JSONL files simultaneously causes fatal file-lock contention and data corruption. SQLite with WAL (Write-Ahead Logging) provides safe, concurrent multi-agent access.
2. **Relational Integrity**: The pipeline lifecycle (Tasks -> Pipelines -> Stages -> Gates -> Evidence -> ADRs) requires enforced foreign keys. Application-level enforcement across fragmented JSON files guarantees orphaned records and broken references.
3. **Transactional Safety**: Looping a pipeline stage backward (e.g., Verify -> Implement) or superseding an ADR requires atomic updates. SQLite guarantees ACID transactions; JSON does not.
4. **End-to-End Type Safety**: By defining the schema strictly in `src/store/schema.ts` via `drizzle-orm`, TypeScript guarantees compile-time safety across all database interactions, eliminating undefined behaviors present in untyped JSON parsing.
5. **Cross-Session Continuity**: Agents require immediate, complete context resumption. Querying a structured database for `active` pipelines or the `current` accepted ADR is deterministic and instantaneous.

## 3. ADR Lifecycle Tooling (Integrated into RCSD)

ADRs are NOT a separate protocol, but rather a structured artifact produced by the Research -> Consensus -> ADR -> Spec pipeline. They track the outcome of consensus, its status over time, and its supersession chain.

The `architecture_decisions` table provides a lightweight registry tracking decision status, supersession relationships, and links back to the consensus/research that produced them.

| Lifecycle Stage | Status | Definition |
|---|---|---|
| Proposed | `proposed` | Drafted pending consensus review. |
| Accepted | `accepted` | Approved via consensus protocol (with foreign key to consensus report manifest). |
| Superseded | `superseded` | Replaced by a newer decision (with foreign key `superseded_by` to the new ADR). |
| Deprecated | `deprecated` | No longer applicable and not replaced. |

## 4. Canonical Database Schemas

The following Drizzle ORM schemas define the definitive structure of the CLEO data layer.

### 4.1. The Project Store (`.cleo/cleo.db`)

#### Core Tasks & Architecture Decisions

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','active','blocked','done')),
  priority TEXT,
  type TEXT DEFAULT 'task',
  parent_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  updated_at TEXT,
  archived_at TEXT,
  metadata_json TEXT -- Labels, notes, acceptance criteria
);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE architecture_decisions (
  id TEXT PRIMARY KEY, -- e.g., 'ADR-006'
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed', 'accepted', 'superseded', 'deprecated')),
  supersedes_id TEXT REFERENCES architecture_decisions(id),
  superseded_by_id TEXT REFERENCES architecture_decisions(id),
  consensus_manifest_id TEXT, -- Foreign key to the consensus report that validated this
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
```

#### Lifecycle Pipeline (RC-ADR-SD -> IVTR)

```sql
CREATE TABLE lifecycle_pipelines (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'suspended', 'failed')),
  current_stage TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE lifecycle_stages (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES lifecycle_pipelines(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL CHECK(stage_name IN ('research', 'consensus', 'adr', 'spec', 'decompose', 'implement', 'verify', 'test', 'release')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked', 'skipped')),
  started_at TEXT,
  completed_at TEXT,
  agent_id TEXT REFERENCES sessions(id)
);

CREATE TABLE lifecycle_transitions (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES lifecycle_pipelines(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE lifecycle_gate_results (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES lifecycle_stages(id) ON DELETE CASCADE,
  gate_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass', 'fail', 'warn')),
  message TEXT,
  created_at TEXT NOT NULL
);
```

### 4.2. The Global Registry (`~/.cleo/cleo-nexus.db`)

```sql
CREATE TABLE global_sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','suspended','ended')),
  agent_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE global_token_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES global_sessions(id),
  project_path TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE project_registry (
  project_path TEXT PRIMARY KEY,
  registered_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL
);
```

## 5. Technology Stack

- **Engine**: SQLite via `sql.js` (WASM) to guarantee zero native-binding cross-platform failures.
- **ORM**: `drizzle-orm` for strict TypeScript schema definition, automated migrations, and type-safe query building.
