# ADR-006: Canonical SQLite Storage Architecture

**Date**: 2026-02-21
**Status**: accepted
**Supersedes**: ADR-001, ADR-002

## 1. Explicit Decision

All operational data, state machines, relational graphs, and audit logs MUST be stored in a single, unified SQLite database (`.cleo/cleo.db`). 

JSON and JSONL are STRICTLY PROHIBITED for any data that requires concurrent writes, multi-agent access, relational querying, or transactional state transitions. 

JSON is EXCLUSIVELY RESERVED for human-editable, git-tracked configuration files (`config.json`, `project-info.json`).

## 2. Technical Justification & Facts

1. **Concurrency**: Multiple autonomous agents reading and writing JSON/JSONL files simultaneously causes fatal file-lock contention and data corruption. SQLite with WAL (Write-Ahead Logging) provides safe, concurrent multi-agent access.
2. **Relational Integrity**: The pipeline lifecycle (Tasks -> Pipelines -> Stages -> Gates -> Evidence) and task graph (Parents -> Children -> Dependencies) require enforced foreign keys. Application-level enforcement across fragmented JSON files guarantees orphaned records and broken references.
3. **Transactional Safety**: Looping a pipeline stage backward (e.g., Verify -> Implement) requires atomic updates to the stage status, the creation of a transition record, and the logging of an audit event. SQLite guarantees ACID transactions; JSON does not.
4. **Query Performance**: Scanning append-only JSONL files for task history or token usage is O(N) and blocks the event loop. SQLite indexes provide sub-millisecond O(log N) lookups.
5. **Cross-Session Continuity**: Agents require immediate, complete context resumption. Querying a structured database for `active` pipelines and `in_progress` stages is deterministic and instantaneous, unlike parsing scattered directory structures (`.cleo/rcsd/*`).

## 3. Data Classification & Format

| Data Domain | File / Table | Format | Rationale |
|---|---|---|---|
| **Configuration** | `config.json`, `project-info.json` | JSON | Git-tracked, human-editable text files. |
| **Tasks & Hierarchy** | `tasks`, `task_dependencies` | SQLite | Relational graph, highly concurrent writes. |
| **Lifecycle Pipeline** | `lifecycle_pipelines`, `lifecycle_stages` | SQLite | Complex state machine, cross-agent collaboration. |
| **Verification & Evidence** | `lifecycle_gate_results`, `evidence` | SQLite | Tightly coupled to stages; required for stage progression. |
| **Audit & Transitions** | `audit_logs`, `stage_transitions` | SQLite | Transactional event sourcing tied to mutations. |
| **Telemetry & Metrics** | `sessions`, `token_usage`, `compliance` | SQLite | High-volume writes, requires complex aggregations (GROUP BY). |
| **Agent Outputs** | `document_manifest` | SQLite | Relational index mapping files to tasks and agents. |
| **Counters** | `sequences` | SQLite | Replaces `.sequence` file. Provides atomic locking. |

*Note: All existing `.cleo/rcsd/*/_manifest.json`, `todo-log.jsonll`, `TOKEN_USAGE.jsonl`, `MANIFEST.jsonl`, and `.sequence` files are deprecated and MUST be migrated to SQLite.*

## 4. Canonical Database Schema

The following schema defines the definitive structure of `.cleo/cleo.db` via Drizzle ORM:

### 4.1. Core Tasks & Sessions

```sql
CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

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

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('active','suspended','ended')),
  agent_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  current_focus_task_id TEXT REFERENCES tasks(id)
);
```

### 4.2. Lifecycle Pipeline (RCSD -> IVTR)

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
  stage_name TEXT NOT NULL CHECK(stage_name IN ('research', 'consensus', 'spec', 'design', 'implement', 'verify', 'test', 'release')),
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
  triggered_by_session_id TEXT REFERENCES sessions(id),
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

CREATE TABLE lifecycle_evidence (
  id TEXT PRIMARY KEY,
  gate_result_id TEXT NOT NULL REFERENCES lifecycle_gate_results(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,
  uri TEXT NOT NULL, -- File path or external link
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
```

### 4.3. Telemetry, Audit & Manifests

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL, -- 'task', 'pipeline', 'session'
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_state_json TEXT,
  new_state_json TEXT,
  session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL
);

CREATE TABLE token_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id TEXT REFERENCES tasks(id),
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE document_manifest (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  task_id TEXT REFERENCES tasks(id),
  session_id TEXT REFERENCES sessions(id),
  document_type TEXT NOT NULL, -- 'research', 'spec', 'code'
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
```

## 5. Technology Stack

- **Engine**: SQLite via `sql.js` (WASM) to guarantee zero native-binding cross-platform failures.
- **ORM**: `drizzle-orm` for strict TypeScript schema definition, automated migrations (`drizzle-kit`), and type-safe query building.
- **Migration**: A one-time destructive upgrade path will parse existing `todo.json`, `.cleo/rcsd/*`, and `*.jsonl` files into the unified `cleo.db`.
