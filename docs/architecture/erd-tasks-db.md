# tasks.db — Entity Relationship Diagram

**Database**: `.cleo/tasks.db`
**Schema source**: `packages/core/src/store/tasks-schema.ts`, `packages/core/src/agents/agent-schema.ts`, `packages/core/src/store/chain-schema.ts`
**Generated**: 2026-03-21
**Epic**: T029 (Schema Architecture Review) / Task: T036

---

## ERD

```mermaid
erDiagram

  %% =========================================================
  %% CORE TASK HIERARCHY
  %% =========================================================

  tasks {
    text id PK
    text title
    text description
    text status
    text priority
    text type
    text parent_id FK
    text phase
    text size
    integer position
    integer position_version
    text labels_json
    text notes_json
    text acceptance_json
    text files_json
    text origin
    text blocked_by
    text epic_lifecycle
    integer no_auto_complete
    text created_at
    text updated_at
    text completed_at
    text cancelled_at
    text cancellation_reason
    text archived_at
    text archive_reason
    integer cycle_time_days
    text verification_json
    text created_by
    text modified_by
    text session_id FK
    text pipeline_stage
  }

  tasks ||--o{ tasks : "parent_id (SET NULL)"

  sessions {
    text id PK
    text name
    text status
    text scope_json
    text current_task FK
    text task_started_at
    text agent
    text notes_json
    text tasks_completed_json
    text tasks_created_json
    text handoff_json
    text started_at
    text ended_at
    text previous_session_id FK
    text next_session_id FK
    text agent_identifier
    text handoff_consumed_at
    text handoff_consumed_by
    text debrief_json
    text provider_id
    text stats_json
    integer resume_count
    integer grade_mode
  }

  sessions ||--o{ sessions : "previous_session_id / next_session_id (SET NULL)"
  sessions }o--o| tasks : "current_task (SET NULL)"
  tasks }o--o| sessions : "session_id (SET NULL)"

  %% =========================================================
  %% TASK RELATIONSHIPS
  %% =========================================================

  task_dependencies {
    text task_id PK-FK
    text depends_on PK-FK
  }

  task_relations {
    text task_id PK-FK
    text related_to PK-FK
    text relation_type
    text reason
  }

  task_work_history {
    integer id PK
    text session_id FK
    text task_id FK
    text set_at
    text cleared_at
  }

  tasks ||--o{ task_dependencies : "task_id (CASCADE)"
  tasks ||--o{ task_dependencies : "depends_on (CASCADE)"
  tasks ||--o{ task_relations : "task_id (CASCADE)"
  tasks ||--o{ task_relations : "related_to (CASCADE)"
  sessions ||--o{ task_work_history : "session_id (CASCADE)"
  tasks ||--o{ task_work_history : "task_id (CASCADE)"

  %% =========================================================
  %% LIFECYCLE PIPELINE
  %% =========================================================

  lifecycle_pipelines {
    text id PK
    text task_id FK
    text status
    text current_stage_id
    text started_at
    text completed_at
    text updated_at
    integer version
  }

  lifecycle_stages {
    text id PK
    text pipeline_id FK
    text stage_name
    text status
    integer sequence
    text started_at
    text completed_at
    text blocked_at
    text block_reason
    text skipped_at
    text skip_reason
    text notes_json
    text metadata_json
    text output_file
    text created_by
    text validated_by
    text validated_at
    text validation_status
    text provenance_chain_json
  }

  lifecycle_gate_results {
    text id PK
    text stage_id FK
    text gate_name
    text result
    text checked_at
    text checked_by
    text details
    text reason
  }

  lifecycle_evidence {
    text id PK
    text stage_id FK
    text uri
    text type
    text recorded_at
    text recorded_by
    text description
  }

  lifecycle_transitions {
    text id PK
    text pipeline_id FK
    text from_stage_id FK
    text to_stage_id FK
    text transition_type
    text transitioned_by
    text created_at
  }

  tasks ||--o{ lifecycle_pipelines : "task_id (CASCADE)"
  lifecycle_pipelines ||--o{ lifecycle_stages : "pipeline_id (CASCADE)"
  lifecycle_stages ||--o{ lifecycle_gate_results : "stage_id (CASCADE)"
  lifecycle_stages ||--o{ lifecycle_evidence : "stage_id (CASCADE)"
  lifecycle_pipelines ||--o{ lifecycle_transitions : "pipeline_id (CASCADE)"
  lifecycle_stages ||--o{ lifecycle_transitions : "from_stage_id (CASCADE)"
  lifecycle_stages ||--o{ lifecycle_transitions : "to_stage_id (CASCADE)"

  %% =========================================================
  %% MANIFEST / PROVENANCE
  %% =========================================================

  manifest_entries {
    text id PK
    text pipeline_id FK
    text stage_id FK
    text title
    text date
    text status
    text agent_type
    text output_file
    text topics_json
    text findings_json
    text linked_tasks_json
    text created_by
    text created_at
  }

  pipeline_manifest {
    text id PK
    text session_id FK
    text task_id FK
    text epic_id FK
    text type
    text content
    text content_hash
    text status
    integer distilled
    text brain_obs_id
    text source_file
    text metadata_json
    text created_at
    text archived_at
  }

  release_manifests {
    text id PK
    text version
    text status
    text pipeline_id FK
    text epic_id FK
    text tasks_json
    text changelog
    text notes
    text previous_version
    text commit_sha
    text git_tag
    text npm_dist_tag
    text created_at
    text prepared_at
    text committed_at
    text tagged_at
    text pushed_at
  }

  lifecycle_pipelines ||--o{ manifest_entries : "pipeline_id (CASCADE)"
  lifecycle_stages ||--o{ manifest_entries : "stage_id (CASCADE)"
  sessions }o--o{ pipeline_manifest : "session_id (SET NULL)"
  tasks }o--o{ pipeline_manifest : "task_id (SET NULL)"
  tasks }o--o{ pipeline_manifest : "epic_id (SET NULL)"
  lifecycle_pipelines }o--o| release_manifests : "pipeline_id (SET NULL)"
  tasks }o--o| release_manifests : "epic_id (SET NULL)"

  %% =========================================================
  %% ARCHITECTURE DECISIONS (ADR)
  %% =========================================================

  architecture_decisions {
    text id PK
    text title
    text status
    text supersedes_id FK
    text superseded_by_id FK
    text consensus_manifest_id FK
    text content
    text created_at
    text updated_at
    text date
    text accepted_at
    text gate
    text gate_status
    text amends_id FK
    text file_path
    text summary
    text keywords
    text topics
  }

  adr_task_links {
    text adr_id PK-FK
    text task_id PK-FK
    text link_type
  }

  adr_relations {
    text from_adr_id PK-FK
    text to_adr_id PK-FK
    text relation_type PK
  }

  architecture_decisions ||--o{ architecture_decisions : "supersedes_id / superseded_by_id / amends_id (SET NULL)"
  manifest_entries }o--o| architecture_decisions : "consensus_manifest_id (SET NULL)"
  architecture_decisions ||--o{ adr_task_links : "adr_id (CASCADE)"
  tasks ||--o{ adr_task_links : "task_id (CASCADE)"
  architecture_decisions ||--o{ adr_relations : "from_adr_id (CASCADE)"
  architecture_decisions ||--o{ adr_relations : "to_adr_id (CASCADE)"

  %% =========================================================
  %% AGENT INSTANCES
  %% =========================================================

  agent_instances {
    text id PK
    text agent_type
    text status
    text session_id
    text task_id
    text started_at
    text last_heartbeat
    text stopped_at
    integer error_count
    integer total_tasks_completed
    text capacity
    text metadata_json
    text parent_agent_id
  }

  agent_error_log {
    integer id PK
    text agent_id
    text error_type
    text message
    text stack
    text occurred_at
    integer resolved
  }

  sessions }o--o{ agent_instances : "session_id (soft FK SET NULL)"
  tasks }o--o{ agent_instances : "task_id (soft FK SET NULL)"
  agent_instances ||--o{ agent_instances : "parent_agent_id (soft FK SET NULL)"
  agent_instances ||--o{ agent_error_log : "agent_id (soft FK CASCADE)"

  %% =========================================================
  %% WARP CHAINS
  %% =========================================================

  warp_chains {
    text id PK
    text name
    text version
    text description
    text definition
    integer validated
    text created_at
    text updated_at
  }

  warp_chain_instances {
    text id PK
    text chain_id FK
    text epic_id
    text variables
    text stage_to_task
    text status
    text current_stage
    text gate_results
    text created_at
    text updated_at
  }

  warp_chains ||--o{ warp_chain_instances : "chain_id (CASCADE)"
  tasks }o--o{ warp_chain_instances : "epic_id (soft FK CASCADE)"

  %% =========================================================
  %% TELEMETRY
  %% =========================================================

  audit_log {
    text id PK
    text timestamp
    text action
    text task_id
    text actor
    text details_json
    text before_json
    text after_json
    text domain
    text operation
    text session_id
    text request_id
    integer duration_ms
    integer success
    text source
    text gateway
    text error_message
    text project_hash
  }

  token_usage {
    text id PK
    text created_at
    text provider
    text model
    text transport
    text gateway
    text domain
    text operation
    text session_id FK
    text task_id FK
    text request_id
    integer input_chars
    integer output_chars
    integer input_tokens
    integer output_tokens
    integer total_tokens
    text method
    text confidence
    text request_hash
    text response_hash
    text metadata_json
  }

  sessions }o--o{ token_usage : "session_id (SET NULL)"
  tasks }o--o{ token_usage : "task_id (SET NULL)"

  %% audit_log.task_id is intentionally a soft FK (no constraint)
  %% — log entries survive task deletion (sentinel value 'system' used for non-task ops)

  %% =========================================================
  %% EXTERNAL INTEGRATIONS
  %% =========================================================

  external_task_links {
    text id PK
    text task_id FK
    text provider_id
    text external_id
    text external_url
    text external_title
    text link_type
    text sync_direction
    text metadata_json
    text linked_at
    text last_sync_at
  }

  tasks ||--o{ external_task_links : "task_id (CASCADE)"

  %% =========================================================
  %% GOVERNANCE
  %% =========================================================

  status_registry {
    text name PK
    text entity_type PK
    text namespace
    text description
    integer is_terminal
  }

  schema_meta {
    text key PK
    text value
  }
```

---

## Table Inventory

| Table | Rows (live) | Notes |
|-------|-------------|-------|
| `tasks` | — | Core entity; self-referential via `parent_id` |
| `task_dependencies` | — | Junction: task blocks another |
| `task_relations` | — | Junction: typed semantic relations |
| `sessions` | — | Self-referential chain: `previous_session_id` / `next_session_id` |
| `task_work_history` | 0 | Tracks which task a session is/was working on |
| `lifecycle_pipelines` | — | One pipeline per epic/task lifecycle run |
| `lifecycle_stages` | — | RCASD-IVTR+C stages within a pipeline |
| `lifecycle_gate_results` | — | Pass/fail gate checks per stage |
| `lifecycle_evidence` | — | File/URL/manifest evidence per stage |
| `lifecycle_transitions` | 0 | Stage-to-stage transition audit |
| `manifest_entries` | — | RCASD provenance records |
| `pipeline_manifest` | — | Agent output content store (T5581) |
| `release_manifests` | 1 | Versioned release records |
| `architecture_decisions` | — | ADR records; self-referential |
| `adr_task_links` | 0 | ADR-to-task junction |
| `adr_relations` | — | ADR cross-reference junction |
| `external_task_links` | — | Provider bridge (Linear, Jira, GitHub) |
| `agent_instances` | 0 | Runtime agent process registry |
| `agent_error_log` | 0 | Agent error history |
| `warp_chains` | — | WarpChain definitions |
| `warp_chain_instances` | 0 | Runtime chain executions per epic |
| `audit_log` | 319 | Append-only operation log |
| `token_usage` | 222 | Provider-aware token telemetry |
| `status_registry` | — | Canonical status enum registry (ADR-018) |
| `schema_meta` | — | Schema version key-value store |

**Total tables**: 25

---

## Foreign Key Summary

### Hard FKs (enforced by Drizzle schema)

| Column | References | On Delete |
|--------|-----------|-----------|
| `tasks.parent_id` | `tasks.id` | SET NULL |
| `tasks.session_id` | `sessions.id` | SET NULL |
| `sessions.current_task` | `tasks.id` | SET NULL |
| `sessions.previous_session_id` | `sessions.id` | SET NULL |
| `sessions.next_session_id` | `sessions.id` | SET NULL |
| `task_dependencies.task_id` | `tasks.id` | CASCADE |
| `task_dependencies.depends_on` | `tasks.id` | CASCADE |
| `task_relations.task_id` | `tasks.id` | CASCADE |
| `task_relations.related_to` | `tasks.id` | CASCADE |
| `task_work_history.session_id` | `sessions.id` | CASCADE |
| `task_work_history.task_id` | `tasks.id` | CASCADE |
| `lifecycle_pipelines.task_id` | `tasks.id` | CASCADE |
| `lifecycle_stages.pipeline_id` | `lifecycle_pipelines.id` | CASCADE |
| `lifecycle_gate_results.stage_id` | `lifecycle_stages.id` | CASCADE |
| `lifecycle_evidence.stage_id` | `lifecycle_stages.id` | CASCADE |
| `lifecycle_transitions.pipeline_id` | `lifecycle_pipelines.id` | CASCADE |
| `lifecycle_transitions.from_stage_id` | `lifecycle_stages.id` | CASCADE |
| `lifecycle_transitions.to_stage_id` | `lifecycle_stages.id` | CASCADE |
| `manifest_entries.pipeline_id` | `lifecycle_pipelines.id` | CASCADE |
| `manifest_entries.stage_id` | `lifecycle_stages.id` | CASCADE |
| `pipeline_manifest.session_id` | `sessions.id` | SET NULL |
| `pipeline_manifest.task_id` | `tasks.id` | SET NULL |
| `pipeline_manifest.epic_id` | `tasks.id` | SET NULL |
| `release_manifests.pipeline_id` | `lifecycle_pipelines.id` | SET NULL |
| `release_manifests.epic_id` | `tasks.id` | SET NULL |
| `architecture_decisions.supersedes_id` | `architecture_decisions.id` | SET NULL |
| `architecture_decisions.superseded_by_id` | `architecture_decisions.id` | SET NULL |
| `architecture_decisions.amends_id` | `architecture_decisions.id` | SET NULL |
| `architecture_decisions.consensus_manifest_id` | `manifest_entries.id` | SET NULL |
| `adr_task_links.adr_id` | `architecture_decisions.id` | CASCADE |
| `adr_task_links.task_id` | `tasks.id` | CASCADE |
| `adr_relations.from_adr_id` | `architecture_decisions.id` | CASCADE |
| `adr_relations.to_adr_id` | `architecture_decisions.id` | CASCADE |
| `external_task_links.task_id` | `tasks.id` | CASCADE |
| `token_usage.session_id` | `sessions.id` | SET NULL |
| `token_usage.task_id` | `tasks.id` | SET NULL |
| `warp_chain_instances.chain_id` | `warp_chains.id` | CASCADE |

### Soft FKs (application-enforced, no DB constraint)

| Column | References | Reason | Audit ID |
|--------|-----------|--------|----------|
| `audit_log.task_id` | `tasks.id` | Intentional: log survives task deletion; `'system'` sentinel | SFK-019 |
| `agent_instances.session_id` | `sessions.id` | Circular dep in schema; migration adds constraint | SFK-014 |
| `agent_instances.task_id` | `tasks.id` | Same as above | SFK-015 |
| `agent_instances.parent_agent_id` | `agent_instances.id` | Self-ref | SFK-016 |
| `agent_error_log.agent_id` | `agent_instances.id` | Managed by migration | SFK-017 |
| `warp_chain_instances.epic_id` | `tasks.id` | Soft by design; migration target | SFK-007 |
| `pipeline_manifest.brain_obs_id` | `brain_observations.id` (brain.db) | Cross-DB — cannot be native FK | SFK-005 |

> **Note**: `PRAGMA foreign_keys` is currently OFF on this database. Even declared FKs are unenforced at runtime. See T030 remediation plan.
